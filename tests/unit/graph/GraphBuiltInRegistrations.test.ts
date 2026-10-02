/**
 * @module as-graph/tests/unit/graph/GraphBuiltInRegistrations.test
 * @summary Unit tests for the built-in graph node registrations.
 * @description Validates the 20 built-in kinds as manifest+executor pairs,
 * the built-in catalogue registration with and without an engine, the built-in
 * visual-family conformance proofs against the DECAF-32 §21 visual contract /
 * §22.2 node-kind taxonomy (categories, colors, icons and the §21.8.2
 * category-style registry), and the built-in serializability of the
 * catalogue's built-in manifests and listManifests digest stability.
 */
import { jest, describe, it, expect } from "@jest/globals";
import {
  graphCategoryStyleOf,
  graphDefinitionOf,
  isGraphJsonSafeValue,
  resolveEffectiveColor,
  resolveEffectiveIcon,
} from "../../../src/shared/graph";
import {
  GraphExecutionEngine,
  GraphExecutionContext,
  GraphNodeCatalogue,
  GraphNodeRegistrationError,
  builtInGraphNodeRegistrations,
  defineGraphNode,
  registerBuiltInGraphNodes,
} from "../../../src";
import {
  AgentNode,
  GRAPH_FLOW_CONTROL_NODES,
  GRAPH_UTILITY_NODES,
  GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND,
  GRAPH_BUILT_IN_NODE_MANIFESTS,
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND,
  LogFlowNode,
} from "../../../src/node";
import { registerEngineBoundGraphNodes } from "../../../src/nest/graph";
import { freshCatalogue, nodeExecutionRequest } from "./engine-fixtures";

jest.setTimeout(30000);

/**
 * Runs {@link registerBuiltInGraphNodes} for a fresh catalogue and returns the
 * catalogue.
 */
async function buildBuiltInCatalogue(): Promise<GraphNodeCatalogue> {
  const catalogue = freshCatalogue();
  await registerBuiltInGraphNodes(catalogue);
  return catalogue;
}

