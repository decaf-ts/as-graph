/**
 * @module as-graph/tests/unit/graph/GraphPortManifestElement.test
 * @summary SAA-1649 evidence: backend `GraphPortManifest` carries the
 * serialized `@uielement` shape on `core.utility.code` so `GET /graph/node-types`
 * serves a port `element` field.
 * @description Asserts the exact `element` shape on the `code` input port of the
 * `CODE_GRAPH_NODE_MANIFEST` (`data`/`result` stay element-free), that the
 * catalogue listing and controller `GET /graph/node-types` serving paths preserve
 * it, that `resolveGraphNodeManifest`/`catalogue.resolveManifest` keep it and
 * stay JSON-safe, and that the live `core.utility.code` input element deep-equals
 * the `for-angular` fixture snapshot entry.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DecafRequestContext } from "@decaf-ts/for-nest";
import type { GraphNodeManifest } from "../../../src/shared/graph";
import { isGraphJsonSafeValue } from "../../../src/shared/graph";
import {
  GraphExecutionEngine,
  GraphNodeCatalogue,
  GraphNodeExecutorRegistry,
  registerBuiltInGraphNodes,
  resolveGraphNodeManifest,
} from "../../../src";
import { CODE_GRAPH_NODE_MANIFEST } from "../../../src/node";
import {
  GRAPH_CATALOGUE_CONTROLLER_OPTIONS,
  GraphNodeCatalogueController,
} from "../../../src/nest/graph";
import { GRAPH_BUILT_IN_NODE_MANIFEST_SNAPSHOT } from "../../../../for-angular/src/graph/catalog/GraphNodeManifestSnapshot";

const EXPECTED_ELEMENT = {
  tag: "code-editor",
  serialize: false,
  props: {
    label: "Code",
    placeholder: "// User-authored JS code",
    name: "code",
  },
};

function portOf(
  manifest: GraphNodeManifest,
  id: string,
  direction: "inputs" | "outputs"
) {
  return (manifest[direction] ?? []).find((port) => port.id === id);
}

describe("GraphPortManifest element serialization (unit)", () => {
  it("emits the exact element on the core.utility.code input port and none on data/result", () => {
    const code = portOf(CODE_GRAPH_NODE_MANIFEST, "code", "inputs");
    expect(code?.element).toEqual(EXPECTED_ELEMENT);
    expect(portOf(CODE_GRAPH_NODE_MANIFEST, "data", "inputs")).not.toHaveProperty(
      "element"
    );
    expect(portOf(CODE_GRAPH_NODE_MANIFEST, "result", "outputs")).not.toHaveProperty(
      "element"
    );
  });

  it("preserves element through the catalogue listing (GET /graph/node-types serving path)", () => {
    const catalogue = new GraphNodeCatalogue();
    const engine = new GraphExecutionEngine({
      registry: new GraphNodeExecutorRegistry(catalogue),
    });
    registerBuiltInGraphNodes(catalogue, engine);

    const listed = catalogue.listManifests().find((m) => m.kind === "core.utility.code");
    expect(listed?.inputs.find((port) => port.id === "code")?.element).toEqual(
      EXPECTED_ELEMENT
    );
  });

  it("preserves element through resolveGraphNodeManifest and catalogue.resolveManifest, JSON-safe", async () => {
    const catalogue = new GraphNodeCatalogue();
    const engine = new GraphExecutionEngine({
      registry: new GraphNodeExecutorRegistry(catalogue),
    });
    registerBuiltInGraphNodes(catalogue, engine);

    const direct = resolveGraphNodeManifest(CODE_GRAPH_NODE_MANIFEST, {});
    expect(direct.inputs.find((port) => port.id === "code")?.element).toEqual(
      EXPECTED_ELEMENT
    );
    expect(isGraphJsonSafeValue(direct)).toBe(true);

    const resolved = await catalogue.resolveManifest("core.utility.code", {
      id: "code-node",
      kind: "core.utility.code",
      parameters: {},
    });
    expect(resolved.inputs.find((port) => port.id === "code")?.element).toEqual(
      EXPECTED_ELEMENT
    );
    expect(isGraphJsonSafeValue(resolved)).toBe(true);
  });

  it("deep-equals the for-angular fixture core.utility.code input element", () => {
    const fixture = GRAPH_BUILT_IN_NODE_MANIFEST_SNAPSHOT.find(
      (manifest) => manifest.kind === "core.utility.code"
    );
    expect(fixture).toBeDefined();
    expect(portOf(fixture as GraphNodeManifest, "code", "inputs")?.element).toEqual(
      EXPECTED_ELEMENT
    );
    expect(portOf(CODE_GRAPH_NODE_MANIFEST, "code", "inputs")?.element).toEqual(
      portOf(fixture as GraphNodeManifest, "code", "inputs")?.element
    );
  });
});

describe("GraphNodeCatalogueController GET /graph/node-types (unit)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const catalogue = new GraphNodeCatalogue();
    const engine = new GraphExecutionEngine({
      registry: new GraphNodeExecutorRegistry(catalogue),
    });
    registerBuiltInGraphNodes(catalogue, engine);
    const moduleRef = await Test.createTestingModule({
      controllers: [GraphNodeCatalogueController],
      providers: [
        { provide: GraphNodeCatalogue, useValue: catalogue },
        {
          provide: GRAPH_CATALOGUE_CONTROLLER_OPTIONS,
          useValue: { auth: "optional" },
        },
        { provide: DecafRequestContext, useValue: { user: { id: "unit" } } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 20000);

  afterAll(async () => {
    try {
      await app.close();
    } catch {
      // already closed
    }
  }, 20000);

  it("serves the element on the core.utility.code port through the HTTP listing", async () => {
    const res = await request(app.getHttpServer()).get("/graph/node-types");
    expect(res.status).toBe(200);
    const manifests = res.body as GraphNodeManifest[];
    const codeManifest = manifests.find((m) => m.kind === "core.utility.code");
    expect(codeManifest).toBeDefined();
    expect(
      codeManifest?.inputs.find((port) => port.id === "code")?.element
    ).toEqual(EXPECTED_ELEMENT);
    expect(
      codeManifest?.inputs.find((port) => port.id === "data")
    ).not.toHaveProperty("element");
    expect(
      codeManifest?.outputs.find((port) => port.id === "result")
    ).not.toHaveProperty("element");
  });
});
