/**
 * @module as-graph/tests/unit/graph/dagster/DagsterGraphEventBridge.test
 * @summary Unit tests for the Dagster event bridge (SAA-195 §4.3).
 * @description Proves the documented Dagster → engine-agnostic event mapping
 * table, the loud-fail rule for unmapped step events, and the ignore rule for
 * unmapped run/engine telemetry.
 */
import type { GraphExecutionEvent } from "../../../../src/shared/graph";
import { GraphExecutionEventType } from "../../../../src/shared/graph";
import type { GraphExecutionEventSink } from "../../../../src/engine/execution/GraphExecutionBackend";
import { DagsterGraphEventBridge } from "../../../../src/dagster/DagsterGraphEventBridge";
import { DagsterWorkflowTranslator } from "../../../../src/dagster/DagsterWorkflowTranslator";
import type { DagsterJobArtifact } from "../../../../src/dagster/DagsterTypes";
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

/** Builds a two-node artifact with `adder` and `multiplier` op names. */
function artifact(): DagsterJobArtifact {
  const translator = new DagsterWorkflowTranslator();
  return translator.translate({
    id: "dagster-wf",
    name: "dagster-wf",
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
  });
}

describe("DagsterGraphEventBridge", () => {
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
      artifact: artifact(),
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

  it("fails loudly on an unmapped step-level event", async () => {
    const client = new FakeDagsterClient(
      [{ type: "STEP_TELEMETRY", stepKey: "adder" }],
      { runId: "run-1", status: "success", outputs: {} }
    );
    const bridge = new DagsterGraphEventBridge({
      dagsterRunId: "run-1",
      graphRunId: "graph-run-1",
      workflowId: "dagster-wf",
      artifact: artifact(),
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
      artifact: artifact(),
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
