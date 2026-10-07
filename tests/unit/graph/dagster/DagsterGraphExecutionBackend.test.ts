/**
 * @module as-graph/tests/unit/graph/dagster/DagsterGraphExecutionBackend.test
 * @summary Unit tests for the read-only Dagster backend.
 * @description Proves the read-only owner mandate: non-local/unsupported-code-mode
 * declaration, registration, the "no evaluator" rule, loud `NOT_SUPPORTED` on
 * authoring, real listing/lookup of already-deployed jobs mapped into the
 * canonical document shape, observing an EXISTING run, cancellation/release/dispose,
 * and declarative-input compatibility on the read side.
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
import { GraphWorkflowDocumentBuilder } from "../../../../src/shared/graph";
import { documentNode } from "../engine-fixtures";
import {
  DAGSTER_FIXTURE_JOB,
  FakeDagsterClient,
} from "./dagster-fixtures";

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
      edges: [],
    },
    plan: {} as GraphExecutionPlan,
    inputs: { a: 1 },
    options: { runId },
    events: sink,
  };
}

describe("DagsterGraphExecutionBackend (read-only)", () => {
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

  it("never reads or configures a code sandbox evaluator", async () => {
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

  it("throws NOT_SUPPORTED on authoring and exposes no launch path", async () => {
    const client = new FakeDagsterClient();
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });

    await expect(backend.execute(request(new RecordingSink()))).rejects.toMatchObject(
      {
        graphCode: "GRAPH_DAGSTER_AUTHORING_NOT_SUPPORTED",
      }
    );
    expect(
      (client as unknown as { launchRun?: unknown }).launchRun
    ).toBeUndefined();
  });

  it("throws NOT_SUPPORTED on authoring even without a client", async () => {
    const backend = new DagsterGraphExecutionBackend();
    await expect(
      backend.execute(request(new RecordingSink()))
    ).rejects.toMatchObject({
      graphCode: "GRAPH_DAGSTER_AUTHORING_NOT_SUPPORTED",
    });
  });

  it("lists deployed jobs as real summaries", async () => {
    const client = new FakeDagsterClient([], undefined, [
      { name: "dagsterwf_job", description: "fixture job" },
    ]);
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });

    expect(backend.capabilities).toEqual({
      codeMode: "unsupported",
      workflows: { list: "supported", get: "supported" },
    });
    await expect(backend.listWorkflows()).resolves.toEqual([
      { id: "dagsterwf_job", name: "dagsterwf_job" },
    ]);
  });

  it("maps the real deployment structure into the canonical document", async () => {
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client: new FakeDagsterClient() });

    const document = await backend.getWorkflow(DAGSTER_FIXTURE_JOB.name);

    expect(document.id).toBe("dagsterwf_job");
    expect(document.name).toBe("dagsterwf_job");
    expect(document.nodes.map((node) => node.id)).toEqual([
      "adder",
      "multiplier",
    ]);
    expect(document.nodes.map((node) => node.kind)).toEqual([
      "core.flow.log",
      "core.utility.map",
    ]);
    expect(document.edges).toHaveLength(1);
    expect(document.edges[0].source).toEqual({
      scope: "node",
      nodeId: "adder",
      port: "result",
    });
    expect(document.edges[0].target).toEqual({
      scope: "node",
      nodeId: "multiplier",
      port: "value",
    });
    expect(document.metadata?.["assetKeys"]).toEqual(["asset_a", "asset_b"]);
    expect(document.metadata?.["schedules"]).toEqual([
      { name: "hourly", cron: "0 * * * *", timezone: "UTC" },
    ]);
    expect(document.metadata?.["sensors"]).toEqual([
      { name: "hook", kind: "core.trigger.webhook" },
    ]);
    // No Python source is embedded anywhere in the inspected document.
    expect(JSON.stringify(document)).not.toContain("dagster.");
    expect(JSON.stringify(document)).not.toMatch(/\bdef\s+\w+\(/);
  });

  it("stays compatible with a declarative document on the read side", async () => {
    const declarative = new GraphWorkflowDocumentBuilder(
      "dagsterwf_job",
      "dagsterwf_job"
    )
      .addNode(documentNode("adder", "core.flow.log"))
      .build();
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client: new FakeDagsterClient() });

    const document = await backend.getWorkflow(declarative.id);

    expect(document.id).toBe(declarative.id);
    expect(document.nodes.map((node) => node.id)).toEqual(["adder", "multiplier"]);
  });

  it("observes an EXISTING run and maps its events and terminal result", async () => {
    const client = new FakeDagsterClient(
      [
        { type: "STEP_START", stepKey: "adder" },
        { type: "STEP_SUCCESS", stepKey: "adder" },
        { type: "STEP_START", stepKey: "multiplier" },
        { type: "STEP_SUCCESS", stepKey: "multiplier" },
      ],
      { runId: "run-1", status: "success", outputs: { result: 2 } }
    );
    const backend = new DagsterGraphExecutionBackend();
    await backend.initialize({ client });
    const sink = new RecordingSink();

    const result = await backend.observeRun({
      dagsterRunId: "run-1",
      workflowId: DAGSTER_FIXTURE_JOB.name,
      events: sink,
    });

    expect(client.subscribed).toEqual(["run-1"]);
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

    await expect(backend.cancel("run-1", "stop")).resolves.toBe(true);
    expect(client.terminated).toEqual([{ runId: "run-1", reason: "stop" }]);
    await expect(backend.release("run-1")).resolves.toBeUndefined();
    await backend.dispose();
    expect(client.disposed).toBe(true);
  });

  it("fails loudly when no client is configured", async () => {
    const backend = new DagsterGraphExecutionBackend();
    await expect(backend.listWorkflows()).rejects.toMatchObject({
      graphCode: "GRAPH_DAGSTER_CLIENT_NOT_CONFIGURED",
    });
    await expect(backend.getWorkflow("dagsterwf_job")).rejects.toMatchObject({
      graphCode: "GRAPH_DAGSTER_CLIENT_NOT_CONFIGURED",
    });
  });
});
