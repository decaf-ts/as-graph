/**
 * @module as-graph/tests/unit/graph/GraphNodeCatalogue.test
 * @summary Unit tests for the graph node catalogue (DECAF-50 §4.7).
 * @description Validates the strict manifest+executor pairing registry:
 * duplicate kinds, missing executors, empty kinds, function/constructor/
 * prototype-holed manifests, duplicate parameter ids, invalid `defaultMode`,
 * dynamic-port rules referencing missing parameters and malformed rule shapes
 * (togglePort without a port, empty rule parameter references), malformed
 * credential requirements, unknown kinds and undeclared methods,
 * method-declaration pairing, and the listManifests ordering/filtering.
 */
import { jest, describe, it, expect } from "@jest/globals";
import {
  GraphCatalogueQueryContext,
  type GraphJsonValue,
  type GraphNodeInstance,
  type GraphNodeManifest,
  type GraphNodeMethodManifest,
  type GraphPortManifest,
  type GraphResolvedNodeManifest,
} from "../../../src/shared/graph";
import {
  GraphNodeCatalogue,
  GraphNodeMethodNotFoundError,
  GraphNodeNotFoundError,
  GraphNodeRegistrationError,
  defineGraphNode,
  registerBuiltInGraphNodes,
  type GraphNodeMethod,
  type GraphNodeMethodRequest,
} from "../../../src";
import { GRAPH_BUILT_IN_NODE_MANIFESTS } from "../../../src/node";
import type { GraphNodeExecutor } from "../../../src/engine/execution/GraphNodeExecutor";
import { freshCatalogue } from "./engine-fixtures";

function manifestOf(
  kind: string,
  overrides: Partial<GraphNodeManifest> = {}
): GraphNodeManifest {
  return {
    kind,
    display: { name: kind, category: "Utility" },
    inputs: [],
    outputs: [],
    parameters: [],
    ...overrides,
  };
}

function portOf(
  id: string,
  direction: "input" | "output" | "connection"
): GraphPortManifest {
  return { id, label: id, direction };
}

function executorOf(): GraphNodeExecutor {
  return {
    execute: jest.fn(async (): Promise<Record<string, unknown>> => ({})),
  };
}

