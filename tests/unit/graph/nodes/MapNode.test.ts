/**
 * @module as-graph/tests/unit/graph/nodes/MapNode.test
 * @summary Dedicated unit tests for the `core.utility.map` node class's instance
 * `execute` (DECAF-50 §4.26 R2-1, DECAF-32 §22.2.3, SAA-2015).
 */
import { MapNode } from "../../../../src/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

describe("MapNode", () => {
  const manifest = graphNodeManifest(MapNode);

  describe("manifest", () => {
    it("publishes the core.utility.map kind", () => {
      expect(manifest.kind).toBe("core.utility.map");
    });

    it("declares the value input and the result output", () => {
      expect(manifest.inputs.map((port) => port.id)).toEqual(["value"]);
      expect(manifest.outputs.map((port) => port.id)).toEqual(["result"]);
    });

    it("renders the value input through the crud field textarea", () => {
      const value = manifest.inputs.find((port) => port.id === "value");
      expect(value?.element?.tag).toBe("ngx-decaf-crud-field");
      expect(value?.element?.props?.["type"]).toBe("textarea");
    });
  });

  describe("execute", () => {
    it("maps the routed value into a result object", async () => {
      const context = buildNodeContext("core.utility.map");
      const result = await executeNode(
        MapNode,
        nodeExecutionRequest({ value: { a: 1 } }),
        context
      );
      expect(result).toEqual({ result: { mapped: { a: 1 } } });
    });

    it("maps the full input map when no value port is routed", async () => {
      const context = buildNodeContext("core.utility.map");
      const result = await executeNode(
        MapNode,
        nodeExecutionRequest({ other: "x" }),
        context
      );
      expect(result).toEqual({ result: { mapped: { other: "x" } } });
    });

    it("preserves a falsy routed value (nullish fallback only)", async () => {
      const context = buildNodeContext("core.utility.map");
      const result = await executeNode(
        MapNode,
        nodeExecutionRequest({ value: 0 }),
        context
      );
      expect(result).toEqual({ result: { mapped: 0 } });
    });
  });
});
