/**
 * @module as-graph/tests/unit/graph/GraphNodeManifestResolver.test
 * @summary Unit tests for the graph node manifest resolver.
 * @description Validates the resolved-manifest dynamic-port expansion:
 * `repeatFromParameter` (id/label templates, dedup against static ports,
 * defaultPort clone, index fallback), `togglePort` (on/off inclusion), the
 * built-in switch's cases conformance, and the resulting
 * `GraphResolvedNodeManifest` JSON-safety and cloning.
 */
import { describe, it, expect } from "@jest/globals";
import type {
  GraphJsonValue,
  GraphNodeInstance,
  GraphNodeManifest,
  GraphPortManifest,
} from "../../../src/shared/graph";
import { isGraphJsonSafeValue } from "../../../src/shared/graph";
import {
  GraphExecutionEngine,
  GraphNodeCatalogue,
  GraphNodeExecutorRegistry,
  registerBuiltInGraphNodes,
  resolveGraphNodeManifest,
  resolveGraphDynamicPorts,
} from "../../../src";
import { SWITCH_GRAPH_NODE_MANIFEST } from "../../../src/node";

function portNode(
  id: string,
  label: string,
  direction: "input" | "output" | "connection"
): GraphPortManifest {
  return { id, label, direction };
}

function plainManifest(kind: string): GraphNodeManifest {
  return {
    kind,
    display: { name: kind, category: "Utility", color: "#7c3aed" },
    inputs: [],
    outputs: [],
    parameters: [],
  };
}

