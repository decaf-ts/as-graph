/**
 * @module as-graph/tests/unit/graph/SwitchFlowNode.test
 * @summary Unit tests for the Switch flow-control node class's static execute
 * (DECAF-32 §22.2.2, DECAF-34 §6.2, DECAF-50 §4.26 R2-1).
 */
import { SwitchFlowNode } from "../../../src/node";
import { GraphExecutionContext } from "../../../src/engine/execution/GraphExecutionContext";
import { GraphExecutionError } from "../../../src/engine/errors/GraphExecutionError";
import { IsolatedVmCodeSandboxEvaluator } from "../../../src/engine/execution/IsolatedVmCodeSandboxEvaluator";
import type { CodeSandboxEvaluator } from "../../../src/engine/execution/CodeSandboxEvaluator";
import type { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import type {
  GraphNodeInstance,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";
import type { SwitchNodeMetadata } from "../../../src/shared/graph";
import type { GraphResolvedNodeManifest } from "../../../src/shared/graph";
import {
  bootCodeSandboxEvaluator,
  nodeExecutionRequest,
  nodeExecutor,
} from "./engine-fixtures";

/**
 * Minimal engine facade exposing the `codeSandboxEvaluator` the Switch node
 * reads through `context.engine` (DECAF-50 §4.26 R2-1).
 */
function engineWith(
  codeSandboxEvaluator?: CodeSandboxEvaluator
): GraphExecutionEngine {
  return { codeSandboxEvaluator } as unknown as GraphExecutionEngine;
}

/**
 * Builds a minimal {@link GraphExecutionContext} for a Switch node whose
 * instance `parameters` carry the given {@link SwitchNodeMetadata} (the
 * decorated-property surface the node hydrates `this.cases`/`this.hasDefault`/
 * `this.defaultPort` from).
 */
function buildContext(
  switchMeta: SwitchNodeMetadata,
  contextMetadata: Record<string, unknown> = {},
  engine?: GraphExecutionEngine
): GraphExecutionContext {
  const node: GraphNodeInstance = {
    id: "SwitchNode",
    kind: "core.flow.switch",
    parameters: { ...switchMeta } as never,
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
    kind: "core.flow.switch",
    display: { name: "Switch" },
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
    ["SwitchNode"],
    async () => {},
    contextMetadata,
    engine
  );
}

describe("SwitchFlowNode.execute", () => {
  describe("ConditionExpression (graphical mode)", () => {
    const executor = nodeExecutor(SwitchFlowNode);

    it("routes to the first matching case output port", async () => {
      const meta: SwitchNodeMetadata = {
        cases: [
          {
            id: "c1",
            label: "Is 5",
            outputPort: "five",
            condition: { op: "eq", left: { path: "n" }, right: { const: 5 } },
          },
          {
            id: "c2",
            label: "Is 10",
            outputPort: "ten",
            condition: { op: "eq", left: { path: "n" }, right: { const: 10 } },
          },
        ],
        defaultPort: "default",
      };
      const ctx = buildContext(meta);
      const result = await executor.execute(nodeExecutionRequest({ value: { n: 10 } }), ctx);
      expect(result).toEqual({ ten: { n: 10 } });
    });

    it("routes to the default port when no case matches", async () => {
      const meta: SwitchNodeMetadata = {
        cases: [
          {
            id: "c1",
            label: "Is 5",
            outputPort: "five",
            condition: { op: "eq", left: { path: "n" }, right: { const: 5 } },
          },
        ],
        defaultPort: "default",
        hasDefault: true,
      };
      const ctx = buildContext(meta);
      const result = await executor.execute(nodeExecutionRequest({ value: { n: 99 } }), ctx);
      expect(result).toEqual({ default: { n: 99 } });
    });

    it("throws GRAPH_SWITCH_NO_MATCH when no case matches and hasDefault is false", async () => {
      const meta: SwitchNodeMetadata = {
        cases: [
          {
            id: "c1",
            label: "Is 5",
            outputPort: "five",
            condition: { op: "eq", left: { path: "n" }, right: { const: 5 } },
          },
        ],
        defaultPort: "default",
        hasDefault: false,
      };
      const ctx = buildContext(meta);
      await expect(executor.execute(nodeExecutionRequest({ value: { n: 99 } }), ctx)).rejects.toThrow(
        GraphExecutionError
      );
      await expect(executor.execute(nodeExecutionRequest({ value: { n: 99 } }), ctx)).rejects.toThrow(
        /No switch case matched/i
      );
    });

    it("evaluates cases in order — first match wins", async () => {
      const meta: SwitchNodeMetadata = {
        cases: [
          {
            id: "c1",
            label: "First",
            outputPort: "first",
            condition: { op: "gt", left: { path: "n" }, right: { const: 0 } },
          },
          {
            id: "c2",
            label: "Second",
            outputPort: "second",
            condition: { op: "gt", left: { path: "n" }, right: { const: 100 } },
          },
        ],
        defaultPort: "default",
      };
      const ctx = buildContext(meta);
      // n=50 matches the first case (gt 0) but not the second (gt 100).
      const result = await executor.execute(nodeExecutionRequest({ value: { n: 50 } }), ctx);
      expect(result).toEqual({ first: { n: 50 } });
    });

    it("supports the exists operator", async () => {
      const meta: SwitchNodeMetadata = {
        cases: [
          {
            id: "c1",
            label: "Has name",
            outputPort: "named",
            condition: { op: "exists", value: { path: "name" } },
          },
        ],
        defaultPort: "default",
        hasDefault: true,
      };
      const ctx = buildContext(meta);
      expect(await executor.execute(nodeExecutionRequest({ value: { name: "foo" } }), ctx)).toEqual({
        named: { name: "foo" },
      });
      expect(await executor.execute(nodeExecutionRequest({ value: {} }), ctx)).toEqual({
        default: {},
      });
    });

    it("supports composite and/or/not conditions", async () => {
      const meta: SwitchNodeMetadata = {
        cases: [
          {
            id: "c1",
            label: "Range",
            outputPort: "inRange",
            condition: {
              op: "and",
              conditions: [
                { op: "gte", left: { path: "n" }, right: { const: 10 } },
                { op: "lte", left: { path: "n" }, right: { const: 20 } },
              ],
            },
          },
        ],
        defaultPort: "default",
        hasDefault: true,
      };
      const ctx = buildContext(meta);
      expect(await executor.execute(nodeExecutionRequest({ value: { n: 15 } }), ctx)).toEqual({
        inRange: { n: 15 },
      });
      expect(await executor.execute(nodeExecutionRequest({ value: { n: 25 } }), ctx)).toEqual({
        default: { n: 25 },
      });
    });
  });

  describe("CodeCondition (code mode)", () => {
    let evaluator: IsolatedVmCodeSandboxEvaluator;
    let engine: GraphExecutionEngine;
    const executor = nodeExecutor(SwitchFlowNode);

    beforeAll(async () => {
      evaluator = await bootCodeSandboxEvaluator();
      engine = engineWith(evaluator);
    });

    it("evaluates a code condition and routes on true", async () => {
      const meta: SwitchNodeMetadata = {
        cases: [
          {
            id: "c1",
            label: "Even",
            outputPort: "even",
            condition: { type: "code", code: "return $index % 2 === 0;" },
          },
        ],
        defaultPort: "default",
      };
      const ctx = buildContext(meta, { index: 4 }, engine);
      const result = await executor.execute(nodeExecutionRequest({ value: "item" }), ctx);
      expect(result).toEqual({ even: "item" });
    });

    it("falls to default when code condition returns false", async () => {
      const meta: SwitchNodeMetadata = {
        cases: [
          {
            id: "c1",
            label: "Even",
            outputPort: "even",
            condition: { type: "code", code: "return $index % 2 === 0;" },
          },
        ],
        defaultPort: "default",
        hasDefault: true,
      };
      const ctx = buildContext(meta, { index: 3 }, engine);
      const result = await executor.execute(nodeExecutionRequest({ value: "item" }), ctx);
      expect(result).toEqual({ default: "item" });
    });

    it("coerces truthy non-boolean sandbox results to true", async () => {
      const meta: SwitchNodeMetadata = {
        cases: [
          {
            id: "c1",
            label: "Truthy",
            outputPort: "yes",
            condition: { type: "code", code: "return $input.value;" },
          },
        ],
        defaultPort: "default",
        hasDefault: true,
      };
      const ctx = buildContext(meta, {}, engine);
      expect(await executor.execute(nodeExecutionRequest({ value: "non-empty" }), ctx)).toEqual({
        yes: "non-empty",
      });
      expect(await executor.execute(nodeExecutionRequest({ value: 0 }), ctx)).toEqual({
        default: 0,
      });
    });

    it("passes $vars from context metadata to the sandbox", async () => {
      const meta: SwitchNodeMetadata = {
        cases: [
          {
            id: "c1",
            label: "Match var",
            outputPort: "matched",
            condition: {
              type: "code",
              code: "return $vars.mode === 'test';",
            },
          },
        ],
        defaultPort: "default",
      };
      const ctx = buildContext(meta, { vars: { mode: "test" } }, engine);
      expect(await executor.execute(nodeExecutionRequest({ value: 1 }), ctx)).toEqual({
        matched: 1,
      });
    });
  });

  describe("without a CodeSandboxEvaluator", () => {
    it("throws GRAPH_CODE_SANDBOX_NOT_CONFIGURED for code conditions", async () => {
      const executor = nodeExecutor(SwitchFlowNode);
      const meta: SwitchNodeMetadata = {
        cases: [
          {
            id: "c1",
            label: "C",
            outputPort: "c",
            condition: { type: "code", code: "return true;" },
          },
        ],
        defaultPort: "default",
      };
      const ctx = buildContext(meta);
      await expect(executor.execute(nodeExecutionRequest({ value: 1 }), ctx)).rejects.toThrow(
        GraphExecutionError
      );
      await expect(executor.execute(nodeExecutionRequest({ value: 1 }), ctx)).rejects.toThrow(
        /CodeSandboxEvaluator.*registered/i
      );
    });

    it("throws when engine is undefined", async () => {
      const executor = nodeExecutor(SwitchFlowNode);
      const meta: SwitchNodeMetadata = {
        cases: [
          {
            id: "c1",
            label: "C",
            outputPort: "c",
            condition: { type: "code", code: "return true;" },
          },
        ],
        defaultPort: "default",
      };
      const ctx = buildContext(meta);
      await expect(executor.execute(nodeExecutionRequest({ value: 1 }), ctx)).rejects.toThrow(
        /CodeSandboxEvaluator.*registered/i
      );
    });
  });

  describe("unknown condition type", () => {
    it("throws GraphExecutionError", async () => {
      const executor = nodeExecutor(SwitchFlowNode);
      const meta: SwitchNodeMetadata = {
        cases: [
          {
            id: "c1",
            label: "Bad",
            outputPort: "bad",
            condition: { bogus: true } as never,
          },
        ],
        defaultPort: "default",
      };
      const ctx = buildContext(meta);
      await expect(executor.execute(nodeExecutionRequest({ value: 1 }), ctx)).rejects.toThrow(
        GraphExecutionError
      );
      await expect(executor.execute(nodeExecutionRequest({ value: 1 }), ctx)).rejects.toThrow(
        /Unknown switch case condition/i
      );
      await expect(executor.execute(nodeExecutionRequest({ value: 1 }), ctx)).rejects.toMatchObject({
        graphCode: "GRAPH_UNKNOWN_CONDITION_TYPE",
      });
    });
  });

  describe("empty / missing metadata", () => {
    it("routes to default when there are no cases", async () => {
      const executor = nodeExecutor(SwitchFlowNode);
      const ctx = buildContext({ cases: [], defaultPort: "default", hasDefault: true });
      const result = await executor.execute(nodeExecutionRequest({ value: 42 }), ctx);
      expect(result).toEqual({ default: 42 });
    });

    it("throws GRAPH_SWITCH_NO_MATCH when no cases and hasDefault is false", async () => {
      const executor = nodeExecutor(SwitchFlowNode);
      const ctx = buildContext({
        cases: [],
        defaultPort: "default",
        hasDefault: false,
      });
      await expect(executor.execute(nodeExecutionRequest({ value: 42 }), ctx)).rejects.toThrow(
        /No switch case matched/i
      );
    });
  });

  describe("with a custom CodeSandboxEvaluator", () => {
    it("delegates to the custom evaluator", async () => {
      const custom: CodeSandboxEvaluator = {
        evaluate: (ctx) => `code-result:${ctx.code}`,
      };
      const executor = nodeExecutor(SwitchFlowNode);
      const meta: SwitchNodeMetadata = {
        cases: [
          {
            id: "c1",
            label: "C",
            outputPort: "c",
            condition: { type: "code", code: "return true;" },
          },
        ],
        defaultPort: "default",
      };
      const ctx = buildContext(meta, {}, engineWith(custom));
      const result = await executor.execute(nodeExecutionRequest({ value: 1 }), ctx);
      // "code-result:return true;" is a truthy string → routes to case port.
      expect(result).toEqual({ c: 1 });
    });
  });

  describe("UI-authored switch documents (DECAF-50 §4.26 R4-4)", () => {
    const executor = nodeExecutor(SwitchFlowNode);

    /**
     * Builds a context whose node instance carries `parameters` (the surface
     * the Angular node template writes) rather than `metadata.switch`.
     */
    function buildParameterContext(
      parameters: Record<string, unknown>
    ): GraphExecutionContext {
      const node: GraphNodeInstance = {
        id: "SwitchNode",
        kind: "core.flow.switch",
        parameters: parameters as never,
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
        kind: "core.flow.switch",
        display: { name: "Switch" },
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
        ["SwitchNode"],
        async () => {},
        {},
        undefined
      );
    }

    it("resolves the graphical condition path (the `value` input port name) against the switch input", async () => {
      const cases = [
        {
          id: "c1",
          label: "Is 1",
          outputPort: "case_1",
          condition: {
            op: "eq",
            left: { path: "value" },
            right: { const: 1 },
          },
        },
      ];
      const ctx = buildParameterContext({
        cases,
        hasDefault: true,
        switch: { cases, defaultPort: "default", hasDefault: true },
      });
      expect(await executor.execute(nodeExecutionRequest({ value: 1 }), ctx)).toEqual({
        case_1: 1,
      });
      expect(await executor.execute(nodeExecutionRequest({ value: 2 }), ctx)).toEqual({
        default: 2,
      });
    });

    it("reads the declared top-level parameters.cases/hasDefault surface when no switch block is present", async () => {
      const cases = [
        {
          id: "c1",
          label: "Is 1",
          outputPort: "case_1",
          condition: {
            op: "eq",
            left: { path: "value" },
            right: { const: 1 },
          },
        },
      ];
      const ctx = buildParameterContext({ cases, hasDefault: true });
      expect(await executor.execute(nodeExecutionRequest({ value: 1 }), ctx)).toEqual({
        case_1: 1,
      });
      expect(await executor.execute(nodeExecutionRequest({ value: 5 }), ctx)).toEqual({
        default: 5,
      });
    });

    it("still resolves a nested field path against the primary value", async () => {
      const cases = [
        {
          id: "c1",
          label: "Is 2",
          outputPort: "case_1",
          condition: {
            op: "eq",
            left: { path: "n" },
            right: { const: 2 },
          },
        },
      ];
      const ctx = buildParameterContext({
        cases,
        hasDefault: true,
        switch: { cases, defaultPort: "default", hasDefault: true },
      });
      expect(
        await executor.execute(nodeExecutionRequest({ value: { n: 2 } }), ctx)
      ).toEqual({ case_1: { n: 2 } });
    });
  });
});
