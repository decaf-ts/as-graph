/**
 * @module as-graph/tests/unit/graph/GraphBuiltInPortSchemas.test
 * @summary SAA-1357 D1 regression: Decaf auto-injects built-in constructors
 * (`String`, `Number`, `Boolean`, `Array`, `Object`, `Date`) into
 * `TYPE.customTypes` for port properties. Those constructors must derive
 * primitive schemas, never `{type:"model", name:"String"}`.
 * @description Pins the `core.utility.code` `code` input port schema served by
 * `GET /graph/node-types` (`{type:"string"}`) and scans every built-in node
 * manifest so no built-in constructor leaks into a port schema as a model.
 */
import { describe, it, expect } from "@jest/globals";
import { GraphNodeCatalogue, registerBuiltInGraphNodes } from "../../../src";
import { GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND } from "../../../src/node";
import type { GraphNodeManifest } from "../../../src/shared/graph";
import { freshCatalogue } from "./engine-fixtures";

const BUILT_IN_CONSTRUCTOR_NAMES = new Set([
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Date",
]);

function builtInPortsOf(
  manifest: GraphNodeManifest
): Array<{ direction: "inputs" | "outputs"; port: GraphNodeManifest["inputs"][number] }> {
  return [
    ...(manifest.inputs ?? []).map((port) => ({ direction: "inputs" as const, port })),
    ...(manifest.outputs ?? []).map((port) => ({ direction: "outputs" as const, port })),
  ];
}

function builtInModelLeaks(manifest: GraphNodeManifest): string[] {
  return builtInPortsOf(manifest)
    .filter(
      ({ port }) =>
        port.schema?.type === "model" &&
        BUILT_IN_CONSTRUCTOR_NAMES.has(port.schema.name ?? "")
    )
    .map(({ direction, port }) => `${manifest.kind}.${direction}.${port.id}`);
}

describe("core.utility.code port schema (SAA-1357 D1)", () => {
  const manifest = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND["core.utility.code"];

  it("serves the code input port as a primitive string schema", () => {
    const code = manifest.inputs.find((port) => port.id === "code");
    expect(code).toBeDefined();
    expect(code?.schema).toEqual({ type: "string" });
    expect(code?.schema?.type).toBe("string");
  });

  it("keeps the code parameter on the code variant without a model schema", () => {
    const parameter = manifest.parameters.find((candidate) => candidate.id === "code");
    expect(parameter).toBeDefined();
    expect(parameter).not.toHaveProperty("schema");
    expect(parameter?.type).not.toBe("model");
  });

  it("keeps the code port schema through the catalogue listing (GET /graph/node-types path)", async () => {
    const catalogue: GraphNodeCatalogue = freshCatalogue();
    await registerBuiltInGraphNodes(catalogue);
    const listed = (await catalogue.listManifests()).find(
      (candidate) => candidate.kind === "core.utility.code"
    );
    expect(listed?.inputs.find((port) => port.id === "code")?.schema).toEqual({
      type: "string",
    });
  });
});

describe("built-in node port schemas (SAA-1357 D1)", () => {
  it("never derives a built-in constructor as a model schema", () => {
    const leaks = Object.values(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND).flatMap(
      (manifest) => builtInModelLeaks(manifest)
    );
    expect(leaks).toEqual([]);
  });

  it("derives every built-in code-editor code port as a string schema", () => {
    const codePorts = Object.values(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND)
      .flatMap((manifest) =>
        (manifest.inputs ?? []).map((port) => ({ kind: manifest.kind, port }))
      )
      .filter(({ port }) => port.element?.tag === "code-editor");
    expect(codePorts.length).toBeGreaterThan(0);
    for (const { kind, port } of codePorts) {
      expect({ kind, id: port.id, schema: port.schema }).toEqual({
        kind,
        id: port.id,
        schema: { type: "string" },
      });
    }
  });
});
