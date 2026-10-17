/**
 * @module as-graph/tests/integration/mastra/MastraAgentFamilyRun
 * @summary SAA-836 M3 integration: a document built from mastra AI-family nodes
 * compiles to real `@mastra/core` steps and executes end to end through the real
 * `MastraGraphExecutionBackend`, resolving each family node's configuration into
 * a `resource` descriptor that routes along the graph edge.
 * @description Real: the production `MastraGraphExecutionBackend`, the production
 * `MastraWorkflowCompiler` + `createMastraDefaultStepHandlers` (real
 * `createStep`), and a real mastra run. Host-injected: the frame-bound event sink
 * (the engine normally creates it). This is the family-node counterpart to
 * `MastraDefaultStepHandlersHost`.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph/constants";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { createMastraDefaultStepHandlers } from "../../../src/mastra/MastraDefaultStepHandlers";
import type { MastraBackendConfig } from "../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { document, edge, node } from "../../../src/workflows/builders";
import { frameSinkHarness, type FrameSinkHarness } from "./helpers";

/** Boots the mastra host over the supplied backend config. */
async function bootHost(config: MastraBackendConfig) {
  return createGraphBackendHost({ variant: "mastra", mastra: config });
}

/** A family document: `tool -> hook` through the tool `resource` output. */
function familyDocument(): GraphWorkflowDocument {
  return document({
    id: "mastra-agent-family-run",
    name: "mastra-agent-family-run",
    nodes: [
      node("tool", "core.agent.tool", { toolId: "weather" }),
      node("hook", "core.agent.hook", { phase: "before" }),
    ],
    edges: [
      edge("e1", ["node", "tool", "resource"], ["node", "hook", "value"]),
    ],
  });
}

/** Finds the recorded `node.completed` payload for a node id. */
function completedOutputs(
  harness: FrameSinkHarness,
  nodeId: string
): Record<string, unknown> | undefined {
  return harness.events.find(
    (event) =>
      event.type === GraphExecutionEventType.NODE_COMPLETED &&
      event.nodeId === nodeId
  )?.payload as Record<string, unknown> | undefined;
}

describe("Mastra AI-family nodes — real backend run (SAA-836 M3)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("executes a tool→hook family document to succeeded with routed resources", async () => {
    const host = await bootHost({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const backend = host.backend!;
    const harness = frameSinkHarness("saa-836-family-run");

    const result = await backend.execute({
      document: familyDocument(),
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);

    // The tool family step resolved its configuration into a resource descriptor.
    expect(completedOutputs(harness, "tool")).toEqual({
      outputs: {
        resource: {
          kind: "core.agent.tool",
          nodeId: "tool",
          parameters: { toolId: "weather" },
        },
      },
    });

    // The tool resource was routed along the `resource -> value` edge.
    const routed = harness.events.find(
      (event) => event.type === GraphExecutionEventType.EDGE_VALUE_ROUTED
    );
    expect(routed?.edgeId).toBe("e1");
    expect((routed?.payload as { value?: unknown })?.value).toEqual({
      kind: "core.agent.tool",
      nodeId: "tool",
      parameters: { toolId: "weather" },
    });

    // The hook family step executed as a real mastra step too.
    expect(completedOutputs(harness, "hook")).toEqual({
      outputs: {
        resource: {
          kind: "core.agent.hook",
          nodeId: "hook",
          parameters: { phase: "before" },
        },
      },
    });

    expect(
      harness.events.some(
        (event) => event.type === GraphExecutionEventType.WORKFLOW_COMPLETED
      )
    ).toBe(true);
  });
});