describe("GraphBuiltInRegistrations", () => {
  it("resolves each built-in kind's manifest+executor conformance pair", async () => {
    const catalogue = await buildBuiltInCatalogue();
    expect(Object.keys(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND).length).toBe(22);
    for (const manifest of GRAPH_BUILT_IN_NODE_MANIFESTS) {
      expect(await catalogue.has(manifest.kind)).toBe(true);
      expect(await catalogue.getManifest(manifest.kind)).toStrictEqual(manifest);
      expect(await catalogue.getExecutor(manifest.kind)).toBeDefined();
      expect((await catalogue.getExecutor(manifest.kind)).execute).toBeInstanceOf(
        Function
      );
    }
    expect(catalogue.size).toBe(22);
  });

  it("registers every built-in kind through registerBuiltInGraphNodes and re-registers them through registerEngineBoundGraphNodes with replace:true", async () => {
    const catalogue = freshCatalogue();
    // registerBuiltInGraphNodes registers all 22 built-ins with no engine
    // argument: each executor is derived from the node class's static execute.
    await registerBuiltInGraphNodes(catalogue);
    expect(catalogue.size).toBe(22);
    for (const kind of Object.keys(GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND)) {
      expect(await catalogue.has(kind)).toBe(true);
      expect((await catalogue.getManifest(kind)).kind).toBe(kind);
      expect((await catalogue.getExecutor(kind)).execute).toBeInstanceOf(Function);
    }

    // a built-in kind re-registered without the explicit replacement policy
    // is rejected
    const foreachManifest = await catalogue.getManifest("core.loop.foreach");
    expect(() =>
      catalogue.register(
        defineGraphNode({
          manifest: foreachManifest,
          executor: { execute: async () => ({}) },
        })
      )
    ).toThrow(GraphNodeRegistrationError);

    // registerEngineBoundGraphNodes re-registers the full built-in set with the
    // explicit replace:true policy (the engine argument is retained for
    // call-site compatibility; node classes reach the engine via the context)
    const engine = new GraphExecutionEngine();
    await expect(
      registerEngineBoundGraphNodes(catalogue, engine)
    ).resolves.toBeDefined();
    expect(catalogue.size).toBe(22);
  });

  it("drives a built-in node through its registered executor and the node class's instance execute", async () => {
    const catalogue = await buildBuiltInCatalogue();
    const node = {
      id: "log-node",
      kind: "core.flow.log",
      parameters: { level: "info" },
    };
    const document = {
      id: "wf",
      name: "wf",
      inputs: [],
      outputs: [],
      nodes: [node],
      edges: [],
    };
    const emitted: unknown[] = [];
    const context = new GraphExecutionContext(
      "run-1",
      undefined,
      "wf",
      document,
      node,
      await catalogue.getManifest("core.flow.log"),
      ["log-node"],
      async (event) => {
        emitted.push(event);
      }
    );

    const result = await (
      await catalogue.getExecutor("core.flow.log")
    ).execute(nodeExecutionRequest({ value: "hello" }), context);

    expect(result).toEqual({ value: "hello" });
    // the registration delegates to the node class's own instance execute
    expect(LogFlowNode.prototype.execute).toBeInstanceOf(Function);
    expect(emitted.length).toBeGreaterThan(0);
  });

  it("resolves the built-in manifest kinds in the internal catalog inventory", () => {
    const builtIns = GRAPH_BUILT_IN_NODE_MANIFESTS.map((a) => a.kind);
    expect(builtIns).toEqual([
      "value",
      "result",
      "core.trigger.manual",
      "core.trigger.webhook",
      "core.trigger.schedule",
      "core.trigger.event",
      "core.trigger.form",
      "core.trigger.chat",
      "core.flow.if",
      "core.flow.switch",
      "core.utility.map",
      "core.flow.delay",
      "core.flow.errorBoundary",
      "core.flow.humanApproval",
      "core.utility.code",
      "core.flow.log",
      "core.utility.log",
      "core.flow.break",
      "core.agent",
      "core.loop.foreach",
      "core.loop.while",
      "core.loop.until",
    ]);
    for (const kind of Object.keys(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND)) {
      expect(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[kind].kind).toBe(kind);
    }
  });

  it("resolves the built-in node-kind display conformance for every built-in kind", () => {
    const builtInFamilies = [
      "Trigger",
      "Flow Control",
      "Utility",
      "Agent",
      "Loop",
      "Boundary",
    ] as const;
    for (const manifest of GRAPH_BUILT_IN_NODE_MANIFESTS) {
      expect(manifest.display.name).toBeTruthy();
      expect(typeof manifest.display.name).toBe("string");
      expect(
        builtInFamilies.includes(manifest.display.category as never)
      ).toBe(true);
      expect(isGraphJsonSafeValue(manifest)).toBe(true);
    }
  });

  it("declares the switch block parameter on core.flow.switch so UI-authored dual-shape documents validate (DECAF-50 §4.26 R4-4)", () => {
    const manifest = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND["core.flow.switch"];
    const ids = manifest.parameters.map((parameter) => parameter.id);
    expect(ids).toEqual(expect.arrayContaining(["cases", "hasDefault", "switch"]));
    const switchParameter = manifest.parameters.find(
      (parameter) => parameter.id === "switch"
    );
    expect(switchParameter?.type).toBe("object");
  });
});

