/**
 * @module as-graph/tests/unit/graph/GraphNodeMethodRegistry.test
 * @summary Unit tests for the graph node method registry.
 * @description Validates the declared-graph-node-method registry of a graph
 * node kind: the method-declaration shape, implementation pairing,
 * declared-only and implemented-only rejection paths, declared-method
 * registration, and the sorted method declaration inventory.
 */
import { jest, describe, it, expect } from "@jest/globals";
import type { GraphNodeManifest } from "../../../src/shared/graph";
import {
  GraphNodeMethodNotFoundError,
  defineGraphNode,
  type GraphNodeMethod,
  type GraphNodeMethodRequest,
} from "../../../src";
import type { GraphNodeExecutor } from "../../../src/engine/execution/GraphNodeExecutor";
import { freshCatalogue } from "./engine-fixtures";

function executorOf(): GraphNodeExecutor {
  return { execute: jest.fn(async (): Promise<Record<string, unknown>> => ({})) };
}

function manifestWithMethods(
  declared: GraphNodeMethodManifest[],
  overrides: Partial<GraphNodeManifest> = {}
): GraphNodeManifest {
  const kind = overrides["kind"] ?? "test.method.manifest";
  return {
    kind,
    display: { name: kind, category: "Utility" },
    inputs: [],
    outputs: [],
    parameters: [],
    ...overrides,
    methods: declared,
  };
}

describe("GraphNodeMethodRegistry", () => {
  it("declares methods with the declared/implementation inventory of a manifest and the executor registry", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestWithMethods([
      { name: "test.action", type: "action" },
      { name: "test.options", type: "loadOptions" },
    ]);
    await catalogue.register(
      defineGraphNode({
        manifest,
        executor: executorOf(),
        methods: {
          "test.action": jest.fn<never, never>(),
          "test.options": jest.fn<never, never>(),
        },
      })
    );
    const declarations = await catalogue.listMethodDeclarations(
      "test.method.manifest"
    );
    expect(declarations.map((declaration) => declaration.name)).toEqual([
      "test.action",
      "test.options",
    ]);
    for (const declaration of declarations) {
      expect(declaration.type).toBe(declaration.name === "test.options" ? "loadOptions" : "action");
    }
  });

  it("rejects declared methods without matching implementations", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestWithMethods([{ name: "test.action", type: "action" }]);
    expect(() =>
      catalogue.register(defineGraphNode({ manifest, executor: executorOf() }))
    ).toThrow(
      "Kind 'test.method.manifest' declares method 'test.action' with no implementation"
    );
  });

  it("rejects method implementations that are not declared by the manifest", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestWithMethods([]);
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest,
          executor: executorOf(),
          methods: { undeclared: jest.fn() },
        })
      )
    ).toThrow(
      "Kind 'test.method.manifest' implements method 'undeclared' which is not declared by its manifest"
    );
  });

  it("rejects method implementations that are not functions", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestWithMethods(
      [{ name: "test.action", type: "action" }],
      {}
    );
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest,
          executor: executorOf(),
          methods: { "test.action": 42 as unknown as GraphNodeMethod },
        })
      )
    ).toThrow(
      "Method implementation 'test.action' for kind 'test.method.manifest' is not a function"
    );
  });

  it("duplicates declared methods that are already registered", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestWithMethods([
      { name: "test.action", type: "action" },
      { name: "test.action", type: "action" },
    ]);
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest,
          executor: executorOf(),
          methods: { "test.action": jest.fn<never, never>() },
        })
      )
    ).toThrow(
      "Kind 'test.method.manifest' declares duplicate method 'test.action'"
    );
  });

  it("registers a declared method only with a matching implementation", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestWithMethods([
      { name: "test.action", type: "action", parameter: "enabled" },
    ]);
    const method = jest.fn(
      async (
        request: GraphNodeMethodRequest,
        context: { requestContext?: unknown }
      ): Promise<Record<string, unknown>> => {
        return {
          ...request,
          ...context,
        };
      }
    );
    await catalogue.register(
      defineGraphNode({ manifest, executor: executorOf(), methods: { "test.action": method } })
    );
    const parameters = { enabled: true };
    const calledRequest = {
      kind: "test.method.manifest",
      method: "test.action",
      parameters,
    };
    const response = await method(calledRequest, { requestContext: undefined });
    expect(response).toStrictEqual({
      ...calledRequest,
      requestContext: undefined,
    });
    expect(method).toHaveBeenCalledTimes(1);
    expect(
      (await catalogue.getMethodDeclaration("test.method.manifest", "test.action"))
        .parameter
    ).toBe("enabled");
  });

  it("resolves a declared method implementation with GraphNodeMethodNotFoundError for an undeclared method", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestWithMethods([
      { name: "test.action", type: "action" },
    ]);
    await catalogue.register(
      defineGraphNode({
        manifest,
        executor: executorOf(),
        methods: { "test.action": jest.fn<never, never>() },
      })
    );
    expect(() =>
      catalogue.getMethodDeclaration("test.method.manifest", "wrong.method")
    ).toThrow(
      new GraphNodeMethodNotFoundError(
        "Kind 'test.method.manifest' does not declare method 'wrong.method'"
      )
    );
  });

  it("lists method declarations sorted by name", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestWithMethods([
      { name: "test.action", type: "action" },
      { name: "test.load-options", type: "loadOptions" },
      { name: "test.action-a", type: "action" },
    ]);
    await catalogue.register(
      defineGraphNode({
        manifest,
        executor: executorOf(),
        methods: {
          "test.action": jest.fn<never, never>(),
          "test.load-options": jest.fn<never, never>(),
          "test.action-a": jest.fn<never, never>(),
        },
      })
    );
    expect(
      (await catalogue.listMethodDeclarations("test.method.manifest")).map(
        (a) => a.name
      )
    ).toEqual(["test.action", "test.action-a", "test.load-options"]);
  });
});
