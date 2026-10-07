/**
 * @module as-graph/tests/unit/graph/dagster/DagsterGraphEventBridge.test
 * @summary Unit tests for the read-only Dagster event bridge.
 * @description Proves the documented Dagster → engine-agnostic event mapping
 * table driven by an inspected job's op-name → node-id map (never a translated
 * artifact), the loud-fail rule for unmapped step events, and the ignore rule for
 * unmapped run/engine telemetry.
 */
import type { GraphExecutionEvent } from "../../../../src/shared/graph";
import { GraphExecutionEventType } from "../../../../src/shared/graph";
import type { GraphExecutionEventSink } from "../../../../src/engine/execution/GraphExecutionBackend";
import { DagsterGraphEventBridge } from "../../../../src/dagster/DagsterGraphEventBridge";
import { FakeDagsterClient } from "./dagster-fixtures";

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

/** The op-name → canonical node-id map the read-only driver derives from a job. */
const NODE_IDS_BY_OP_NAME: Record<string, string> = {
  adder: "adder",
  multiplier: "multiplier",
};

describe("DagsterGraphEventBridge (read-only)", () => {
  it("maps the documented Dagster events onto graph events", async () => {
    const client = new FakeDagsterClient(
      [
        { type: "STEP_START", stepKey: "adder" },
        { type: "STEP_OUTPUT", stepKey: "adder", payload: { outputs: { sum: 2 } } },
        { type: "STEP_SUCCESS", stepKey: "adder" },
        { type: "STEP_START", stepKey: "multiplier" },
        { type: "STEP_FAILURE", stepKey: "multiplier", message: "boom" },
      ],
      {
        runId: "run-1",
        status: "failure",
        outputs: { result: 2 },
        error: { message: "boom" },
      }
    );
    const sink = new RecordingSink();
    const bridge = new DagsterGraphEventBridge({
      dagsterRunId: "run-1",
      graphRunId: "graph-run-1",
      workflowId: "dagster-wf",
      nodeIdsByOpName: NODE_IDS_BY_OP_NAME,
      sink,
      client,
    });

    await bridge.start();
    const terminal = await bridge.waitForTerminal();
    await bridge.stop();

    expect(terminal.status).toBe("failure");
    expect(sink.emitted.map((event) => event.type)).toEqual([
      GraphExecutionEventType.NODE_STARTED,
      GraphExecutionEventType.NODE_OUTPUT,
      GraphExecutionEventType.NODE_COMPLETED,
      GraphExecutionEventType.NODE_STARTED,
      GraphExecutionEventType.NODE_FAILED,
      GraphExecutionEventType.WORKFLOW_FAILED,
    ]);
    for (const event of sink.emitted) {
      expect(event.runId).toBe("graph-run-1");
    }
    const results = bridge.collectedNodeResults();
    expect(results["adder"].status).toBe("succeeded");
    expect(results["multiplier"].status).toBe("failed");
    expect(results["multiplier"].error?.details).toBeUndefined();
  });

  it("emits a run-level RUN_START as WORKFLOW_STARTED without a node id", async () => {
    const client = new FakeDagsterClient(
      [{ type: "RUN_START" }, { type: "STEP_SUCCESS", stepKey: "adder" }],
      { runId: "run-1", status: "success", outputs: {} }
    );
    const sink = new RecordingSink();
    const bridge = new DagsterGraphEventBridge({
      dagsterRunId: "run-1",
      graphRunId: "graph-run-1",
      workflowId: "dagster-wf",
      nodeIdsByOpName: NODE_IDS_BY_OP_NAME,
      sink,
      client,
    });

    await bridge.start();
    await bridge.waitForTerminal();
    await bridge.stop();

    const started = sink.emitted.find(
      (event) => event.type === GraphExecutionEventType.WORKFLOW_STARTED
    );
    expect(started).toBeDefined();
    expect(started?.nodeId).toBeUndefined();
    expect(sink.emitted[0]).toMatchObject({
      type: GraphExecutionEventType.WORKFLOW_STARTED,
      runId: "graph-run-1",
      workflowId: "dagster-wf",
    });
  });

  it("resolves a namespaced step key through the op-name tail", async () => {
    const client = new FakeDagsterClient(
      [{ type: "STEP_SUCCESS", stepKey: "dagsterwf_job.adder" }],
      { runId: "run-1", status: "success", outputs: {} }
    );
    const bridge = new DagsterGraphEventBridge({
      dagsterRunId: "run-1",
      graphRunId: "graph-run-1",
      workflowId: "dagster-wf",
      nodeIdsByOpName: NODE_IDS_BY_OP_NAME,
      sink: new RecordingSink(),
      client,
    });

    await bridge.start();
    await bridge.waitForTerminal();
    await bridge.stop();

    expect(Object.keys(bridge.collectedNodeResults())).toEqual(["adder"]);
  });

  it("fails loudly on an unmapped step-level event", async () => {
    const client = new FakeDagsterClient(
      [{ type: "STEP_TELEMETRY", stepKey: "adder" }],
      { runId: "run-1", status: "success", outputs: {} }
    );
    const bridge = new DagsterGraphEventBridge({
      dagsterRunId: "run-1",
      graphRunId: "graph-run-1",
      workflowId: "dagster-wf",
      nodeIdsByOpName: NODE_IDS_BY_OP_NAME,
      sink: new RecordingSink(),
      client,
    });

    await expect(
      (async () => {
        await bridge.start();
        await bridge.stop();
      })()
    ).rejects.toMatchObject({
      graphCode: "GRAPH_DAGSTER_EVENT_UNSUPPORTED",
    });
  });

  it("ignores unmapped run/engine-level telemetry", async () => {
    const client = new FakeDagsterClient(
      [{ type: "ENGINE_EVENT" }, { type: "LOGS_CAPTURED" }],
      { runId: "run-1", status: "success", outputs: { result: 2 } }
    );
    const sink = new RecordingSink();
    const bridge = new DagsterGraphEventBridge({
      dagsterRunId: "run-1",
      graphRunId: "graph-run-1",
      workflowId: "dagster-wf",
      nodeIdsByOpName: NODE_IDS_BY_OP_NAME,
      sink,
      client,
    });

    await bridge.start();
    await bridge.waitForTerminal();
    await bridge.stop();

    expect(sink.emitted).toHaveLength(1);
    expect(sink.emitted[0].type).toBe(
      GraphExecutionEventType.WORKFLOW_COMPLETED
    );
  });
});
