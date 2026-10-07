/**
 * @module as-graph/tests/unit/graph/dagster/DagsterObserveRunBounds.test
 * @summary Unit tests for the bounded `observeRun` behaviour (SAA-318 C1).
 * @description Proves the read-only Dagster observation cannot hang or accumulate
 * without bound against a wedged or hostile gateway: the event cap fails closed with
 * `GRAPH_DAGSTER_EVENT_LIMIT_EXCEEDED`, the terminal wait fails closed with
 * `GRAPH_DAGSTER_OBSERVE_TIMEOUT`, and an abort fails closed with
 * `GRAPH_DAGSTER_OBSERVE_ABORTED` (both before and during the wait). It also
 * proves the bridge forwards the bounds to the transport port and that the backend
 * plumbs the request bounds into the bridge.
 */
import type { GraphExecutionEvent } from "../../../../src/shared/graph";
import type { GraphExecutionEventSink } from "../../../../src/engine/execution/GraphExecutionBackend";
import { DagsterGraphEventBridge } from "../../../../src/dagster/DagsterGraphEventBridge";
import { DagsterGraphExecutionBackend } from "../../../../src/dagster/DagsterGraphExecutionBackend";
import { DAGSTER_ERROR } from "../../../../src/dagster/constants";
import type {
  DagsterClient,
  DagsterEventRecord,
  DagsterJobRecord,
  DagsterJobSummary,
  DagsterRunRecord,
  DagsterRunSubscription,
  DagsterRunSubscriptionOptions,
} from "../../../../src/dagster/DagsterTypes";
import { DAGSTER_FIXTURE_JOB } from "./dagster-fixtures";

/** Records every event forwarded through the sink. */
class RecordingSink implements GraphExecutionEventSink {
  readonly emitted: Partial<GraphExecutionEvent>[] = [];

  async emit(event: Partial<GraphExecutionEvent>): Promise<void> {
    this.emitted.push(event);
  }

  async updateObservers(): Promise<void> {
    return;
  }
}

/**
 * A scripted gateway port that can deliberately never terminate: with
 * `terminal: null` it emits no run-level terminal event and `getRun` is never
 * reached, so the observation can only end through a bound. It records the
 * subscription options the bridge forwards so the plumbing can be asserted.
 */
class ScriptedDagsterClient implements DagsterClient {
  readonly subscriptionOptions: (DagsterRunSubscriptionOptions | undefined)[] =
    [];
  unsubscribed = 0;

  private readonly handlers = new Map<
    string,
    (event: DagsterEventRecord) => void
  >();

  constructor(
    private readonly events: DagsterEventRecord[] = [],
    private readonly terminal: DagsterRunRecord | null = {
      runId: "run-1",
      status: "success",
      outputs: {},
    }
  ) {}

  async listJobs(): Promise<DagsterJobSummary[]> {
    return [];
  }

  async getJob(): Promise<DagsterJobRecord> {
    return DAGSTER_FIXTURE_JOB;
  }

  async subscribeRun(
    runId: string,
    handler: (event: DagsterEventRecord) => void,
    options?: DagsterRunSubscriptionOptions
  ): Promise<DagsterRunSubscription> {
    this.subscriptionOptions.push(options);
    this.handlers.set(runId, handler);
    for (const event of this.events) {
      handler(event);
    }
    if (this.terminal) {
      handler({
        type:
          this.terminal.status === "success"
            ? "RUN_SUCCESS"
            : this.terminal.status === "canceled"
              ? "RUN_CANCELED"
              : "RUN_FAILURE",
      });
    }
    return {
      unsubscribe: () => {
        this.handlers.delete(runId);
        this.unsubscribed += 1;
      },
    };
  }

  async terminateRun(): Promise<void> {
    return;
  }

  async getRun(runId: string): Promise<DagsterRunRecord> {
    if (!this.terminal) {
      throw new Error("scripted client has no terminal record");
    }
    return { ...this.terminal, runId };
  }

  async dispose(): Promise<void> {
    return;
  }
}

/** Builds a bridge over the given client and bounds. */
function bridge(
  client: DagsterClient,
  options: {
    signal?: AbortSignal;
    maxEvents?: number;
    maxPages?: number;
    terminalTimeoutMs?: number;
  } = {}
): DagsterGraphEventBridge {
  return new DagsterGraphEventBridge({
    dagsterRunId: "run-1",
    graphRunId: "graph-run-1",
    workflowId: "dagsterwf_job",
    nodeIdsByOpName: { adder: "adder", multiplier: "multiplier" },
    sink: new RecordingSink(),
    client,
    ...options,
  });
}

const STEP_START: DagsterEventRecord = {
  type: "STEP_START",
  stepKey: "adder",
};