describe("GraphNodeCatalogue (unit)", () => {
  it("registers built-in graph node kinds as manifest+executor pairs", async () => {
    const catalogue = freshCatalogue();
    await registerBuiltInGraphNodes(catalogue);

    for (const manifest of GRAPH_BUILT_IN_NODE_MANIFESTS) {
      expect(await catalogue.has(manifest.kind)).toBe(true);
      const registered = await catalogue.getManifest(manifest.kind);
      expect(registered.kind).toBe(manifest.kind);
      expect((await catalogue.getExecutor(manifest.kind)).execute).toBeInstanceOf(
        Function
      );
    }
    expect(catalogue.size).toBe(GRAPH_BUILT_IN_NODE_MANIFESTS.length);
  });

  it("rejects the same graph node kind registered again without replace:true", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestOf("test.dup");
    await catalogue.register(defineGraphNode({ manifest, executor: executorOf() }));

    expect(() =>
      catalogue.register(defineGraphNode({ manifest, executor: executorOf() }))
    ).toThrow(GraphNodeRegistrationError);
  });

  it("replaces a registered graph node kind with an explicit replacement policy", async () => {
    const catalogue = freshCatalogue();
    await catalogue.register(
      defineGraphNode({
        manifest: manifestOf("test.replace", {
          display: { name: "First", category: "Utility" },
        }),
        executor: executorOf(),
      })
    );
    await catalogue.register(
      defineGraphNode({
        manifest: manifestOf("test.replace", {
          display: { name: "Second", category: "Utility" },
        }),
        executor: executorOf(),
      }),
      { replace: true }
    );
    expect((await catalogue.getManifest("test.replace")).display.name).toBe(
      "Second"
    );
  });

  it("rejects a graph node registration without an executor", async () => {
    const catalogue = freshCatalogue();
    expect(() =>
      catalogue.register({
        manifest: manifestOf("test.missing executor"),
      } as unknown as Parameters<GraphNodeCatalogue["register"]>[0])
    ).toThrow(GraphNodeRegistrationError);
  });

  it("rejects a graph node registration whose manifest kind is empty", async () => {
    const catalogue = freshCatalogue();
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf(""),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Graph node manifest kind is required and must be a non-empty string"
    );
  });

  it("rejects a graph node registration whose manifest kind is not a string", async () => {
    const catalogue = freshCatalogue();
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf(42 as unknown as string),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Graph node manifest kind is required and must be a non-empty string"
    );
  });

  it("rejects a manifest that carries a function or a class instance value", async () => {
    const catalogue = freshCatalogue();
    const executorFunction = () => ({});
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.function", {
            parameters: [
              { type: "string", id: "hook", value: executorFunction },
            ] as never,
          }),
          executor: executorOf(),
        })
      )
    ).toThrow("Manifest for kind 'test.function' is not JSON-serializable");

    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.date", {
            parameters: [{ type: "string", id: "when", value: new Date() }] as never,
          }),
          executor: executorOf(),
        })
      )
    ).toThrow("Manifest for kind 'test.date' is not JSON-serializable");
  });

  it("rejects a manifest that carries unsafe prototype object keys", async () => {
    for (const key of ["__proto__", "prototype", "constructor"]) {
      const metadata: Record<string, GraphJsonValue> = {};
      Object.defineProperty(metadata, key, {
        value: "manipulated",
        enumerable: true,
        writable: true,
        configurable: true,
      });

      const catalogue = freshCatalogue();
      expect(() =>
        catalogue.register(
          defineGraphNode({
            manifest: manifestOf(`test.unsafe.${key}`, { metadata }),
            executor: executorOf(),
          })
        )
      ).toThrow(
        `Manifest for kind 'test.unsafe.${key}' is not JSON-serializable`
      );
    }
  });

  it("rejects a manifest that carries a constructor (class) anywhere in the manifest", async () => {
    const catalogue = freshCatalogue();
    class FixtureReflectionNode {}
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.constructor", {
            metadata: { reflection: FixtureReflectionNode } as never,
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Manifest for kind 'test.constructor' is not JSON-serializable"
    );
  });

  it("rejects a manifest carrying a function nested deep inside structured metadata", async () => {
    const catalogue = freshCatalogue();
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.function.deep", {
            metadata: {
              deep: { segments: [{ hook: () => undefined }] },
            },
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Manifest for kind 'test.function.deep' is not JSON-serializable"
    );
  });

  it("rejects a manifest input port carrying a function in its port metadata", async () => {
    const catalogue = freshCatalogue();
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.function.port", {
            inputs: [
              {
                ...portOf("value", "input"),
                metadata: { hook: () => undefined } as never,
              },
            ],
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Manifest for kind 'test.function.port' is not JSON-serializable"
    );
  });

  it("rejects duplicate parameter ids and duplicate static port ids", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestOf("test.duplicate", {
      inputs: [portOf("value", "input"), portOf("value", "input")],
    });
    expect(() =>
      catalogue.register(defineGraphNode({ manifest, executor: executorOf() }))
    ).toThrow(
      "Manifest for kind 'test.duplicate' declares duplicate static input port id 'value'"
    );
    const manifestWithParameters = manifestOf("test.duplicate.params", {
      parameters: [
        { type: "string", id: "same", label: "First" },
        { type: "string", id: "same", label: "Second" },
      ],
    });
    expect(() =>
      catalogue.register(
        defineGraphNode({ manifest: manifestWithParameters, executor: executorOf() })
      )
    ).toThrow(
      "Manifest for kind 'test.duplicate.params' declares duplicate parameter id 'same'"
    );
  });

  it("rejects a manifest with an invalid defaultMode on a static port", async () => {
    const catalogue = freshCatalogue();
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.defaultMode", {
            inputs: [
              { ...portOf("value", "input"), defaultMode: "magic" as never },
            ],
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Manifest for kind 'test.defaultMode' declares invalid default binding mode 'magic' on input port 'value'"
    );
  });

  it("rejects dynamic-port rules referencing missing parameters", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestOf("test.dynamic", {
      dynamicPorts: [
        {
          type: "repeatFromParameter",
          parameter: "missingRuleParameter",
          direction: "output",
          portIdTemplate: "${id}",
          itemIdPath: "outputPort",
        },
      ],
    });
    expect(() =>
      catalogue.register(defineGraphNode({ manifest, executor: executorOf() }))
    ).toThrow(
      "Manifest for kind 'test.dynamic' has a dynamic-port rule referencing missing parameter 'missingRuleParameter'"
    );
  });

  it("rejects an invalid dynamic-port rule shape for togglePort and repeatFromParameter", async () => {
    const catalogue = freshCatalogue();
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.dynamic.invalid", {
            parameters: [
              {
                type: "boolean",
                id: "enabled",
                label: "Enabled",
                defaultValue: false,
              },
            ],
            dynamicPorts: [
              {
                type: "togglePort",
                parameter: "enabled",
                equals: false,
                port: { ...portOf("__proto__", "output"), label: "Default" },
              } as never,
            ],
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Manifest for kind 'test.dynamic.invalid' has a togglePort rule port with unsafe port id '__proto__'"
    );
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.dynamic.no-template", {
            parameters: [{ type: "collection", id: "cases", label: "Cases" }],
            dynamicPorts: [
              {
                type: "repeatFromParameter",
                parameter: "cases",
                direction: "output",
                itemIdPath: "outputPort",
              } as never,
            ],
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Manifest for kind 'test.dynamic.no-template' has a repeatFromParameter rule without a portIdTemplate"
    );
  });

  it("rejects a togglePort dynamic-port rule without a port", async () => {
    const catalogue = freshCatalogue();
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.dynamic.no-port", {
            parameters: [
              { type: "boolean", id: "hasDefault", label: "Has default" },
            ],
            dynamicPorts: [
              {
                type: "togglePort",
                parameter: "hasDefault",
                equals: true,
              } as never,
            ],
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Manifest for kind 'test.dynamic.no-port' has a togglePort rule without a port"
    );
  });

  it("rejects a dynamic-port rule whose parameter reference is empty", async () => {
    const catalogue = freshCatalogue();
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.dynamic.empty-parameter", {
            dynamicPorts: [
              {
                type: "repeatFromParameter",
                parameter: "",
                direction: "output",
                itemIdPath: "outputPort",
                portIdTemplate: "${id}",
              } as never,
            ],
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Manifest for kind 'test.dynamic.empty-parameter' has a dynamic-port rule without a parameter reference"
    );
  });

  it("rejects a malformed method declaration and a malformed credential requirement", async () => {
    const catalogue = freshCatalogue();
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.method", {
            methods: [{ type: "action" } as unknown as GraphNodeMethodManifest],
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Manifest for kind 'test.method' has a malformed method declaration"
    );

    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.credentials", {
            credentials: [{ required: true }] as never,
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Manifest for kind 'test.credentials' has a malformed credential requirement"
    );
  });

  it("reports unknown graph node kinds and undeclared graph node methods with the explicit not-found contract", async () => {
    const catalogue = freshCatalogue();
    await registerBuiltInGraphNodes(catalogue);
    try {
      await catalogue.getManifest("test.missing");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GraphNodeNotFoundError);
      expect((e as GraphNodeNotFoundError).constructor.name).toBe(
        "GraphNodeNotFoundError"
      );
      expect((e as GraphNodeNotFoundError).message).toContain(
        "No graph node kind 'test.missing' is registered in the catalogue"
      );
    }

    try {
      await catalogue.getMethodDeclaration("core.flow.if", "missing");
      expect.unreachable();
    } catch (testError) {
      expect(testError).toBeInstanceOf(GraphNodeMethodNotFoundError);
      expect((testError as GraphNodeMethodNotFoundError).name).toBe(
        "GraphNodeMethodNotFoundError"
      );
      expect((testError as GraphNodeMethodNotFoundError).message).toContain(
        "Kind 'core.flow.if' does not declare method 'missing'"
      );
    }
  });

  it("pairs manifest method declarations with executor implementations", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestOf("test.method", {
      methods: [{ name: "declare-first", type: "action" }],
    } as never);
    expect(() =>
      catalogue.register(defineGraphNode({ manifest, executor: executorOf() }))
    ).toThrow("declares method 'declare-first' with no implementation");

    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest,
          executor: executorOf(),
          methods: { undeclared: jest.fn<never, never>() },
        })
      )
    ).toThrow(
      "Kind 'test.method' implements method 'undeclared' which is not declared by its manifest"
    );

    const registryProbe: Record<string, GraphNodeMethod> = {
      "declare-first": jest.fn(
        async (request: GraphNodeMethodRequest): Promise<GraphJsonValue> => request
      ),
    };
    await catalogue.register(
      defineGraphNode({ manifest, executor: executorOf(), methods: registryProbe })
    );
    const manifestWithMethods = await catalogue.getManifest("test.method");
    expect(manifestWithMethods.methods?.map((a) => a.name)).toEqual([
      "declare-first",
    ]);
    const method = await catalogue.getMethod("test.method", "declare-first");
    expect(
      await method(
        { kind: "test.method", method: "declare-first", parameters: {} },
        {
          requestContext: undefined,
        }
      )
    ).toEqual({ kind: "test.method", method: "declare-first", parameters: {} });
  });

  it("lists the current graph node manifests sorted by kind", async () => {
    const catalogue = freshCatalogue();
    for (const kind of ["test.d", "test.b", "test.c", "test.a"]) {
      await catalogue.register(
        defineGraphNode({ manifest: manifestOf(kind), executor: executorOf() })
      );
    }
    expect((await catalogue.listManifests()).map((a) => a.kind)).toEqual([
      "test.a",
      "test.b",
      "test.c",
      "test.d",
    ]);
    // list order stability — the same order twice
    expect((await catalogue.listManifests()).map((a) => a.kind)).toEqual([
      "test.a",
      "test.b",
      "test.c",
      "test.d",
    ]);
  });

  it("filters listManifests by a category and a kinds list", async () => {
    const catalogue = freshCatalogue();
    for (const [kind, category] of [
      ["test.a", "Utility"],
      ["test.b", "No-Code"],
      ["test.c", "Data Store"],
      ["test.d", "Trigger"],
    ] as const) {
      await catalogue.register(
        defineGraphNode({
          manifest: manifestOf(kind, { display: { name: kind, category } }),
          executor: executorOf(),
        })
      );
    }
    const filter: GraphCatalogueQueryContext = {
      categories: ["Utility", "No-Code"],
    };
    const manifests = await catalogue.listManifests(filter);
    expect(manifests.map((m) => m.kind)).toEqual(["test.a", "test.b"]);

    // kinds filter returns exactly the requested manifests
    const byKinds = await catalogue.listManifests({ kinds: ["test.a"] });
    expect(byKinds.length).toBe(1);
    expect(byKinds[0]).toStrictEqual(await catalogue.getManifest("test.a"));
  });

  it("resolves a resolved manifest through the catalogue provider path when a provider returns a conforming resolved manifest", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestOf("test.resolved", {
      inputs: [portOf("value", "input")],
      outputs: [portOf("result", "output")],
      parameters: [{ type: "string", id: "value", label: "Value" }],
    });
    const provider = (
      instance: GraphNodeInstance
    ): GraphResolvedNodeManifest => ({
      kind: manifest.kind,
      display: manifest.display,
      inputs: manifest.inputs,
      outputs: [
        { ...portOf("result", "output"), label: instance.parameters.label },
      ],
      parameters: manifest.parameters,
    });
    await catalogue.register(
      defineGraphNode({
        manifest,
        executor: executorOf(),
        resolveManifest: provider,
      })
    );
    const resolved = await catalogue.resolveManifest(
      "test.resolved",
      {
        id: "n1",
        kind: "test.resolved",
        parameters: { label: "Resolved label" },
      },
      { requestContext: undefined }
    );
    expect(resolved.outputs[0].label).toBe("Resolved label");
    expect(resolved.kind).toBe("test.resolved");
    // identity conformance: the resolved copy is JSON-safe
    expect(resolved.metadata).toBeUndefined();
    expect(resolved.dynamicPorts).toBeUndefined();
  });

  it("rejects the catalogued resolved-manifest provider path when the provider returns a non-conforming resolved manifest", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestOf("test.resolved.conform", {
      display: { name: "Resolved title", category: "Utility" },
    });
    await catalogue.register(
      defineGraphNode({
        manifest,
        executor: executorOf(),
        resolveManifest: (): GraphResolvedNodeManifest => undefined as never,
      })
    );
    await expect(
      catalogue.resolveManifest(
        "test.resolved.conform",
        {
          id: "n1",
          kind: "test.resolved.conform",
          parameters: { value: "anything" },
        },
        { requestContext: undefined }
      )
    ).rejects.toThrow(
      "resolveManifest provider for kind 'test.resolved.conform' returned a value that does not conform to GraphResolvedNodeManifest"
    );
  });

  it("rejects the catalogued resolved-manifest provider path when the provider returns a non-JSON-safe resolved manifest", async () => {
    const catalogue = freshCatalogue();
    const manifest = manifestOf("test.resolved.json-safe", {
      display: { name: "Resolved title", category: "Utility" },
    });
    await catalogue.register(
      defineGraphNode({
        manifest,
        executor: executorOf(),
        resolveManifest: (): GraphResolvedNodeManifest => ({
          kind: manifest.kind,
          display: {
            ...manifest.display,
            name: (() => undefined) as unknown as string,
          },
          inputs: [],
          outputs: [],
          parameters: [],
        }),
      })
    );
    await expect(
      catalogue.resolveManifest(
        "test.resolved.json-safe",
        {
          id: "n1",
          kind: "test.resolved.json-safe",
          parameters: { value: "anything" },
        },
        { requestContext: undefined }
      )
    ).rejects.toThrow(
      "resolveManifest provider for kind 'test.resolved.json-safe' returned a non-JSON-safe resolved manifest"
    );
  });

  it("rejects unsafe prototype-polluted static port ids and parameter ids", async () => {
    const catalogue = freshCatalogue();
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.unsafe.inputPort", {
            inputs: [portOf("__proto__", "input")],
          }),
          executor: executorOf(),
        })
      )
    ).toThrow("has a input port with unsafe port id '__proto__'");
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.unsafe.outputPort", {
            outputs: [portOf("prototype", "output")],
          }),
          executor: executorOf(),
        })
      )
    ).toThrow("has a output port with unsafe port id 'prototype'");
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.unsafe.connectionPort", {
            connections: [portOf("constructor", "connection")],
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "has a connection port with unsafe port id 'constructor'"
    );
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.unsafe.parameter", {
            parameters: [
              { type: "string", id: "constructor", label: "Constructor" },
            ],
          }),
          executor: executorOf(),
        })
      )
    ).toThrow("has a parameter with unsafe id 'constructor'");
  });

  it("rejects malformed credential requirements (non-conforming shapes and empty declared types)", async () => {
    const catalogue = freshCatalogue();
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.credentials", {
            credentials: [{ required: true }] as never,
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Manifest for kind 'test.credentials' has a malformed credential requirement"
    );

    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.credentials.emptyType", {
            credentials: [{ type: "", required: true }] as never,
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Manifest for kind 'test.credentials.emptyType' has a credential requirement with an empty type"
    );
  });

  it("rejects duplicate static output and connection port ids the same way as duplicate input port ids", async () => {
    const catalogue = freshCatalogue();
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.duplicate.outputs", {
            outputs: [portOf("result", "output"), portOf("result", "output")],
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Manifest for kind 'test.duplicate.outputs' declares duplicate static output port id 'result'"
    );
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: manifestOf("test.duplicate.connections", {
            connections: [
              portOf("model", "connection"),
              portOf("model", "connection"),
            ],
          }),
          executor: executorOf(),
        })
      )
    ).toThrow(
      "Manifest for kind 'test.duplicate.connections' declares duplicate static connection port id 'model'"
    );
  });

  it("registers a graph node executor for a kind that has no manifest yet (placeholder manifest)", async () => {
    const catalogue = freshCatalogue();
    const executor = executorOf();
    await catalogue.registerExecutor("test.placeholder-executor", executor);
    const manifest = await catalogue.getManifest("test.placeholder-executor");
    expect(manifest.kind).toBe("test.placeholder-executor");
    expect(manifest.display).toStrictEqual({
      name: "test.placeholder-executor",
    });
    expect(manifest.inputs).toEqual([]);
    expect(manifest.outputs).toEqual([]);
    expect(manifest.parameters).toEqual([]);
    // the catalog lists the placeholder manifest too
    expect((await catalogue.listManifests()).map((m) => m.kind)).toContain(
      "test.placeholder-executor"
    );
  });
});