describe("Global built-in exhaustive kind catalogue and visual conformance", () => {
  it("rejects re-registering a built-in kind and replaces the reject path with an explicit replacement policy", async () => {
    const registrations = builtInGraphNodeRegistrations();
    expect(registrations.length).toBe(22);
    const catalogue = await buildBuiltInCatalogue();
    expect(() => catalogue.register(registrations[0] as never)).toThrow(
      GraphNodeRegistrationError
    );
    expect(
      catalogue.register(registrations[0] as never, { replace: true })
    ).toBeDefined();
  });

  it("resolves the ALFRED-5 node kinds' visual family conformance for every built-in kind", () => {
    const families = [
      "Trigger",
      "Flow Control",
      "Utility",
      "Agent",
      "Loop",
      "Boundary",
    ] as const;
    for (const manifest of GRAPH_BUILT_IN_NODE_MANIFESTS) {
      const family = manifest.display.category;
      expect(families.includes(family as never)).toBe(true);
      expect(manifest.display.labels?.at(0)).toBe(
        family === "Boundary"
          ? "workflow"
          : manifest.kind.startsWith("core.trigger.")
            ? "trigger"
            : manifest.kind.startsWith("core.utility.")
              ? "utility"
              : manifest.kind === "core.agent"
                ? "agent"
                : manifest.kind.startsWith("core.loop.")
                  ? "loop"
                  : "flow"
      );
      if (manifest.kind === "core.agent") {
        // the Agent class omits color/icon on @node(); the display is
        // resolved from the registered "Agent" category style instead
        expect(manifest.display.color).toBeUndefined();
        expect(manifest.display.icon?.name).toBe("ti-robot");
      } else if (family === "Boundary") {
        // the Boundary family is not yet in the §21.8.2 category-style
        // registry, so each manifest carries an explicit color/icon while
        // `graphCategoryStyleOf("Boundary")` falls back to the default style.
        expect(manifest.display.color).toBe("#0f766e");
        expect(
          (manifest.display.icon as { name?: string }).name?.startsWith(
            "ti-circle-"
          )
        ).toBe(true);
      } else {
        // D7/G3-22: the manifest display colour is the category base
        // colour — same-category nodes never diverge.
        expect(manifest.display.color).toBe(graphCategoryStyleOf(family).color);
        expect(manifest.display.icon?.type).toBe("catalogue");
        expect(
          (manifest.display.icon as { name?: string }).name?.startsWith("ti")
        ).toBe(true);
      }
    }
  });

  it("asserts the ALFRED-5 taxonomy's visual family conformance across the built-in types", () => {
    const builtInKinds = Object.keys(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND);
    for (const ctor of [
      ...GRAPH_FLOW_CONTROL_NODES,
      ...GRAPH_UTILITY_NODES,
    ]) {
      const definition = graphDefinitionOf(ctor as never);
      const kind = definition.kind;
      if (!kind) continue; // some classes have no compiled kind
      const manifest = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[kind];
      expect(builtInKinds).toContain(kind);
      expect(manifest.display.category).toBe(definition.category);
      expect(manifest.display.labels).toEqual(definition.labels);
      expect(manifest.display.description).toBe(
        definition.graph?.["metadata"]?.["description"]
      );
      if (manifest.display.color !== undefined) {
        expect(manifest.display.color).toBe(definition.color);
      } else {
        // the Agent class omits both color and icon on @node(); the manifest
        // display color is resolved from the registered "Agent" category style
        expect(manifest.display.color).toBeUndefined();
        expect(
          resolveEffectiveColor(manifest.display.color, definition.category)
        ).toBe(graphCategoryStyleOf("Agent").color);
      }
    }
    // the Agent's own display conformance (no @node() color or icon)
    const agentDefinition = graphDefinitionOf(AgentNode);
    const agentManifest =
      GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[agentDefinition.kind as string];
    expect(agentManifest.display.category).toBe("Agent");
    expect(agentManifest.display.color).toBeUndefined();
    expect(agentManifest.display.icon?.name).toBe("ti-robot");
    expect(agentManifest.display.labels).toEqual(agentDefinition.labels);
    expect(agentManifest.display.description).toBe(
      agentDefinition.graph?.["metadata"]?.["description"]
    );
  });

  it("presents the built-in categories, colors and icons consistent per family with the DECAF-32 §21.8.2 registry and §21 display conformance", () => {
    // DECAF-32 §21.8.2 — the built-in node categories are registered with
    // these exact default styles; §21 display fields stay present per manifest.
    expect(graphCategoryStyleOf("Trigger")).toEqual({
      color: "#3b82f6",
      icon: "ti-bolt",
    });
    expect(graphCategoryStyleOf("Flow Control")).toEqual({
      color: "#f59e0b",
      icon: "ti-arrows-split-2",
    });
    expect(graphCategoryStyleOf("Utility")).toEqual({
      color: "#0d9488",
      icon: "ti-tool",
    });
    expect(graphCategoryStyleOf("Loop")).toEqual({
      color: "#eab308",
      icon: "ti-repeat",
    });
    expect(graphCategoryStyleOf("Agent")).toEqual({
      color: "#7c3aed",
      icon: "ti-robot",
    });
    expect(graphCategoryStyleOf("model")).toEqual({
      color: "#3b82f6",
      icon: "ti-cpu",
    });
    expect(graphCategoryStyleOf("memory")).toEqual({
      color: "#10b981",
      icon: "ti-database",
    });
    expect(graphCategoryStyleOf("workspace")).toEqual({
      color: "#f59e0b",
      icon: "ti-folder",
    });

    const families = new Set<string>();
    for (const manifest of GRAPH_BUILT_IN_NODE_MANIFESTS) {
      const family = manifest.display.category as string;
      families.add(family);
      expect(manifest.display.name).toBeTruthy();
      if (manifest.display.description) {
        expect(typeof manifest.display.description).toBe("string");
      }
      if (manifest.kind === "core.agent") {
        // §22.2.4: Agent omits @node() color/icon — both resolve through the
        // registered "Agent" category style
        expect(manifest.display.color).toBeUndefined();
        expect(
          resolveEffectiveColor(manifest.display.color, "Agent")
        ).toBe("#7c3aed");
        expect(
          resolveEffectiveIcon(
            manifest.display.icon?.name as unknown as string,
            "Agent"
          )
        ).toBe("ti-robot");
      } else if (family === "Boundary") {
        // the Boundary family has no §21.8.2 category-style registration yet,
        // so the manifest is the single authority for its explicit color/icon and
        // the category lookup falls back to the default style.
        expect(graphCategoryStyleOf("Boundary")).toEqual({
          color: "#64748b",
          icon: "ti-pointer",
        });
        expect(manifest.display.color).toBe("#0f766e");
        expect(manifest.display.icon?.name).toMatch(/^ti-circle-(plus|minus)$/);
      } else {
        // D7/G3-22: the manifest display is the single authority for the
        // category base colour — every node of a category shares it.
        expect(manifest.display.color).toBe(graphCategoryStyleOf(family).color);
        expect(manifest.display.icon?.type).toBe("catalogue");
        expect(manifest.display.icon?.name).toMatch(/^ti-[a-z0-9-]+$/);
      }
    }
    // the 22 built-ins present exactly these six families
    expect([...families].sort()).toEqual([
      "Agent",
      "Boundary",
      "Flow Control",
      "Loop",
      "Trigger",
      "Utility",
    ]);
  });

  it("keeps the listManifests kind-sorted digest stable across registration order and rebuilds", async () => {
    async function digestOf(
      catalogue: GraphNodeCatalogue
    ): Promise<string> {
      return JSON.stringify(await catalogue.listManifests());
    }
    // built-ins registered in declaration order (with an engine)
    const forward = await buildBuiltInCatalogue();
    // and in reverse order (no engine registration differences)
    const reversed = freshCatalogue();
    for (const manifest of [...GRAPH_BUILT_IN_NODE_MANIFESTS].reverse()) {
      await reversed.register(
        defineGraphNode({ manifest, executor: { execute: async () => ({}) } })
      );
    }
    expect(await digestOf(reversed)).toBe(await digestOf(forward));
    // repeated calls never mutate the digest
    expect(await digestOf(forward)).toBe(await digestOf(forward));
    // the digest encodes the strict kind-sorted order (§4.19 listManifests
    // determinism; the HTTP ETag sits on the same ordering)
    expect(
      (JSON.parse(await digestOf(forward)) as { kind: string }[]).map(
        (manifest) => manifest.kind
      )
    ).toEqual(Object.keys(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND).sort());
  });
});