describe("DagsterGraphEventBridge bounds (SAA-318 C1)", () => {
  it("fails closed with EVENT_LIMIT_EXCEEDED past maxEvents without a terminal event", async () => {
    const client = new ScriptedDagsterClient(
      [STEP_START, STEP_START, STEP_START, STEP_START, STEP_START],
      null
    );
    const observed = bridge(client, { maxEvents: 3 });

    await observed.start();

    await expect(observed.waitForTerminal()).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.EVENT_LIMIT_EXCEEDED,
    });
  });

  it("allows exactly maxEvents events (terminal included) and still resolves the terminal record", async () => {
    // Two step events plus the terminal run event is exactly three processed
    // events: the cap is exclusive (`count > maxEvents`), so this boundary must
    // still succeed rather than fail closed one event early.
    const client = new ScriptedDagsterClient(
      [STEP_START, STEP_START],
      { runId: "run-1", status: "success", outputs: { result: 1 } }
    );
    const observed = bridge(client, { maxEvents: 3 });

    await observed.start();
    const terminal = await observed.waitForTerminal();
    await observed.stop();

    expect(terminal.status).toBe("success");
    expect(client.subscriptionOptions[0]?.maxEvents).toBe(3);
  });

  it("fails closed with OBSERVE_TIMEOUT when the run never terminates within terminalTimeoutMs", async () => {
    const client = new ScriptedDagsterClient([{ type: "RUN_START" }], null);
    const observed = bridge(client, { terminalTimeoutMs: 25 });

    await observed.start();

    await expect(observed.waitForTerminal()).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.OBSERVE_TIMEOUT,
    });
  });

  it("fails closed with OBSERVE_ABORTED when the signal aborts during the wait", async () => {
    const controller = new AbortController();
    const client = new ScriptedDagsterClient([{ type: "RUN_START" }], null);
    const observed = bridge(client, {
      signal: controller.signal,
      terminalTimeoutMs: 60_000,
    });

    await observed.start();
    const pending = observed.waitForTerminal();
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.OBSERVE_ABORTED,
    });
  });

  it("fails closed with OBSERVE_ABORTED when the signal is already aborted before start", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new ScriptedDagsterClient([{ type: "RUN_START" }], null);
    const observed = bridge(client, { signal: controller.signal });

    await expect(observed.start()).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.OBSERVE_ABORTED,
    });
  });

  it("forwards signal, maxEvents, and maxPages to the transport port", async () => {
    const controller = new AbortController();
    const client = new ScriptedDagsterClient([], {
      runId: "run-1",
      status: "success",
      outputs: {},
    });
    const observed = bridge(client, {
      signal: controller.signal,
      maxEvents: 7,
      maxPages: 9,
    });

    await observed.start();
    await observed.waitForTerminal();
    await observed.stop();

    expect(client.subscriptionOptions[0]?.signal).toBe(controller.signal);
    expect(client.subscriptionOptions[0]?.maxEvents).toBe(7);
    expect(client.subscriptionOptions[0]?.maxPages).toBe(9);
  });
});

describe("DagsterGraphExecutionBackend.observeRun bounds plumbing (SAA-318 C1)", () => {
  it("plumbs maxEvents into the bridge and fails closed when exceeded", async () => {
    const client = new ScriptedDagsterClient(
      [STEP_START, STEP_START, STEP_START, STEP_START],
      null
    );
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });

    await expect(
      backend.observeRun({
        dagsterRunId: "run-1",
        workflowId: DAGSTER_FIXTURE_JOB.name,
        events: new RecordingSink(),
        maxEvents: 2,
      })
    ).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.EVENT_LIMIT_EXCEEDED,
    });
    expect(client.subscriptionOptions[0]?.maxEvents).toBe(2);
  });

  it("plumbs terminalTimeoutMs and maxPages into the bridge and times out", async () => {
    const client = new ScriptedDagsterClient([{ type: "RUN_START" }], null);
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });

    await expect(
      backend.observeRun({
        dagsterRunId: "run-1",
        workflowId: DAGSTER_FIXTURE_JOB.name,
        events: new RecordingSink(),
        terminalTimeoutMs: 25,
        maxPages: 4,
      })
    ).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.OBSERVE_TIMEOUT,
    });
    expect(client.subscriptionOptions[0]?.maxPages).toBe(4);
  });

  it("plumbs the abort signal into the bridge and aborts the observation", async () => {
    const controller = new AbortController();
    const client = new ScriptedDagsterClient([{ type: "RUN_START" }], null);
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });

    const pending = backend.observeRun({
      dagsterRunId: "run-1",
      workflowId: DAGSTER_FIXTURE_JOB.name,
      events: new RecordingSink(),
      signal: controller.signal,
      terminalTimeoutMs: 60_000,
    });
    // Let `getJob` and the subscription settle before aborting, so this asserts
    // the backend actually plumbs the signal into the bridge rather than only
    // failing because the signal was already aborted at `start`.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      graphCode: DAGSTER_ERROR.OBSERVE_ABORTED,
    });
    expect(client.subscriptionOptions[0]?.signal).toBe(controller.signal);
  });
});
