/**
 * @module as-graph/tests/unit/graph/GraphBuiltInRegistrations.test
 * @summary Unit tests for the built-in graph node registrations.
 * @description Validates the 127 built-in kinds as manifest+executor pairs,
 * the built-in catalogue registration with and without an engine, the built-in
 * visual-family conformance proofs against the DECAF-32 §21 visual contract /
 * §22.2 node-kind taxonomy (categories, colors, icons and the §21.8.2
 * category-style registry), and the built-in serializability of the
 * catalogue's built-in manifests and listManifests digest stability.
 */
import { jest, describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
 * The manifest icon overlays the SAA-836 M6 channel/voice kinds declare: the
 * channel trigger/response kinds carry their platform supplier icon and the
 * voice kind carries the speaker icon, while every other Agent-family kind
 * keeps the family robot icon.
 */
/**
 * SAA-1027 Stage 3b: the new IO kinds carry their vendor brand colours instead
 * of the IO category base colour, while the IO category style stays registered
 * for palette grouping.
 */
const GRAPH_3B_BRAND_IO_COLORS: Record<string, string> = {
  "core.io.googleSheets": "#0f9d58",
  "core.io.airtable": "#fcb400",
  "core.io.graphql": "#e10098",
  "core.io.spreadsheetFile": "#217346",
  "core.io.microsoftExcel": "#217346",
  "core.io.confluence": "#0052cc",
  "core.io.jira": "#0052cc",
  "core.io.googleDocs": "#4285f4",
  "core.io.microsoftSharePoint": "#036c70",
  "core.io.googleCalendar": "#4285f4",
};

const GRAPH_M6_AGENT_SUPPLIER_ICONS: Record<string, string> = {
  "core.agent.trigger.slack": "ti-brand-slack",
  "core.agent.trigger.discord": "ti-brand-discord",
  "core.agent.trigger.telegram": "ti-brand-telegram",
  "core.agent.trigger.teams": "ti-brand-teams",
  "core.agent.response.slack": "ti-brand-slack",
  "core.agent.response.discord": "ti-brand-discord",
  "core.agent.response.telegram": "ti-brand-telegram",
  "core.agent.response.teams": "ti-brand-teams",
  "core.agent.voice": "ti-volume-2",
};

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
    expect(Object.keys(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND).length).toBe(127);
    for (const manifest of GRAPH_BUILT_IN_NODE_MANIFESTS) {
      expect(await catalogue.has(manifest.kind)).toBe(true);
      expect(await catalogue.getManifest(manifest.kind)).toStrictEqual(manifest);
      expect(await catalogue.getExecutor(manifest.kind)).toBeDefined();
      expect((await catalogue.getExecutor(manifest.kind)).execute).toBeInstanceOf(
        Function
      );
    }
    expect(catalogue.size).toBe(127);
  });

  it("registers every built-in kind through registerBuiltInGraphNodes and re-registers them through registerEngineBoundGraphNodes with replace:true", async () => {
    const catalogue = freshCatalogue();
    // registerBuiltInGraphNodes registers all 127 built-ins with no engine
    // argument: each executor is derived from the node class's static execute.
    await registerBuiltInGraphNodes(catalogue);
    expect(catalogue.size).toBe(127);
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
    expect(catalogue.size).toBe(127);
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
      "core.data.dateTime",
      "core.data.dataTable",
      "core.data.filter",
      "core.data.limit",
      "core.data.merge",
      "core.data.renameKeys",
      "core.data.set",
      "core.data.sort",
      "core.data.splitOut",
      "core.data.aggregate",
      "core.data.itemLists",
      "core.data.compareDatasets",
      "core.data.summarize",
      "core.data.removeDuplicates",
      "core.io.extractFromFile",
      "core.io.httpRequest",
      "core.io.readPDF",
      "core.io.readWriteFile",
      "core.storage.postgres",
      "core.storage.mySql",
      "core.storage.microsoftSql",
      "core.storage.redis",
      "core.storage.rabbitmq",
      "core.storage.s3",
      "core.storage.awsS3",
      "core.storage.googleCloudStorage",
      "core.storage.azureStorage",
      "core.devops.crypto",
      "core.devops.jwt",
      "core.devops.executeCommand",
      "core.devops.ftp",
      "core.devops.github",
      "core.devops.gitlab",
      "core.comms.slack",
      "core.comms.telegram",
      "core.comms.teams",
      "core.comms.gmail",
      "core.comms.emailSend",
      "core.comms.discord",
      "core.comms.whatsApp",
      "core.comms.microsoftOutlook",
      "core.io.googleSheets",
      "core.io.airtable",
      "core.io.graphql",
      "core.io.microsoftExcel",
      "core.io.confluence",
      "core.io.jira",
      "core.io.googleDocs",
      "core.io.microsoftSharePoint",
      "core.io.googleCalendar",
      "core.io.spreadsheetFile",
      "core.io.convertToFile",
      "core.io.html",
      "core.io.htmlExtract",
      "core.io.markdown",
      "core.io.xml",
      "core.io.readBinaryFile",
      "core.io.readBinaryFiles",
      "core.io.writeBinaryFile",
      "core.io.respondToWebhook",
      "core.flow.executeSubWorkflow",
      "core.trigger.executeWorkflow",
      "core.trigger.error",
      "core.trigger.workflow",
      "core.trigger.rabbitmq",
      "core.trigger.redis",
      "core.trigger.sse",
      "core.trigger.postgres",
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
      "core.agent.tool",
      "core.agent.toolSelector",
      "core.agent.hook",
      "core.agent.toolDeny",
      "core.agent.delegationHook",
      "core.agent.skill",
      "core.agent.skillSelector",
      "core.agent.sandbox",
      "core.agent.scorer",
      "core.agent.scorerSelector",
      "core.agent.memory",
      "core.agent.memorySelector",
      "core.agent.embedding",
      "core.agent.vectorStore",
      "core.agent.retriever",
      "core.agent.chunking",
      "core.agent.rerank",
      "core.agent.chain.qa",
      "core.agent.chain.basic",
      "core.agent.chain.summarization",
      "core.agent.structuredOutputParser",
      "core.agent.informationExtractor",
      "core.agent.langchainCode",
      "core.agent.inputProcessor",
      "core.agent.outputProcessor",
      "core.agent.guardrail",
      "core.agent.hitl",
      "core.agent.trigger.mcp",
      "core.agent.trigger.slack",
      "core.agent.trigger.discord",
      "core.agent.trigger.telegram",
      "core.agent.trigger.teams",
      "core.agent.response.slack",
      "core.agent.response.discord",
      "core.agent.response.telegram",
      "core.agent.response.teams",
      "core.agent.voice",
      "core.loop.foreach",
      "core.loop.while",
      "core.loop.until",
    ]);
    for (const kind of Object.keys(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND)) {
      expect(GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[kind].kind).toBe(kind);
    }
  });

  it("publishes the SAA-1027 Stage 3b service-first kinds with their credential and i18n contract", async () => {
    interface I18nSection {
      name?: string;
      description?: string;
    }
    const i18n = JSON.parse(
      readFileSync(resolve(__dirname, "../../../assets/i18n/en.json"), "utf8")
    ) as {
      graph: {
        node: {
          categories: Record<string, string>;
          [category: string]:
            | Record<string, I18nSection>
            | Record<string, string>;
        };
      };
    };

    const cases: Array<{
      kind: string;
      category: "Comms" | "IO" | "DevOps" | "Storage" | "Trigger";
      credentialType?: string;
      i18n: [string, string];
    }> = [
      {
        kind: "core.devops.github",
        category: "DevOps",
        credentialType: "github",
        i18n: ["devops", "github"],
      },
      {
        kind: "core.devops.gitlab",
        category: "DevOps",
        credentialType: "gitlab",
        i18n: ["devops", "gitlab"],
      },
      {
        kind: "core.comms.slack",
        category: "Comms",
        credentialType: "slack",
        i18n: ["comms", "slack"],
      },
      {
        kind: "core.comms.telegram",
        category: "Comms",
        credentialType: "telegram",
        i18n: ["comms", "telegram"],
      },
      {
        kind: "core.comms.teams",
        category: "Comms",
        credentialType: "teams",
        i18n: ["comms", "teams"],
      },
      {
        kind: "core.comms.gmail",
        category: "Comms",
        credentialType: "gmail",
        i18n: ["comms", "gmail"],
      },
      {
        kind: "core.comms.emailSend",
        category: "Comms",
        credentialType: "email",
        i18n: ["comms", "email_send"],
      },
      {
        kind: "core.io.googleSheets",
        category: "IO",
        credentialType: "google-sheets",
        i18n: ["io", "google_sheets"],
      },
      {
        kind: "core.io.airtable",
        category: "IO",
        credentialType: "airtable",
        i18n: ["io", "airtable"],
      },
      {
        kind: "core.io.graphql",
        category: "IO",
        credentialType: "graphql",
        i18n: ["io", "graphql"],
      },
      {
        kind: "core.io.spreadsheetFile",
        category: "IO",
        i18n: ["io", "spreadsheet_file"],
      },
      {
        kind: "core.storage.rabbitmq",
        category: "Storage",
        credentialType: "rabbitmq",
        i18n: ["storage", "rabbitmq"],
      },
      {
        kind: "core.trigger.error",
        category: "Trigger",
        i18n: ["trigger", "error"],
      },
      {
        kind: "core.trigger.workflow",
        category: "Trigger",
        i18n: ["trigger", "workflow"],
      },
      {
        kind: "core.trigger.rabbitmq",
        category: "Trigger",
        credentialType: "rabbitmq",
        i18n: ["trigger", "rabbitmq"],
      },
      {
        kind: "core.trigger.redis",
        category: "Trigger",
        credentialType: "redis",
        i18n: ["trigger", "redis"],
      },
      {
        kind: "core.trigger.sse",
        category: "Trigger",
        credentialType: "token",
        i18n: ["trigger", "sse"],
      },
      {
        kind: "core.trigger.postgres",
        category: "Trigger",
        credentialType: "postgres",
        i18n: ["trigger", "postgres"],
      },
    ];

    expect(cases).toHaveLength(18);
    expect(i18n.graph.node.categories).toMatchObject({
      comms: "Comms",
      io: "IO",
      devops: "DevOps",
      storage: "Storage",
      trigger: "Trigger",
    });

    const catalogue = await buildBuiltInCatalogue();
    for (const entry of cases) {
      const manifest = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[entry.kind];
      expect(manifest).toBeDefined();
      expect(manifest.display.category).toBe(entry.category);
      expect(await catalogue.has(entry.kind)).toBe(true);
      expect((await catalogue.getExecutor(entry.kind)).execute).toBeInstanceOf(
        Function
      );

      if (entry.credentialType) {
        expect(manifest.credentials).toEqual(
          expect.arrayContaining([
            { type: entry.credentialType, required: false },
          ])
        );
        const credentialParameter = manifest.parameters.find(
          (parameter) => parameter.id === "credentialRef"
        );
        expect(credentialParameter).toMatchObject({
          type: "credential",
          required: false,
          credentialType: entry.credentialType,
        });
      } else {
        expect(manifest.credentials ?? []).toHaveLength(0);
        expect(
          manifest.parameters.some(
            (parameter) => parameter.id === "credentialRef"
          )
        ).toBe(false);
      }

      const [category, section] = entry.i18n;
      const i18nSection = i18n.graph.node[category]?.[section] as
        | I18nSection
        | undefined;
      expect(i18nSection).toBeDefined();
      expect(typeof i18nSection?.name).toBe("string");
      expect(i18nSection?.name?.length).toBeGreaterThan(0);
      expect(typeof i18nSection?.description).toBe("string");
      expect(i18nSection?.description?.length).toBeGreaterThan(0);
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
      "Data",
      "IO",
      "Storage",
      "DevOps",
      "Comms",
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
    expect(registrations.length).toBe(127);
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
      "Data",
      "IO",
      "Storage",
      "DevOps",
      "Comms",
    ] as const;
    for (const manifest of GRAPH_BUILT_IN_NODE_MANIFESTS) {
      const family = manifest.display.category;
      expect(families.includes(family as never)).toBe(true);
      expect(manifest.display.labels?.at(0)).toBe(
        family === "Boundary"
          ? "workflow"
          : family === "Data"
            ? "data"
            : family === "IO"
              ? "io"
              : family === "Storage"
                ? "storage"
                : family === "DevOps"
                  ? "devops"
                  : family === "Comms"
                    ? "comms"
                    : manifest.kind.startsWith("core.trigger.")
                ? "trigger"
                : manifest.kind.startsWith("core.utility.")
                  ? "utility"
                  : family === "Agent"
                    ? "agent"
                    : manifest.kind.startsWith("core.loop.")
                      ? "loop"
                      : "flow"
      );
      if (family === "Agent") {
        // the Agent family omits color/icon on @node(); the display is
        // resolved from the registered "Agent" category style instead
        expect(manifest.display.color).toBeUndefined();
        // SAA-836 M6: the channel trigger/response kinds carry their platform
        // supplier icon and the voice kind carries the speaker icon via
        // manifest icon overlays; every other Agent kind keeps the family
        // robot icon.
        expect(manifest.display.icon?.name).toBe(
          GRAPH_M6_AGENT_SUPPLIER_ICONS[manifest.kind] ?? "ti-robot"
        );
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
      } else if (
        family === "Storage" ||
        family === "DevOps" ||
        family === "Comms"
      ) {
        // SAA-1027 Stage 3a/3b: the Storage/DevOps/Comms families carry
        // intentional per-kind brand colours (postgres/mysql/redis/s3/azure/gcs,
        // crypto/jwt/execute/ftp, and slack/telegram/teams/gmail/email), while
        // the family category style stays registered for palette grouping.
        expect(manifest.display.color).toMatch(/^#[0-9a-f]{6}$/);
        expect(graphCategoryStyleOf(family).color).toBeTruthy();
        expect(manifest.display.icon?.type).toBe("catalogue");
        expect((manifest.display.icon as { name?: string }).name).toMatch(
          /^ti-[a-z0-9-]+$/
        );
      } else if (
        family === "IO" &&
        GRAPH_3B_BRAND_IO_COLORS[manifest.kind]
      ) {
        // SAA-1027 Stage 3b: the new IO kinds carry their vendor brand colour
        // while the IO category style stays registered for palette grouping.
        expect(manifest.display.color).toBe(
          GRAPH_3B_BRAND_IO_COLORS[manifest.kind]
        );
        expect(graphCategoryStyleOf(family).color).toBeTruthy();
        expect(manifest.display.icon?.type).toBe("catalogue");
        expect((manifest.display.icon as { name?: string }).name).toMatch(
          /^ti-[a-z0-9-]+$/
        );
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
    expect(graphCategoryStyleOf("Data")).toEqual({
      color: "#8b5cf6",
      icon: "ti-table",
    });
    expect(graphCategoryStyleOf("IO")).toEqual({
      color: "#0ea5e9",
      icon: "ti-world-www",
    });
    expect(graphCategoryStyleOf("Storage")).toEqual({
      color: "#0f766e",
      icon: "ti-database",
    });
    expect(graphCategoryStyleOf("DevOps")).toEqual({
      color: "#475569",
      icon: "ti-terminal-2",
    });
    expect(graphCategoryStyleOf("Comms")).toEqual({
      color: "#d946ef",
      icon: "ti-message-circle",
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
      if (family === "Agent") {
        // §22.2.4: the Agent family omits @node() color/icon — both resolve
        // through the registered "Agent" category style
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
      } else if (
        family === "Storage" ||
        family === "DevOps" ||
        family === "Comms"
      ) {
        // SAA-1027 Stage 3a/3b: the Storage/DevOps/Comms kinds declare per-kind
        // brand colours; the family category style remains registered for
        // grouping and palette fallback.
        expect(manifest.display.color).toMatch(/^#[0-9a-f]{6}$/);
        expect(graphCategoryStyleOf(family).color).toBeTruthy();
        expect(manifest.display.icon?.type).toBe("catalogue");
        expect(manifest.display.icon?.name).toMatch(/^ti-[a-z0-9-]+$/);
      } else if (
        family === "IO" &&
        GRAPH_3B_BRAND_IO_COLORS[manifest.kind]
      ) {
        // SAA-1027 Stage 3b: the new IO kinds carry their vendor brand colour
        // while the IO category style stays registered for palette grouping.
        expect(manifest.display.color).toBe(
          GRAPH_3B_BRAND_IO_COLORS[manifest.kind]
        );
        expect(graphCategoryStyleOf(family).color).toBeTruthy();
        expect(manifest.display.icon?.type).toBe("catalogue");
        expect(manifest.display.icon?.name).toMatch(/^ti-[a-z0-9-]+$/);
      } else {
        // D7/G3-22: the manifest display is the single authority for the
        // category base colour — every node of a category shares it.
        expect(manifest.display.color).toBe(graphCategoryStyleOf(family).color);
        expect(manifest.display.icon?.type).toBe("catalogue");
        expect(manifest.display.icon?.name).toMatch(/^ti-[a-z0-9-]+$/);
      }
    }
    // the 127 built-ins present exactly these eleven families
    expect([...families].sort()).toEqual([
      "Agent",
      "Boundary",
      "Comms",
      "Data",
      "DevOps",
      "Flow Control",
      "IO",
      "Loop",
      "Storage",
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
