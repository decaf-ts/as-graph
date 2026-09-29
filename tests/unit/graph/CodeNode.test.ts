/**
 * @module as-graph/tests/unit/graph/CodeNode.test
 * @summary Unit tests for the Code node class's static execute
 * (DECAF-32 §22.4, DECAF-34 §7.5, DECAF-50 §4.26 R2-1).
 */
import { CodeNode } from "../../../src/node";
import { IsolatedVmCodeSandboxEvaluator } from "../../../src/engine/execution/IsolatedVmCodeSandboxEvaluator";
import { GraphExecutionContext } from "../../../src/engine/execution/GraphExecutionContext";
import { GraphExecutionError } from "../../../src/engine/errors/GraphExecutionError";
import { GraphInputError } from "../../../src/engine/errors/GraphInputError";
import type { CodeSandboxEvaluator } from "../../../src/engine/execution/CodeSandboxEvaluator";
import type { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import type {
  GraphNodeInstance,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";
import type { GraphResolvedNodeManifest } from "../../../src/shared/graph";
import { nodeExecutionRequest } from "./engine-fixtures";

/**
 * Minimal engine facade exposing the `codeSandboxEvaluator` the Code node
 * reads through `context.engine` (DECAF-50 §4.26 R2-1).
 */
function engineWith(
  codeSandboxEvaluator?: CodeSandboxEvaluator
): GraphExecutionEngine {
  return { codeSandboxEvaluator } as unknown as GraphExecutionEngine;
}

/**
 * Builds a minimal {@link GraphExecutionContext} for a Code node.
 * The node's instance metadata carries only `timeoutMs` (code now comes from
 * the `code` input port, spliced from {@link CodeInputSchema}).
 */
function buildContext(
  nodeMetadata: Record<string, unknown> = {},
  contextMetadata: Record<string, unknown> = {},
  engine?: GraphExecutionEngine
): GraphExecutionContext {
  const node: GraphNodeInstance = {
    id: "CodeNode",
    kind: "core.utility.code",
    parameters: {},
    metadata: nodeMetadata as never,
  };
  const document: GraphWorkflowDocument = {
    id: "wf",
    name: "wf",
    inputs: [],
    outputs: [],
    nodes: [],
    edges: [],
  };
  const manifest: GraphResolvedNodeManifest = {
    kind: "core.utility.code",
    display: { name: "Code" },
    inputs: [],
    outputs: [],
    parameters: [],
  };
  return new GraphExecutionContext(
    "run-1",
    undefined,
    "wf",
    document,
    node,
    manifest,
    ["CodeNode"],
    async () => {},
    contextMetadata,
    engine
  );
}

describe("CodeNode.execute", () => {
  describe("with a registered CodeSandboxEvaluator", () => {
    const evaluator = new IsolatedVmCodeSandboxEvaluator();
    const engine = engineWith(evaluator);

    it("executes a simple expression and returns the result on the result port", async () => {
      const ctx = buildContext({}, { vars: { a: 2, b: 3 } }, engine);
      const result = await CodeNode.execute(
        nodeExecutionRequest({ code: "return $vars.a + $vars.b;" }),
        ctx
      );
      expect(result).toEqual({ result: 5 });
    });

    it("executes a statement-mode code with return", async () => {
      const ctx = buildContext({}, { vars: { a: 3, b: 4 } }, engine);
      const result = await CodeNode.execute(
        nodeExecutionRequest({ code: "const sum = $vars.a + $vars.b; return sum * 2;" }),
        ctx
      );
      expect(result).toEqual({ result: 14 });
    });

    it("passes $vars from context metadata", async () => {
      const ctx = buildContext({}, { vars: { topic: "hello" } }, engine);
      const result = await CodeNode.execute(
        nodeExecutionRequest({ code: "return $vars.topic;" }),
        ctx
      );
      expect(result).toEqual({ result: "hello" });
    });

    it("passes $item and $index from context metadata (loop body)", async () => {
      const ctx = buildContext({}, { item: "apple", index: 2 }, engine);
      const result = await CodeNode.execute(
        nodeExecutionRequest({ code: "return { item: $item, index: $index };" }),
        ctx
      );
      expect(result).toEqual({
        result: { item: "apple", index: 2 },
      });
    });

    it("passes $node outputs from context metadata", async () => {
      const ctx = buildContext(
        {},
        { nodes: { Research: { output: { summary: "found" } } } },
        engine
      );
      const result = await CodeNode.execute(
        nodeExecutionRequest({ code: 'return $node["Research"].output.summary;' }),
        ctx
      );
      expect(result).toEqual({ result: "found" });
    });

    it("defaults language to javascript when not set in metadata", async () => {
      const ctx = buildContext({}, {}, engine);
      const result = await CodeNode.execute(
        nodeExecutionRequest({ code: "return 42;" }),
        ctx
      );
      expect(result).toEqual({ result: 42 });
    });

    it("exposes $input as the full input values object (including code)", async () => {
      const ctx = buildContext({}, {}, engine);
      const result = await CodeNode.execute(
        nodeExecutionRequest({ code: "return $input.code.length;" }),
        ctx
      );
      expect(result).toEqual({ result: "return $input.code.length;".length });
    });
  });

  describe("without a CodeSandboxEvaluator", () => {
    it("throws GRAPH_CODE_SANDBOX_NOT_CONFIGURED", async () => {
      const ctx = buildContext();
      await expect(
        CodeNode.execute(nodeExecutionRequest({ code: "return 1;" }), ctx)
      ).rejects.toThrow(GraphExecutionError);
      await expect(
        CodeNode.execute(nodeExecutionRequest({ code: "return 1;" }), ctx)
      ).rejects.toThrow(/CodeSandboxEvaluator.*registered/i);
    });

    it("throws when the engine is undefined", async () => {
      const ctx = buildContext();
      await expect(
        CodeNode.execute(nodeExecutionRequest({ code: "return 1;" }), ctx)
      ).rejects.toThrow(/CodeSandboxEvaluator.*registered/i);
    });
  });

  describe("validation", () => {
    const evaluator = new IsolatedVmCodeSandboxEvaluator();
    const engine = engineWith(evaluator);

    it("throws GraphInputError when input.code is empty", async () => {
      const ctx = buildContext({}, {}, engine);
      await expect(
        CodeNode.execute(nodeExecutionRequest({ code: "" }), ctx)
      ).rejects.toThrow(GraphInputError);
      await expect(
        CodeNode.execute(nodeExecutionRequest({ code: "" }), ctx)
      ).rejects.toThrow(/no code to execute/i);
    });

    it("throws GraphInputError when input.code is whitespace", async () => {
      const ctx = buildContext({}, {}, engine);
      await expect(
        CodeNode.execute(nodeExecutionRequest({ code: "   " }), ctx)
      ).rejects.toThrow(/no code to execute/i);
    });

    it("throws GraphInputError when input.code is missing", async () => {
      const ctx = buildContext({}, {}, engine);
      await expect(
        CodeNode.execute(nodeExecutionRequest({}), ctx)
      ).rejects.toThrow(/no code to execute/i);
    });

    it("throws GraphInputError when input.code is not a string", async () => {
      const ctx = buildContext({}, {}, engine);
      await expect(
        CodeNode.execute(nodeExecutionRequest({ code: 123 }), ctx)
      ).rejects.toThrow(/no code to execute/i);
    });

    it("propagates forbidden-token errors from the sandbox", async () => {
      const ctx = buildContext({}, {}, engine);
      await expect(
        CodeNode.execute(nodeExecutionRequest({ code: "require('fs')" }), ctx)
      ).rejects.toThrow(/Identifier "require".*not allowed/i);
    });

    it("propagates runtime errors from the sandbox", async () => {
      const ctx = buildContext({}, {}, engine);
      await expect(
        CodeNode.execute(
          nodeExecutionRequest({ code: "return undefinedVar.foo;" }),
          ctx
        )
      ).rejects.toThrow(/execution failed/i);
    });
  });

  describe("with a custom CodeSandboxEvaluator", () => {
    it("delegates to the custom evaluator and returns its result", async () => {
      const custom: CodeSandboxEvaluator = {
        evaluate: (ctx) => `custom:${ctx.code}`,
      };
      const ctx = buildContext({}, {}, engineWith(custom));
      const result = await CodeNode.execute(
        nodeExecutionRequest({ code: "return 1;" }),
        ctx
      );
      expect(result).toEqual({ result: "custom:return 1;" });
    });

    it("passes the code, language, and input to the evaluator", async () => {
      let captured: Record<string, unknown> = {};
      const custom: CodeSandboxEvaluator = {
        evaluate: (ctx) => {
          captured = {
            code: ctx.code,
            language: ctx.language,
            input: ctx.input,
          };
          return "ok";
        },
      };
      const ctx = buildContext({}, {}, engineWith(custom));
      await CodeNode.execute(
        nodeExecutionRequest({ code: "return 1;" }),
        ctx
      );
      expect(captured).toEqual({
        code: "return 1;",
        language: "javascript",
        input: { code: "return 1;" },
      });
    });
  });
});
