/**
 * @module as-graph/tests/integration/mastra/MastraExecuteTerminalStatus
 * @summary SAA-858/SAA-859 regression: `MastraGraphExecutionBackend.execute()`
 * must return `FAILED` when the translated run terminates with
 * `node.failed`/`workflow.failed`, not assume `SUCCEEDED` from the bare fact
 * that the awaited run resolved.
 * @description Drives a step designed to fail closed through the real
 * `execute()` seam (the production host wiring plus `createMastraDefaultStepHandlers`)
 * and asserts the returned status matches the terminal workflow event the same
 * call emitted: `FAILED` + `WORKFLOW_FAILED`, never `WORKFLOW_COMPLETED`.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph/constants";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { createMastraDefaultStepHandlers } from "../../../src/mastra/MastraDefaultStepHandlers";
import type { MastraBackendConfig } from "../../../src/mastra/types";
import type { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { document, node } from "../../../src/workflows/builders";
import { frameSinkHarness } from "./helpers";

/** Boots the production mastra host over the supplied backend config. */
async function bootHost(config: MastraBackendConfig) {
  return createGraphBackendHost({ variant: "mastra", mastra: config });
}

/**
 * A canonical single-node document over `core.utility.code`. The default
 * handler set deliberately does not execute code-mode nodes, so this step fails
 * closed at run time (`GRAPH_MASTRA_UNSUPPORTED_KIND`) and the run terminates
 * with `workflow.failed` — the exact shape the SAA-858 false-success bug hid.
 */
function failClosedCodeDocument() {
  return document({
    id: "mastra-it-terminal-code-fail-closed",
    name: "mastra-it-terminal-code-fail-closed",
    nodes: [node("code", "core.utility.code")],
  });
}

describe("MastraGraphExecutionBackend.execute — terminal status honesty (SAA-858/SAA-859)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("returns FAILED and emits a terminal WORKFLOW_FAILED when a step fails closed", async () => {
    const host = await bootHost({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const backend = host.backend as MastraGraphExecutionBackend;
    const harness = frameSinkHarness("saa-859-code-fail-closed");

    const result = await backend.execute({
      document: failClosedCodeDocument(),
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.FAILED);
    const types = harness.events.map((event) => event.type);
    expect(types).toContain(GraphExecutionEventType.NODE_FAILED);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_FAILED);
    expect(types).not.toContain(GraphExecutionEventType.WORKFLOW_COMPLETED);
  });

  it("returns FAILED for a core.agent node with no runtime (the other fail-closed path)", async () => {
    const host = await bootHost({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const backend = host.backend as MastraGraphExecutionBackend;
    const harness = frameSinkHarness("saa-859-agent-unavailable");

    const result = await backend.execute({
      document: document({
        id: "mastra-it-terminal-agent-fail-closed",
        name: "mastra-it-terminal-agent-fail-closed",
        nodes: [node("agent", "core.agent")],
      }),
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.FAILED);
    const types = harness.events.map((event) => event.type);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_FAILED);
    expect(types).not.toContain(GraphExecutionEventType.WORKFLOW_COMPLETED);
  }, 15_000);
});
