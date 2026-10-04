/**
 * @module as-graph/tests/unit/graph/dagster/DagsterGraphExecutionBackend.test
 * @summary Unit tests for the Dagster execution backend (SAA-195).
 * @description Proves the backend contract: non-local/unsupported-code-mode
 * declaration, registration, the C3 "no evaluator" rule, end-to-end execution
 * against a scripted client port, cancellation/release/dispose, and the workflow
 * listing/lookup capability (Deliverable 4 addendum).
 */
import { GraphExecutionStatus } from "../../../../src/shared/graph";
import { GraphExecutionEventType } from "../../../../src/shared/graph";
import type { GraphExecutionEvent } from "../../../../src/shared/graph";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";
import type { GraphExecutionEventSink } from "../../../../src/engine/execution/GraphExecutionBackend";
import type { GraphBackendExecutionRequest } from "../../../../src/engine/execution/GraphExecutionBackend";
import type { GraphExecutionPlan } from "../../../../src/engine/planning/GraphExecutionPlan";
import { DagsterGraphExecutionBackend } from "../../../../src/dagster/DagsterGraphExecutionBackend";
import { DAGSTER_BACKEND_FLAVOUR } from "../../../../src/dagster/constants";
import type { DagsterJobSummary } from "../../../../src/dagster/DagsterTypes";
import { documentEdge, documentNode } from "../engine-fixtures";
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

/** Builds a minimal execution request for the given sink. */
function request(
  sink: GraphExecutionEventSink,
  runId = "graph-run-1"
): GraphBackendExecutionRequest {
  return {
    document: {
      id: "dagsterwf",
      name: "dagsterwf",
      inputs: [],
      outputs: [],
      nodes: [
        documentNode("adder", "core.flow.log"),
        documentNode("multiplier", "core.utility.map"),
      ],
      edges: [
        documentEdge("e1", ["node", "adder", "result"], [
          "node",
          "multiplier",
          "value",
        ]),
      ],
    },
    plan: {} as GraphExecutionPlan,
    inputs: { a: 1 },
    options: { runId },
    events: sink,
  };
}

describe("DagsterGraphExecutionBackend", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("declares itself non-local with unsupported code mode", () => {
    const backend = new DagsterGraphExecutionBackend();
    expect(backend.local).toBe(false);
    expect(backend.codeMode).toBe("unsupported");
    expect(GraphExecutionBackendRegistry.get(DAGSTER_BACKEND_FLAVOUR)).toBe(
      backend
    );
  });

  it("never reads or configures a code sandbox evaluator (SAA-193 C3)", async () => {
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({
      client: new FakeDagsterClient(),
      codeSandboxEvaluator: { evaluate: () => true },
    } as never);
    expect(
      (backend as unknown as Record<string, unknown>)["codeSandboxEvaluator"]
    ).toBeUndefined();
    expect(backend.capabilities.codeMode).toBe("unsupported");
  });

  it("executes a translated run through the client port", async () => {
    const client = new FakeDagsterClient(
      [
        { type: "STEP_START", stepKey: "adder" },
        { type: "STEP_SUCCESS", stepKey: "adder" },
        { type: "STEP_START", stepKey: "multiplier" },
        { type: "STEP_SUCCESS", stepKey: "multiplier" },
      ],
      {
        runId: "run-1",
        status: "success",
        outputs: { result: 2 },
      }
    );
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });
    const sink = new RecordingSink();

    const result = await backend.execute(request(sink));

    expect(client.launched).toHaveLength(1);
    expect(client.launched[0].jobName).toBe("dagsterwf_job");
    expect(client.launched[0].runConfig.ops["adder"]).toBeDefined();
    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(result.outputs).toEqual({ result: 2 });
    expect(Object.keys(result.nodeResults).sort()).toEqual([
      "adder",
      "multiplier",
    ]);
    expect(
      sink.emitted.some(
        (event) => event.type === GraphExecutionEventType.WORKFLOW_COMPLETED
      )
    ).toBe(true);
  });

  it("cancels, releases, and disposes through the client port", async () => {
    const client = new FakeDagsterClient();
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });

    await expect(backend.cancel("graph-run-1", "stop")).resolves.toBe(true);
    expect(client.terminated).toEqual([
      { runId: "graph-run-1", reason: "stop" },
    ]);
    await expect(backend.release("graph-run-1")).resolves.toBeUndefined();
    await backend.dispose();
    expect(client.disposed).toBe(true);
  });

  it("reports not_supported and fails loudly without a client catalogue", async () => {
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client: new FakeDagsterClient() });

    expect(backend.capabilities).toEqual({
      codeMode: "unsupported",
      workflows: { list: "not_supported", get: "not_supported" },
    });
    await expect(backend.listWorkflows()).rejects.toMatchObject({
      graphCode: "GRAPH_DAGSTER_WORKFLOWS_NOT_SUPPORTED",
    });
    await expect(backend.getWorkflow("dagster-wf")).rejects.toMatchObject({
      graphCode: "GRAPH_DAGSTER_WORKFLOWS_NOT_SUPPORTED",
    });
  });

  it("lists and looks up deployed jobs when the client exposes them", async () => {
    const jobs: DagsterJobSummary[] = [
      { name: "dagster-wf_job", description: "demo" },
    ];
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client: new FakeDagsterClient([], undefined, jobs) });

    expect(backend.capabilities).toEqual({
      codeMode: "unsupported",
      workflows: { list: "supported", get: "supported" },
    });
    const summaries = await backend.listWorkflows();
    expect(summaries).toEqual([
      { id: "dagster-wf_job", name: "dagster-wf_job" },
    ]);
    const document = await backend.getWorkflow("dagster-wf_job");
    expect(document.id).toBe("dagster-wf_job");
  });

  it("fails loudly when no client is configured", async () => {
    const backend = new DagsterGraphExecutionBackend();
    await expect(
      backend.execute(request(new RecordingSink()))
    ).rejects.toMatchObject({
      graphCode: "GRAPH_DAGSTER_CLIENT_NOT_CONFIGURED",
    });
  });
});
