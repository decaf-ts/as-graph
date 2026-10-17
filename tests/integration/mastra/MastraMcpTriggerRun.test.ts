/**
 * @module as-graph/tests/integration/mastra/MastraMcpTriggerRun
 * @summary SAA-836 M5 integration: the `core.agent.trigger.mcp` step resolves
 * its MCP server descriptor and serves through the host `createMcpServer`
 * factory, and fails closed with `GRAPH_MASTRA_MCP_UNAVAILABLE` without one.
 * @description Real: the production `MastraGraphExecutionBackend`, the
 * production MCP trigger handler, and a real mastra run. Host-injected: the
 * `createMcpServer` factory (the declared R2 extension point — `@mastra/mcp`
 * is not vendored), returning a recording fake server surface.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph/constants";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { createMastraDefaultStepHandlers } from "../../../src/mastra/MastraDefaultStepHandlers";
import type { MastraBackendConfig, MastraMcpServerDescriptor } from "../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { document, node } from "../../../src/workflows/builders";
import { frameSinkHarness, type FrameSinkHarness } from "./helpers";

/** The MCP Server Trigger document under test. */
function mcpTriggerDocument(id: string): GraphWorkflowDocument {
  return document({
    id,
    name: id,
    nodes: [
      node("mcp", "core.agent.trigger.mcp", {
        serverId: "as-graph-gateway",
        title: "As-Graph MCP Gateway",
        instructions: "Serve the enclosing workflow over MCP",
        transport: "http",
      }),
    ],
  });
}

/** Boots the mastra host over the supplied backend config. */
async function bootHost(config: MastraBackendConfig) {
  return createGraphBackendHost({ variant: "mastra", mastra: config });
}

/** Finds the recorded `node.completed` outputs for a node id. */
function completedOutputs(
  harness: FrameSinkHarness,
  nodeId: string
): Record<string, unknown> | undefined {
  const payload = harness.events.find(
    (event) =>
      event.type === GraphExecutionEventType.NODE_COMPLETED &&
      event.nodeId === nodeId
  )?.payload as { outputs?: Record<string, unknown> } | undefined;
  return payload?.outputs;
}

/** Finds the recorded `node.failed` error payload for a node id. */
function failedError(
  harness: FrameSinkHarness,
  nodeId: string
): { name?: string; message?: string; code?: string } | undefined {
  return harness.events.find(
    (event) =>
      event.type === GraphExecutionEventType.NODE_FAILED &&
      event.nodeId === nodeId
  )?.error as { name?: string; message?: string; code?: string } | undefined;
}

describe("mastra MCP trigger driver run (SAA-836 M5)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("resolves the descriptor and serves through the host factory", async () => {
    const servers: unknown[] = [];
    const received: MastraMcpServerDescriptor[] = [];
    const serverSurface = { kind: "fake-mcp-server", tools: [] };
    const host = await bootHost({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
      createMcpServer: (descriptor) => {
        received.push(descriptor);
        const server = { ...serverSurface, id: `srv-${received.length}` };
        servers.push(server);
        return server;
      },
    });
    const backend = host.backend!;
    const harness = frameSinkHarness("saa-836-mcp-trigger-serves");

    const result = await backend.execute({
      document: mcpTriggerDocument("saa-836-mcp-trigger-serves"),
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    // The trigger resolved its R9 descriptor for the host factory.
    expect(received).toEqual([
      {
        serverId: "as-graph-gateway",
        title: "As-Graph MCP Gateway",
        instructions: "Serve the enclosing workflow over MCP",
        transport: "http",
        nodeId: "mcp",
      },
    ]);
    // The host server surface is the step's `resource` output.
    expect(completedOutputs(harness, "mcp")).toEqual({
      resource: servers[0],
    });
    expect(
      harness.events.some(
        (event) => event.type === GraphExecutionEventType.WORKFLOW_COMPLETED
      )
    ).toBe(true);
  });

  it("fails closed with GRAPH_MASTRA_MCP_UNAVAILABLE without a host factory", async () => {
    const host = await bootHost({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const backend = host.backend!;
    const harness = frameSinkHarness("saa-836-mcp-trigger-fail-closed");

    const result = await backend.execute({
      document: mcpTriggerDocument("saa-836-mcp-trigger-fail-closed"),
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.FAILED);
    expect(failedError(harness, "mcp")?.code).toBe(
      "GRAPH_MASTRA_MCP_UNAVAILABLE"
    );
    const types = harness.events.map((event) => event.type);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_FAILED);
    expect(types).not.toContain(GraphExecutionEventType.WORKFLOW_COMPLETED);
  }, 15_000);

  it("fails closed when the host factory yields no server", async () => {
    const host = await bootHost({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
      createMcpServer: () => undefined,
    });
    const backend = host.backend!;
    const harness = frameSinkHarness("saa-836-mcp-trigger-empty-factory");

    const result = await backend.execute({
      document: mcpTriggerDocument("saa-836-mcp-trigger-empty-factory"),
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: harness.sink,
    });

    expect(result.status).toBe(GraphExecutionStatus.FAILED);
    expect(failedError(harness, "mcp")?.code).toBe(
      "GRAPH_MASTRA_MCP_UNAVAILABLE"
    );
  }, 15_000);
});