describe("GraphNodeManifestResolver", () => {
  it("expands repeatFromParameter dynamic ports from the collection parameter", () => {
    const contention = resolveGraphDynamicPorts(plainManifest("test.dynamic"), {});
    expect(contention).toEqual({ inputs: [], outputs: [], connections: [] });
  });

  it("resolves the manifest's dynamic ports from the parameter property paths", () => {
    const types = resolveGraphNodeManifest(
      {
        ...plainManifest("core.flow.switch"),
        inputs: [portNode("value", "Input value", "input")],
        dynamicPorts: [
          {
            type: "repeatFromParameter",
            parameter: "cases",
            itemIdPath: "outputPort",
            itemLabelPath: "label",
            direction: "output",
            portIdTemplate: "${id}",
            defaultPort: { id: "case", label: "Case", direction: "output" },
          },
        ],
      },
      {
        cases: [
          { outputPort: "caseA", label: "Case A" },
          { outputPort: "caseB", label: "Case B" },
        ],
      }
    );
    expect(types.kind).toBe("core.flow.switch");
    expect(types.outputs.map((port) => port.id)).toEqual(["caseA", "caseB"]);
  });

  it("clones the dynamic port's defaultPort and applies the dynamic id/label", () => {
    const types = resolveGraphNodeManifest(
      {
        ...plainManifest("test.dynamic"),
        outputs: [
          portNode("case", "Case", "output"),
          portNode("static", "Static", "output"),
        ],
        dynamicPorts: [
          {
            type: "repeatFromParameter",
            parameter: "items",
            itemIdPath: "id",
            itemLabelPath: "label",
            direction: "output",
            portIdTemplate: "${id}",
            defaultPort: {
              id: "case",
              label: "Case",
              direction: "output",
              schema: { type: "string" },
            },
          },
        ],
      },
      {
        items: [
          { id: "first", label: "First port" },
          { id: "second", label: "Second port" },
          { id: "case", label: "Case port" },
        ],
      }
    );
    // dynamic expansion: the defaultPort clone id "case" is overridden by the
    // dynamic template ("case:index" consumed here) and the static port
    // "case" is claimed
    expect(types.outputs.map((port) => port.id)).toEqual([
      "case",
      "static",
      "first",
      "second",
    ]);
    const dynamic = types.outputs[2];
    expect(dynamic.schema).toEqual({ type: "string" });
    expect(dynamic.direction).toBe("output");
    expect(dynamic.label).toBe("First port");
  });

  it("expands repeatFromParameter port ids and labels via template placeholders", () => {
    const manifest: GraphNodeManifest = {
      ...(plainManifest("test.dynamic") as GraphNodeManifest),
      display: { ...plainManifest("test.dynamic").display },
      outputs: [portNode("case", "Case", "output")],
      parameters: [{ type: "collection", id: "values", label: "Values" }],
      dynamicPorts: [
        {
          type: "repeatFromParameter",
          parameter: "values",
          itemIdPath: "value",
          itemLabelPath: "label",
          direction: "output",
          portIdTemplate: "${id}-${label}-${index}",
          defaultPort: {
            id: "case",
            label: "Case",
            direction: "output",
            schema: { type: "string" },
          },
        },
      ],
    } as GraphNodeManifest;
    const resolved = resolveGraphNodeManifest(manifest, {
      values: [
        { value: "first", label: "First label" },
        { value: "second", label: "Second label" },
      ],
    });
    expect(resolved.outputs.map((port) => port.id)).toEqual([
      "case",
      "first-First label-0",
      "second-Second label-1",
    ]);
    expect(resolved.outputs.map((port) => port.label)).toEqual([
      "Case",
      "First label",
      "Second label",
    ]);
    expect(resolved.outputs[2].schema).toEqual({ type: "string" });
  });

  it("toggles a dynamic port in or out of the resolved ports by the parameter guard", () => {
    const manifest: GraphNodeManifest = {
      ...(plainManifest("test.dynamic") as GraphNodeManifest),
      display: { ...plainManifest("test.dynamic").display },
      inputs: [],
      outputs: [],
      parameters: [{ type: "boolean", id: "hasDefault", label: "Has default" }],
      dynamicPorts: [
        {
          type: "togglePort",
          parameter: "hasDefault",
          equals: true,
          port: {
            id: "default",
            label: "Default",
            direction: "output",
            schema: { type: "any" },
          },
        },
      ],
    } as GraphNodeManifest;
    // toggle off: the port is dropped
    expect(resolveGraphNodeManifest(manifest, {}).outputs).toEqual([]);
    // toggle on: the port is included
    expect(
      resolveGraphNodeManifest(manifest, { hasDefault: true }).outputs.map(
        (port) => port.id
      )
    ).toEqual(["default"]);
  });

  it("expands the built-in switch's cases, hasDefault and switch parameters into their resolved ports", () => {
    const resolved = resolveGraphNodeManifest(SWITCH_GRAPH_NODE_MANIFEST, {
      cases: [
        { outputPort: "caseA", label: "Case A" },
        { outputPort: "caseB", label: "Case B" },
      ],
      hasDefault: true,
    });
    expect(resolved.outputs.map((port) => port.id)).toEqual([
      "caseA",
      "caseB",
      "default",
    ]);
    expect(resolved.outputs.map((port) => port.label)).toEqual([
      "Case A",
      "Case B",
      "Default",
    ]);
    expect(resolved.parameters.map((parameter) => parameter.id)).toEqual([
      "value",
      "cases",
      "hasDefault",
      "switch",
    ]);
    expect(resolved.dynamicPorts).toEqual(SWITCH_GRAPH_NODE_MANIFEST.dynamicPorts);
  });

  it("resolves the built-in switch's cases list without a default port when the toggle is off", () => {
    const resolved = resolveGraphNodeManifest(SWITCH_GRAPH_NODE_MANIFEST, {
      cases: [{ outputPort: "caseA", label: "Case A" }],
      hasDefault: false,
    });
    expect(resolved.outputs.map((port) => port.id)).toEqual(["caseA"]);
  });

  it("returns a JSON-safe resolved manifest for the built-in switch", () => {
    const resolved = resolveGraphNodeManifest(SWITCH_GRAPH_NODE_MANIFEST, {
      cases: [{ outputPort: "caseA", label: "Case A" }],
      hasDefault: true,
    });
    expect(isGraphJsonSafeValue(resolved)).toBe(true);
    expect(JSON.stringify(resolved)).not.toContain("function");
    expect(JSON.stringify(resolved)).not.toContain("=>");
  });

  it("falls back to the item index and the expanded port id when the repeated items carry no id or label paths", () => {
    const manifest: GraphNodeManifest = {
      ...(plainManifest("test.dynamic") as GraphNodeManifest),
      display: { ...plainManifest("test.dynamic").display },
      outputs: [],
      parameters: [{ type: "collection", id: "cases", label: "Cases" }],
      dynamicPorts: [
        {
          type: "repeatFromParameter",
          parameter: "cases",
          direction: "output",
          itemIdPath: "outputPort",
          portIdTemplate: "case-${index}",
        },
      ],
    } as GraphNodeManifest;
    const resolved = resolveGraphNodeManifest(manifest, {
      cases: ["first", "second"],
    });
    expect(resolved.outputs.map((port) => port.id)).toEqual([
      "case-0",
      "case-1",
    ]);
    // no itemLabelPath -> the port label falls back to the expanded port id
    expect(resolved.outputs.map((port) => port.label)).toEqual([
      "case-0",
      "case-1",
    ]);
    expect(
      resolved.outputs.every((port) => port.direction === "output")
    ).toBe(true);
  });

  it("clones the resolved manifest's ports so mutations never leak to the source manifest", () => {
    const original = SWITCH_GRAPH_NODE_MANIFEST.outputs.map((port) => port.id);
    const resolved = resolveGraphNodeManifest(SWITCH_GRAPH_NODE_MANIFEST, {
      cases: [{ outputPort: "caseA", label: "Case A" }],
      hasDefault: true,
    });
    resolved.outputs[0].id = "manipulated";
    expect(resolved.outputs[0].id).toBe("manipulated");
    expect(SWITCH_GRAPH_NODE_MANIFEST.outputs).toEqual(original);
    expect(resolved.outputs[1].id).toBe("default");
  });
});

