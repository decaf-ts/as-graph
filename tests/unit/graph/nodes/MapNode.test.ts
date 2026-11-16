/**
 * @module as-graph/tests/unit/graph/nodes/MapNode.test
 * @summary Tests for the `core.utility.map` node: the manifest it publishes and
 * its per-item mapping through the real code sandbox.
 */
import { MapNode, graphMapCodeOf } from "../../../../src/node/utility/map/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import {
  bootCodeSandboxEvaluator,
  executeNode,
  nodeExecutionRequest,
} from "../engine-fixtures";
import { buildNodeContext, codeSandboxEngine } from "./node-test-utils";

describe("MapNode", () => {
  const manifest = graphNodeManifest(MapNode);

  describe("manifest", () => {
    it("publishes the core.utility.map kind", () => {
      expect(manifest.kind).toBe("core.utility.map");
    });

    it("declares the data input, the expression field and both outputs", () => {
      expect(manifest.inputs.map((port) => port.id)).toEqual([
        "value",
        "expression",
      ]);
      expect(manifest.outputs.map((port) => port.id)).toEqual([
        "result",
        "count",
      ]);
    });

    it("publishes the expression as a fill-or-expose code field", () => {
      const expression = manifest.inputs.find(
        (port) => port.id === "expression"
      );
      expect(expression?.configurable).toBe(true);
      expect(expression?.element?.tag).toBe("code-editor");
      expect(
        manifest.parameters.find((entry) => entry.id === "expression")?.type
      ).toBe("code");
    });

    it("keeps the data input off the form", () => {
      const value = manifest.inputs.find((port) => port.id === "value");
      expect(value?.element).toBeUndefined();
    });
  });

  describe("graphMapCodeOf", () => {
    it("returns a bare expression", () => {
      expect(graphMapCodeOf("$item * 2")).toBe("return ($item * 2);");
      expect(graphMapCodeOf(" $item.a ; ")).toBe("return ($item.a);");
    });

    it("leaves a body that already returns untouched", () => {
      const body = "const total = $item.a + 1; return total;";
      expect(graphMapCodeOf(body)).toBe(body);
    });
  });

  describe("execute", () => {
    async function map(
      expression: string | undefined,
      inputs: Record<string, unknown>
    ) {
      const evaluator = await bootCodeSandboxEvaluator();
      const context = buildNodeContext("core.utility.map", {
        parameters: expression === undefined ? {} : { expression },
        engine: codeSandboxEngine(evaluator, () => ({})),
      });
      return executeNode(MapNode, nodeExecutionRequest(inputs), context);
    }

    it("maps every item of a list and reports the count", async () => {
      await expect(
        map("({ sku: $item.sku, total: $item.qty * $item.price })", {
          value: [
            { sku: "bolt", qty: 4, price: 2.5 },
            { sku: "nut", qty: 10, price: 1 },
          ],
        })
      ).resolves.toEqual({
        result: [
          { sku: "bolt", total: 10 },
          { sku: "nut", total: 10 },
        ],
        count: 2,
      });
    });

    it("exposes the item index and the whole input record", async () => {
      await expect(
        map("`${$input.prefix}-${$index}-${$item}`", {
          value: ["a", "b"],
          prefix: "row",
        })
      ).resolves.toEqual({ result: ["row-0-a", "row-1-b"], count: 2 });
    });

    it("maps a single value to a single value", async () => {
      await expect(map("$item * 2", { value: 21 })).resolves.toEqual({
        result: 42,
        count: 1,
      });
    });

    it("keeps a falsy item instead of dropping it", async () => {
      await expect(map("$item === 0", { value: [0, 1] })).resolves.toEqual({
        result: [true, false],
        count: 2,
      });
    });

    it("maps an empty list to an empty list", async () => {
      await expect(map("$item", { value: [] })).resolves.toEqual({
        result: [],
        count: 0,
      });
    });

    it("accepts a statement body that returns by itself", async () => {
      await expect(
        map("const doubled = $item * 2; return doubled + 1;", { value: [1, 2] })
      ).resolves.toEqual({ result: [3, 5], count: 2 });
    });

    it("fails closed without an expression", async () => {
      await expect(map(undefined, { value: [1] })).rejects.toMatchObject({
        graphCode: "GRAPH_MAP_EXPRESSION_REQUIRED",
      });
      await expect(map("   ", { value: [1] })).rejects.toMatchObject({
        graphCode: "GRAPH_MAP_EXPRESSION_REQUIRED",
      });
    });

    it("fails closed without a code sandbox", async () => {
      const context = buildNodeContext("core.utility.map", {
        parameters: { expression: "$item" },
      });
      await expect(
        executeNode(MapNode, nodeExecutionRequest({ value: [1] }), context)
      ).rejects.toMatchObject({ graphCode: "GRAPH_CODE_SANDBOX_NOT_CONFIGURED" });
    });
  });
});
