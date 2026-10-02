/**
 * @module as-graph/tests/unit/graph/GraphRunLogger.test
 * @summary Unit tests for the run logger + Log node executor (DECAF-48).
 * @description Uses the DECAF-50 §4.9 execution context shape (canonical
 * document + node instance + effective manifest).
 */
import { GraphRunLogger } from "../../../src/log/GraphRunLogger";
import { GraphExecutionContext } from "../../../src/engine/execution/GraphExecutionContext";
import { UtilityLogNode } from "../../../src/node";
import { GraphExecutionEventType } from "../../../src/shared/graph";
import type {
  GraphNodeInstance,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";
import type { GraphResolvedNodeManifest } from "../../../src/shared/graph";
import { nodeExecutionRequest, nodeExecutor } from "./engine-fixtures";

function buildDocument(): GraphWorkflowDocument {
  return { id: "wf", name: "wf", inputs: [], outputs: [], nodes: [], edges: [] };
}

function buildInstance(
  id: string,
  kind: string,
  parameters: Record<string, unknown> = {}
): GraphNodeInstance {
  return { id, kind, parameters };
}

function buildManifest(kind: string): GraphResolvedNodeManifest {
  return {
    kind,
    display: { name: kind },
    inputs: [],
    outputs: [],
    parameters: [],
  };
}

describe("GraphRunLogger", () => {
  it("forwards a structured GRAPH_RUN_LOG entry with the run attributes", async () => {
    const entries: unknown[] = [];
    let nodeId: string | undefined;
    const ctx = new GraphExecutionContext(
      "run-1",
      undefined,
      "wf",
      buildDocument(),
      buildInstance("LogNode", "core.utility.log"),
      buildManifest("core.utility.log"),
      ["LogNode"],
      async (event) => {
        nodeId = event.nodeId;
        if (event.type === GraphExecutionEventType.GRAPH_RUN_LOG) {
          entries.push(event.payload);
        }
      },
      { user: "alice" }
    );

    (ctx.logger as GraphRunLogger).info("hello from node", { detail: 42 });

    expect(entries).toHaveLength(1);
    const entry = entries[0] as {
      level: string;
      message: string;
      runId: string;
      workflowId: string;
      nodeId: string;
      user: string | null;
      timestamp: string;
      payload: { detail: number };
    };
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("hello from node");
    expect(entry.runId).toBe("run-1");
    expect(entry.workflowId).toBe("wf");
    expect(entry.nodeId).toBe("LogNode");
    expect(entry.user).toBe("alice");
    expect(new Date(entry.timestamp).getTime()).not.toBeNaN();
    expect(entry.payload).toEqual({ detail: 42 });
    expect(nodeId).toBe("LogNode");
  });

  it("emits warn/error log levels distinctly", async () => {
    const levels: string[] = [];
    const ctx = new GraphExecutionContext(
      "run-2",
      undefined,
      "wf",
      buildDocument(),
      buildInstance("N", "core.flow.log"),
      buildManifest("core.flow.log"),
      ["N"],
      async (event) => {
        if (event.type === GraphExecutionEventType.GRAPH_RUN_LOG) {
          levels.push((event.payload as { level: string }).level);
        }
      }
    );

    (ctx.logger as GraphRunLogger).warn("warning line");
    (ctx.logger as GraphRunLogger).error("error line", { code: 500 });

    expect(levels).toEqual(["warn", "error"]);
  });

  it("uses null user when the context carries no identity", async () => {
    let captured: unknown;
    const ctx = new GraphExecutionContext(
      "run-3",
      undefined,
      "wf",
      buildDocument(),
      buildInstance("N", "core.utility.log"),
      buildManifest("core.utility.log"),
      ["N"],
      async (event) => {
        if (event.type === GraphExecutionEventType.GRAPH_RUN_LOG) {
          captured = event.payload;
        }
      }
    );

    (ctx.logger as GraphRunLogger).info("anonymous");

    expect((captured as { user: string | null }).user).toBeNull();
  });
});

describe("UtilityLogNode.execute", () => {
  it("logs its input through ctx.logger at the configured level", async () => {
    const captured: unknown[] = [];
    const ctx = new GraphExecutionContext(
      "run-1",
      undefined,
      "wf",
      buildDocument(),
      buildInstance("LogNode", "core.utility.log", { level: "warn" }),
      buildManifest("core.utility.log"),
      ["LogNode"],
      async (event) => {
        if (event.type === GraphExecutionEventType.GRAPH_RUN_LOG) {
          captured.push(event.payload);
        }
      },
      { user: "bob" }
    );

    const executor = nodeExecutor(UtilityLogNode);
    const result = await executor.execute(
      nodeExecutionRequest({ value: "my value" }),
      ctx
    );

    expect(result).toEqual({ value: "my value" });
    expect(captured).toHaveLength(1);
    const entry = captured[0] as {
      level: string;
      message: string;
      payload: { value: string };
      nodeId: string;
      user: string | null;
    };
    expect(entry.level).toBe("warn");
    expect(entry.message).toBe("Log node");
    expect(entry.payload).toEqual({ value: "my value" });
    expect(entry.nodeId).toBe("LogNode");
    expect(entry.user).toBe("bob");
  });

  it("defaults the log level to info when unset", async () => {
    const captured: unknown[] = [];
    const ctx = new GraphExecutionContext(
      "run-2",
      undefined,
      "wf",
      buildDocument(),
      buildInstance("LogNode", "core.utility.log"),
      buildManifest("core.utility.log"),
      ["LogNode"],
      async (event) => {
        if (event.type === GraphExecutionEventType.GRAPH_RUN_LOG) {
          captured.push(event.payload);
        }
      }
    );

    const executor = nodeExecutor(UtilityLogNode);
    await executor.execute(nodeExecutionRequest({ value: 42 }), ctx);

    expect((captured[0] as { level: string }).level).toBe("info");
  });
});