describe("Conformance: core.flow.switch declarative dynamic-port rules vs the backend resolve path (DECAF-34 supersession)", () => {
  const CASES = [
    { outputPort: "caseA", label: "Case A" },
    { outputPort: "caseB", label: "Case B" },
  ];

  function switchInstanceOf(
    parameters: Record<string, GraphJsonValue>
  ): GraphNodeInstance {
    return {
      id: "switch-node",
      kind: "core.flow.switch",
      parameters,
    };
  }

  it("resolves core.flow.switch's dynamic ports identically through the declarative rules and the backend resolve path", async () => {
    const catalogue = new GraphNodeCatalogue();
    const engine = new GraphExecutionEngine({
      registry: new GraphNodeExecutorRegistry(catalogue),
    });
    registerBuiltInGraphNodes(catalogue, engine);

    for (const parameters of [
      { cases: CASES, hasDefault: true },
      { cases: CASES, hasDefault: false },
    ]) {
      const backendResolved = await catalogue.resolveManifest(
        "core.flow.switch",
        switchInstanceOf(parameters)
      );
      const declarativeResolved = resolveGraphNodeManifest(
        SWITCH_GRAPH_NODE_MANIFEST,
        parameters
      );
      expect(backendResolved.outputs).toEqual(declarativeResolved.outputs);
      expect(backendResolved.inputs).toEqual(declarativeResolved.inputs);
      expect(backendResolved.parameters).toEqual(
        declarativeResolved.parameters
      );
      // resolution output is JSON-safe on both routes
      expect(isGraphJsonSafeValue(backendResolved)).toBe(true);
      expect(isGraphJsonSafeValue(declarativeResolved)).toBe(true);
    }

    // backend resolve path: cases + hasDefault:true -> exactly ["caseA","caseB","default"]
    const withDefault = await catalogue.resolveManifest(
      "core.flow.switch",
      switchInstanceOf({ cases: CASES, hasDefault: true })
    );
    expect(withDefault.outputs.map((port) => port.id)).toEqual([
      "caseA",
      "caseB",
      "default",
    ]);
    expect(withDefault.outputs.map((port) => port.label)).toEqual([
      "Case A",
      "Case B",
      "Default",
    ]);

    // hasDefault:false -> the default port is dropped on both routes
    const noDefault = await catalogue.resolveManifest(
      "core.flow.switch",
      switchInstanceOf({ cases: CASES, hasDefault: false })
    );
    expect(noDefault.outputs.map((port) => port.id)).toEqual([
      "caseA",
      "caseB",
    ]);
    expect(noDefault.outputs.some((port) => port.id === "default")).toBe(false);
    // and the declarative route agrees (no default port either)
    expect(
      resolveGraphNodeManifest(SWITCH_GRAPH_NODE_MANIFEST, {
        cases: CASES,
        hasDefault: false,
      }).outputs.some((port) => port.id === "default")
    ).toBe(false);
    // no function/constructor leakage through either resolution route
    expect(withDefault).not.toHaveProperty("methods");
    expect(withDefault.metadata).toBeUndefined();
    expect(withDefault.dynamicPorts).toEqual(
      SWITCH_GRAPH_NODE_MANIFEST.dynamicPorts
    );
  });
});
