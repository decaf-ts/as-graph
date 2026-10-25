/**
 * @module as-graph/tests/unit/graph/nodes/Stage5cVendorNodes.test
 * @summary Unit coverage for the SAA-1450 Stage 5c curated SaaS vendor kinds.
 * @description Exercises the nine vendor node kinds through the production
 * instantiation contract (`executeNode`): manifest kind/category/ports and
 * optional `credentialRef`, credential resolution and type enforcement,
 * operation routing, every documented `GraphExecutionError` code, JSON/array
 * field parsing, and locale-key presence for every field label. No provider is
 * contacted: every case either fails before the transport call or fails closed
 * on a missing token, and the live request contract is covered by
 * `tests/integration/graph/nodes/vendors`.
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND,
  GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND,
  ConfluenceNode,
  DiscordNode,
  GoogleCalendarNode,
  GoogleDocsNode,
  JiraNode,
  MicrosoftExcelNode,
  MicrosoftOutlookNode,
  MicrosoftSharePointNode,
  WhatsAppNode,
} from "../../../../src/node";
import type { GraphNodeClass } from "../../../../src/node/base";
import type { GraphExecutionEngine } from "../../../../src/engine/execution/GraphExecutionEngine";
import {
  GraphNodeCredentialResolver,
  resolveNodeCredential,
  type GraphNodeCredentialSecret,
} from "../../../../src/engine/credentials/GraphNodeCredentials";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

jest.setTimeout(30_000);

/** A manifest + credential/i18n expectation for one Stage 5c vendor kind. */
interface VendorContract {
  kind: string;
  nodeClass: GraphNodeClass;
  category: "Comms" | "IO";
  credentialType: string;
  i18n: [string, string];
  inputs: string[];
  outputs: string[];
}

const CONTRACTS: VendorContract[] = [
  {
    kind: "core.comms.discord",
    nodeClass: DiscordNode,
    category: "Comms",
    credentialType: "discord",
    i18n: ["comms", "discord"],
    inputs: [
      "operation",
      "channelId",
      "guildId",
      "messageId",
      "content",
      "embeds",
      "tts",
      "name",
      "channelType",
      "topic",
      "parentId",
      "emoji",
      "limit",
      "before",
      "baseUrl",
    ],
    outputs: ["result", "channelId", "messageId"],
  },
  {
    kind: "core.comms.whatsApp",
    nodeClass: WhatsAppNode,
    category: "Comms",
    credentialType: "whatsapp",
    i18n: ["comms", "whatsapp"],
    inputs: [
      "operation",
      "phoneNumberId",
      "to",
      "text",
      "previewUrl",
      "templateName",
      "languageCode",
      "components",
      "mediaType",
      "mediaId",
      "mediaUrl",
      "caption",
      "filename",
      "messageId",
      "baseUrl",
    ],
    outputs: ["result", "messageId"],
  },
  {
    kind: "core.comms.microsoftOutlook",
    nodeClass: MicrosoftOutlookNode,
    category: "Comms",
    credentialType: "microsoft-outlook",
    i18n: ["comms", "microsoft_outlook"],
    inputs: [
      "operation",
      "to",
      "cc",
      "bcc",
      "subject",
      "body",
      "contentType",
      "saveToSentItems",
      "folderId",
      "messageId",
      "eventId",
      "start",
      "end",
      "timeZone",
      "location",
      "attendees",
      "top",
      "filter",
      "search",
      "baseUrl",
    ],
    outputs: ["result", "messageId", "eventId"],
  },
  {
    kind: "core.io.microsoftExcel",
    nodeClass: MicrosoftExcelNode,
    category: "IO",
    credentialType: "microsoft-excel",
    i18n: ["io", "microsoft_excel"],
    inputs: [
      "operation",
      "itemId",
      "driveId",
      "worksheet",
      "range",
      "values",
      "tableId",
      "baseUrl",
    ],
    outputs: ["result"],
  },
  {
    kind: "core.io.confluence",
    nodeClass: ConfluenceNode,
    category: "IO",
    credentialType: "confluence",
    i18n: ["io", "confluence"],
    inputs: [
      "operation",
      "pageId",
      "spaceKey",
      "title",
      "body",
      "parentId",
      "version",
      "cql",
      "limit",
      "baseUrl",
    ],
    outputs: ["result"],
  },
  {
    kind: "core.io.jira",
    nodeClass: JiraNode,
    category: "IO",
    credentialType: "jira",
    i18n: ["io", "jira"],
    inputs: [
      "operation",
      "projectKey",
      "issueType",
      "summary",
      "description",
      "issueKey",
      "fields",
      "comment",
      "transitionId",
      "jql",
      "maxResults",
      "baseUrl",
    ],
    outputs: ["result", "issueKey"],
  },
  {
    kind: "core.io.googleDocs",
    nodeClass: GoogleDocsNode,
    category: "IO",
    credentialType: "google-docs",
    i18n: ["io", "google_docs"],
    inputs: [
      "operation",
      "documentId",
      "title",
      "text",
      "findText",
      "replaceText",
      "matchCase",
      "requests",
      "baseUrl",
    ],
    outputs: ["result", "documentId"],
  },
  {
    kind: "core.io.microsoftSharePoint",
    nodeClass: MicrosoftSharePointNode,
    category: "IO",
    credentialType: "microsoft-sharepoint",
    i18n: ["io", "microsoft_sharepoint"],
    inputs: [
      "operation",
      "siteId",
      "listId",
      "itemId",
      "search",
      "top",
      "filter",
      "fields",
      "baseUrl",
    ],
    outputs: ["result"],
  },
  {
    kind: "core.io.googleCalendar",
    nodeClass: GoogleCalendarNode,
    category: "IO",
    credentialType: "google-calendar",
    i18n: ["io", "google_calendar"],
    inputs: [
      "operation",
      "calendarId",
      "eventId",
      "summary",
      "description",
      "location",
      "start",
      "end",
      "timeZone",
      "attendees",
      "timeMin",
      "timeMax",
      "maxResults",
      "q",
      "singleEvents",
      "baseUrl",
    ],
    outputs: ["result", "eventId"],
  },
];

/** The English locale catalogue the manifests' locale keys resolve against. */
const I18N = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../assets/i18n/en.json"), "utf8")
) as Record<string, unknown>;

/** Resolves a dotted locale key against the English catalogue. */
function i18nValue(key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (value, part) =>
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[part]
          : undefined,
      I18N
    );
}

/** A credential secret registered in the test-only in-memory resolver. */
interface RegisteredSecret {
  credentialType: string;
  secret: GraphNodeCredentialSecret;
}

const SECRETS = new Map<string, RegisteredSecret>();

/** Registers a credential secret for the ctx-bound resolver. */
function registerSecret(
  credentialId: string,
  credentialType: string,
  secret: GraphNodeCredentialSecret
): string {
  SECRETS.set(credentialId, { credentialType, secret });
  return credentialId;
}

/** Builds the ctx-bound resolver over the unit secret registry. */
function unitResolver(): GraphNodeCredentialResolver {
  return new GraphNodeCredentialResolver({
    credentialService: {
      getCredential: async (credentialId: string) => {
        const entry = SECRETS.get(credentialId);
        if (!entry) throw new Error(`credential '${credentialId}' is missing`);
        return {
          id: credentialId,
          name: credentialId,
          credentialType: entry.credentialType,
          secretName: credentialId,
          provider: "model",
          enabled: true,
          expiresAt: null,
        };
      },
      markCredentialUsed: async () => undefined,
    },
    modelSecretService: {
      provider: "model",
      retrieve: async (nameOrRef: string) => SECRETS.get(nameOrRef)?.secret,
    },
  });
}

/** A fake engine exposing only the credential resolver the nodes consume. */
function engineWithResolver(): GraphExecutionEngine {
  return {
    nodeCredentials: unitResolver(),
  } as unknown as GraphExecutionEngine;
}

/** A valid credential reference under the node's `credentialRef` handle. */
function reference(credentialId: string, credentialType: string) {
  return { credentialRef: { credentialId, credentialType } };
}

/** Runs a call and returns its `graphCode`, or the thrown message when uncoded. */
async function graphCodeOf(run: () => unknown): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as { graphCode?: string }).graphCode;
  }
  return undefined;
}

/** A parameters record with the loopback guard base URL. */
function base(extra: Record<string, unknown>): Record<string, unknown> {
  return { baseUrl: "http://127.0.0.1:1", ...extra };
}

describe("Stage 5c vendor nodes — manifest contract", () => {
  it.each(CONTRACTS)(
    "$kind declares its kind, category, ports and optional credential reference",
    (entry) => {
      const manifest = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[entry.kind];
      expect(manifest).toBeDefined();
      expect(manifest.kind).toBe(entry.kind);
      expect(manifest.display.category).toBe(entry.category);
      expect(manifest.inputs.map((port) => port.id)).toEqual(entry.inputs);
      expect(manifest.outputs.map((port) => port.id)).toEqual(entry.outputs);
      expect(manifest.credentials).toEqual(
        expect.arrayContaining([
          { type: entry.credentialType, required: false },
        ])
      );
      expect(
        manifest.parameters.find((parameter) => parameter.id === "credentialRef")
      ).toMatchObject({
        type: "credential",
        required: false,
        credentialType: entry.credentialType,
      });
    }
  );

  it("registers all nine Stage 5c kinds in the built-in class map", () => {
    const missing = CONTRACTS.filter(
      (entry) => GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND[entry.kind] !== entry.nodeClass
    ).map((entry) => entry.kind);
    expect(missing).toEqual([]);
  });
});

describe("Stage 5c vendor nodes — i18n contract", () => {
  it.each(CONTRACTS)(
    "$kind resolves every manifest locale label",
    (entry) => {
      const [category, section] = entry.i18n;
      const block = i18nValue(`graph.node.${category}.${section}`) as
        | {
            name?: unknown;
            description?: unknown;
          }
        | undefined;
      expect(block).toBeDefined();
      expect(typeof block?.name).toBe("string");
      expect((block?.name as string).length).toBeGreaterThan(0);
      expect(typeof block?.description).toBe("string");
      expect((block?.description as string).length).toBeGreaterThan(0);

      const manifest = GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[entry.kind];
      const localeKeys = new Set<string>();
      if (manifest.display.description?.startsWith("graph.")) {
        localeKeys.add(manifest.display.description);
      }
      for (const parameter of manifest.parameters) {
        if (parameter.label?.startsWith("graph.")) {
          localeKeys.add(parameter.label);
        }
        const placeholder = (parameter as { placeholder?: unknown }).placeholder;
        if (
          typeof placeholder === "string" &&
          placeholder.startsWith("graph.")
        ) {
          localeKeys.add(placeholder);
        }
      }
      for (const port of [...manifest.inputs, ...manifest.outputs]) {
        const label = (
          port.element?.props as Record<string, unknown> | undefined
        )?.["label"];
        if (typeof label === "string" && label.startsWith("graph.")) {
          localeKeys.add(label);
        }
      }
      expect(localeKeys.size).toBeGreaterThan(0);
      const missing = [...localeKeys].filter((key) => {
        const value = i18nValue(key);
        return typeof value !== "string" || value.length === 0;
      });
      expect(missing).toEqual([]);
    }
  );
});

describe("Stage 5c vendor nodes — credential resolution", () => {
  it.each(CONTRACTS)(
    "$kind resolves a secret of its declared credential type",
    async (entry) => {
      const credentialId = registerSecret(
        `resolve-${entry.credentialType}`,
        entry.credentialType,
        "resolved-secret"
      );
      const context = buildNodeContext(entry.kind, {
        engine: engineWithResolver(),
      });
      const secret = await resolveNodeCredential(
        context,
        reference(credentialId, entry.credentialType),
        entry.credentialType,
        false,
        entry.kind
      );
      expect(secret).toBe("resolved-secret");
    }
  );

  it.each(CONTRACTS)(
    "$kind rejects a credential of the wrong type",
    async (entry) => {
      const credentialId = registerSecret(
        `wrong-${entry.credentialType}`,
        "not-" + entry.credentialType,
        "wrong-secret"
      );
      const context = buildNodeContext(entry.kind, {
        engine: engineWithResolver(),
      });
      expect(
        await graphCodeOf(() =>
          resolveNodeCredential(
            context,
            reference(credentialId, "not-" + entry.credentialType),
            entry.credentialType,
            false,
            entry.kind
          )
        )
      ).toBe("GRAPH_CREDENTIAL_TYPE_MISMATCH");
    }
  );

  it.each(CONTRACTS)(
    "$kind accepts its credential and proceeds to operation validation",
    async (entry) => {
      const credentialId = registerSecret(
        `accept-${entry.credentialType}`,
        entry.credentialType,
        "accepted-token"
      );
      const context = buildNodeContext(entry.kind, {
        parameters: base({ operation: "" }),
        engine: engineWithResolver(),
      });
      const code = await graphCodeOf(() =>
        executeNode(
          entry.nodeClass,
          nodeExecutionRequest(
            {},
            { kind: entry.kind, credentials: reference(credentialId, entry.credentialType) }
          ),
          context
        )
      );
      expect(code).not.toBe("GRAPH_CREDENTIAL_TYPE_MISMATCH");
      expect(code).not.toBe("GRAPH_CREDENTIAL_NOT_FOUND");
      expect(code).toMatch(/^GRAPH_[A-Z_]+$/);
    }
  );
});

interface ErrorCase {
  name: string;
  kind: string;
  nodeClass: GraphNodeClass;
  credentialType: string;
  parameters: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  code: string;
}

const ERROR_CASES: ErrorCase[] = [
  // Discord
  { name: "discord requires an operation", kind: "core.comms.discord", nodeClass: DiscordNode, credentialType: "discord", parameters: { operation: "" }, code: "GRAPH_DISCORD_OPERATION_REQUIRED" },
  { name: "discord routes an unknown operation to sendMessage", kind: "core.comms.discord", nodeClass: DiscordNode, credentialType: "discord", parameters: { operation: "unknown" }, code: "GRAPH_DISCORD_CHANNEL_REQUIRED" },
  { name: "discord sendMessage requires a channel", kind: "core.comms.discord", nodeClass: DiscordNode, credentialType: "discord", parameters: { operation: "sendMessage" }, code: "GRAPH_DISCORD_CHANNEL_REQUIRED" },
  { name: "discord sendMessage requires content", kind: "core.comms.discord", nodeClass: DiscordNode, credentialType: "discord", parameters: { operation: "sendMessage", channelId: "c", content: "" }, inputs: { value: "" }, code: "GRAPH_DISCORD_CONTENT_REQUIRED" },
  { name: "discord rejects malformed embeds JSON", kind: "core.comms.discord", nodeClass: DiscordNode, credentialType: "discord", parameters: { operation: "sendMessage", channelId: "c", content: "x", embeds: "not-json" }, code: "GRAPH_DISCORD_EMBEDS_INVALID" },
  { name: "discord getMessage requires a message id", kind: "core.comms.discord", nodeClass: DiscordNode, credentialType: "discord", parameters: { operation: "getMessage", channelId: "c" }, code: "GRAPH_DISCORD_MESSAGE_REQUIRED" },
  { name: "discord listMessages requires a channel", kind: "core.comms.discord", nodeClass: DiscordNode, credentialType: "discord", parameters: { operation: "listMessages" }, code: "GRAPH_DISCORD_CHANNEL_REQUIRED" },
  { name: "discord getChannel requires a channel", kind: "core.comms.discord", nodeClass: DiscordNode, credentialType: "discord", parameters: { operation: "getChannel" }, code: "GRAPH_DISCORD_CHANNEL_REQUIRED" },
  { name: "discord listChannels requires a guild", kind: "core.comms.discord", nodeClass: DiscordNode, credentialType: "discord", parameters: { operation: "listChannels" }, code: "GRAPH_DISCORD_GUILD_REQUIRED" },
  { name: "discord createChannel requires guild and name", kind: "core.comms.discord", nodeClass: DiscordNode, credentialType: "discord", parameters: { operation: "createChannel" }, code: "GRAPH_DISCORD_CHANNEL_CREATE_REQUIRED" },
  { name: "discord deleteChannel requires a channel", kind: "core.comms.discord", nodeClass: DiscordNode, credentialType: "discord", parameters: { operation: "deleteChannel" }, code: "GRAPH_DISCORD_CHANNEL_REQUIRED" },
  { name: "discord addReaction requires ids and emoji", kind: "core.comms.discord", nodeClass: DiscordNode, credentialType: "discord", parameters: { operation: "addReaction" }, code: "GRAPH_DISCORD_REACTION_REQUIRED" },
  { name: "discord maps a transport/auth failure to OPERATION_FAILED", kind: "core.comms.discord", nodeClass: DiscordNode, credentialType: "discord", parameters: { operation: "listMessages", channelId: "c" }, code: "GRAPH_DISCORD_OPERATION_FAILED" },

  // WhatsApp
  { name: "whatsapp requires an operation", kind: "core.comms.whatsApp", nodeClass: WhatsAppNode, credentialType: "whatsapp", parameters: { operation: "" }, code: "GRAPH_WHATSAPP_OPERATION_REQUIRED" },
  { name: "whatsapp routes an unknown operation to sendText", kind: "core.comms.whatsApp", nodeClass: WhatsAppNode, credentialType: "whatsapp", parameters: { operation: "unknown" }, code: "GRAPH_WHATSAPP_TEXT_REQUIRED" },
  { name: "whatsapp sendText requires to and text", kind: "core.comms.whatsApp", nodeClass: WhatsAppNode, credentialType: "whatsapp", parameters: { operation: "sendText" }, code: "GRAPH_WHATSAPP_TEXT_REQUIRED" },
  { name: "whatsapp sendTemplate requires its template fields", kind: "core.comms.whatsApp", nodeClass: WhatsAppNode, credentialType: "whatsapp", parameters: { operation: "sendTemplate" }, code: "GRAPH_WHATSAPP_TEMPLATE_REQUIRED" },
  { name: "whatsapp rejects malformed components JSON", kind: "core.comms.whatsApp", nodeClass: WhatsAppNode, credentialType: "whatsapp", parameters: { operation: "sendTemplate", to: "1", templateName: "t", languageCode: "en", components: "not-json" }, code: "GRAPH_WHATSAPP_COMPONENTS_INVALID" },
  { name: "whatsapp sendMedia requires a media source", kind: "core.comms.whatsApp", nodeClass: WhatsAppNode, credentialType: "whatsapp", parameters: { operation: "sendMedia", to: "1" }, code: "GRAPH_WHATSAPP_MEDIA_REQUIRED" },
  { name: "whatsapp markAsRead requires a message id", kind: "core.comms.whatsApp", nodeClass: WhatsAppNode, credentialType: "whatsapp", parameters: { operation: "markAsRead" }, code: "GRAPH_WHATSAPP_MESSAGE_REQUIRED" },
  { name: "whatsapp getMedia requires a media id", kind: "core.comms.whatsApp", nodeClass: WhatsAppNode, credentialType: "whatsapp", parameters: { operation: "getMedia" }, code: "GRAPH_WHATSAPP_MEDIA_REQUIRED" },
  { name: "whatsapp maps a transport/auth failure to OPERATION_FAILED", kind: "core.comms.whatsApp", nodeClass: WhatsAppNode, credentialType: "whatsapp", parameters: { operation: "sendText", to: "1", text: "x" }, code: "GRAPH_WHATSAPP_OPERATION_FAILED" },

  // Outlook
  { name: "outlook requires an operation", kind: "core.comms.microsoftOutlook", nodeClass: MicrosoftOutlookNode, credentialType: "microsoft-outlook", parameters: { operation: "" }, code: "GRAPH_OUTLOOK_OPERATION_REQUIRED" },
  { name: "outlook routes an unknown operation to sendMail", kind: "core.comms.microsoftOutlook", nodeClass: MicrosoftOutlookNode, credentialType: "microsoft-outlook", parameters: { operation: "unknown" }, code: "GRAPH_OUTLOOK_MAIL_REQUIRED" },
  { name: "outlook sendMail requires recipients and subject", kind: "core.comms.microsoftOutlook", nodeClass: MicrosoftOutlookNode, credentialType: "microsoft-outlook", parameters: { operation: "sendMail" }, code: "GRAPH_OUTLOOK_MAIL_REQUIRED" },
  { name: "outlook getMessage requires a message id", kind: "core.comms.microsoftOutlook", nodeClass: MicrosoftOutlookNode, credentialType: "microsoft-outlook", parameters: { operation: "getMessage" }, code: "GRAPH_OUTLOOK_MESSAGE_REQUIRED" },
  { name: "outlook createEvent requires subject, start and end", kind: "core.comms.microsoftOutlook", nodeClass: MicrosoftOutlookNode, credentialType: "microsoft-outlook", parameters: { operation: "createEvent" }, code: "GRAPH_OUTLOOK_EVENT_REQUIRED" },
  { name: "outlook rejects malformed attendees JSON", kind: "core.comms.microsoftOutlook", nodeClass: MicrosoftOutlookNode, credentialType: "microsoft-outlook", parameters: { operation: "createEvent", subject: "s", start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z", attendees: "[not-json" }, code: "GRAPH_OUTLOOK_ATTENDEES_INVALID" },
  { name: "outlook deleteEvent requires an event id", kind: "core.comms.microsoftOutlook", nodeClass: MicrosoftOutlookNode, credentialType: "microsoft-outlook", parameters: { operation: "deleteEvent" }, code: "GRAPH_OUTLOOK_EVENT_REQUIRED" },
  { name: "outlook maps a transport/auth failure to OPERATION_FAILED", kind: "core.comms.microsoftOutlook", nodeClass: MicrosoftOutlookNode, credentialType: "microsoft-outlook", parameters: { operation: "listMessages" }, code: "GRAPH_OUTLOOK_OPERATION_FAILED" },

  // Microsoft Excel
  { name: "excel requires an operation", kind: "core.io.microsoftExcel", nodeClass: MicrosoftExcelNode, credentialType: "microsoft-excel", parameters: { operation: "" }, code: "GRAPH_EXCEL_OPERATION_REQUIRED" },
  { name: "excel updateRange requires values", kind: "core.io.microsoftExcel", nodeClass: MicrosoftExcelNode, credentialType: "microsoft-excel", parameters: { operation: "updateRange" }, code: "GRAPH_EXCEL_VALUES_REQUIRED" },
  { name: "excel rejects malformed values JSON", kind: "core.io.microsoftExcel", nodeClass: MicrosoftExcelNode, credentialType: "microsoft-excel", parameters: { operation: "updateRange", values: "not-json" }, code: "GRAPH_EXCEL_VALUES_INVALID" },
  { name: "excel rejects a non-array values JSON scalar", kind: "core.io.microsoftExcel", nodeClass: MicrosoftExcelNode, credentialType: "microsoft-excel", parameters: { operation: "updateRange", values: "123" }, code: "GRAPH_EXCEL_VALUES_INVALID" },
  { name: "excel addTableRow validates values before the row projection", kind: "core.io.microsoftExcel", nodeClass: MicrosoftExcelNode, credentialType: "microsoft-excel", parameters: { operation: "addTableRow", values: "not-json" }, code: "GRAPH_EXCEL_VALUES_INVALID" },
  { name: "excel maps a transport/auth failure to OPERATION_FAILED", kind: "core.io.microsoftExcel", nodeClass: MicrosoftExcelNode, credentialType: "microsoft-excel", parameters: { operation: "getRange" }, code: "GRAPH_EXCEL_OPERATION_FAILED" },

  // Confluence
  { name: "confluence requires an operation", kind: "core.io.confluence", nodeClass: ConfluenceNode, credentialType: "confluence", parameters: { operation: "" }, code: "GRAPH_CONFLUENCE_OPERATION_REQUIRED" },
  { name: "confluence getPage requires a page id", kind: "core.io.confluence", nodeClass: ConfluenceNode, credentialType: "confluence", parameters: { operation: "getPage" }, code: "GRAPH_CONFLUENCE_PAGE_REQUIRED" },
  { name: "confluence createPage requires space and title", kind: "core.io.confluence", nodeClass: ConfluenceNode, credentialType: "confluence", parameters: { operation: "createPage" }, code: "GRAPH_CONFLUENCE_CREATE_REQUIRED" },
  { name: "confluence updatePage requires page and title", kind: "core.io.confluence", nodeClass: ConfluenceNode, credentialType: "confluence", parameters: { operation: "updatePage" }, code: "GRAPH_CONFLUENCE_UPDATE_REQUIRED" },
  { name: "confluence deletePage requires a page id", kind: "core.io.confluence", nodeClass: ConfluenceNode, credentialType: "confluence", parameters: { operation: "deletePage" }, code: "GRAPH_CONFLUENCE_PAGE_REQUIRED" },
  { name: "confluence search requires a CQL query", kind: "core.io.confluence", nodeClass: ConfluenceNode, credentialType: "confluence", parameters: { operation: "search" }, code: "GRAPH_CONFLUENCE_SEARCH_REQUIRED" },
  { name: "confluence maps an auth failure to OPERATION_FAILED", kind: "core.io.confluence", nodeClass: ConfluenceNode, credentialType: "confluence", parameters: { operation: "listSpaces" }, code: "GRAPH_CONFLUENCE_OPERATION_FAILED" },

  // Jira
  { name: "jira requires an operation", kind: "core.io.jira", nodeClass: JiraNode, credentialType: "jira", parameters: { operation: "" }, code: "GRAPH_JIRA_OPERATION_REQUIRED" },
  { name: "jira createIssue requires project and summary", kind: "core.io.jira", nodeClass: JiraNode, credentialType: "jira", parameters: { operation: "createIssue" }, code: "GRAPH_JIRA_CREATE_REQUIRED" },
  { name: "jira rejects malformed fields JSON", kind: "core.io.jira", nodeClass: JiraNode, credentialType: "jira", parameters: { operation: "createIssue", projectKey: "P", summary: "s", fields: "not-json" }, code: "GRAPH_JIRA_FIELDS_INVALID" },
  { name: "jira updateIssue requires fields", kind: "core.io.jira", nodeClass: JiraNode, credentialType: "jira", parameters: { operation: "updateIssue", issueKey: "P-1" }, code: "GRAPH_JIRA_FIELDS_REQUIRED" },
  { name: "jira updateIssue reports malformed fields JSON as FIELDS_REQUIRED (deferred inconsistency with createIssue's FIELDS_INVALID)", kind: "core.io.jira", nodeClass: JiraNode, credentialType: "jira", parameters: { operation: "updateIssue", issueKey: "P-1", fields: "not-json" }, code: "GRAPH_JIRA_FIELDS_REQUIRED" },
  { name: "jira getIssue requires an issue key", kind: "core.io.jira", nodeClass: JiraNode, credentialType: "jira", parameters: { operation: "getIssue" }, code: "GRAPH_JIRA_ISSUE_REQUIRED" },
  { name: "jira deleteIssue requires an issue key", kind: "core.io.jira", nodeClass: JiraNode, credentialType: "jira", parameters: { operation: "deleteIssue" }, code: "GRAPH_JIRA_ISSUE_REQUIRED" },
  { name: "jira addComment requires a body", kind: "core.io.jira", nodeClass: JiraNode, credentialType: "jira", parameters: { operation: "addComment", issueKey: "P-1" }, code: "GRAPH_JIRA_COMMENT_REQUIRED" },
  { name: "jira getTransitions requires an issue key", kind: "core.io.jira", nodeClass: JiraNode, credentialType: "jira", parameters: { operation: "getTransitions" }, code: "GRAPH_JIRA_ISSUE_REQUIRED" },
  { name: "jira transitionIssue requires a transition id", kind: "core.io.jira", nodeClass: JiraNode, credentialType: "jira", parameters: { operation: "transitionIssue", issueKey: "P-1" }, code: "GRAPH_JIRA_TRANSITION_REQUIRED" },
  { name: "jira search requires a JQL query", kind: "core.io.jira", nodeClass: JiraNode, credentialType: "jira", parameters: { operation: "search" }, code: "GRAPH_JIRA_SEARCH_REQUIRED" },
  { name: "jira maps an auth failure to OPERATION_FAILED", kind: "core.io.jira", nodeClass: JiraNode, credentialType: "jira", parameters: { operation: "getIssue", issueKey: "P-1" }, code: "GRAPH_JIRA_OPERATION_FAILED" },

  // Google Docs
  { name: "google docs requires an operation", kind: "core.io.googleDocs", nodeClass: GoogleDocsNode, credentialType: "google-docs", parameters: { operation: "" }, code: "GRAPH_GOOGLE_DOCS_OPERATION_REQUIRED" },
  { name: "google docs createDocument requires a title", kind: "core.io.googleDocs", nodeClass: GoogleDocsNode, credentialType: "google-docs", parameters: { operation: "createDocument" }, code: "GRAPH_GOOGLE_DOCS_TITLE_REQUIRED" },
  { name: "google docs getDocument requires a document id", kind: "core.io.googleDocs", nodeClass: GoogleDocsNode, credentialType: "google-docs", parameters: { operation: "getDocument" }, code: "GRAPH_GOOGLE_DOCS_DOCUMENT_REQUIRED" },
  { name: "google docs appendText requires text", kind: "core.io.googleDocs", nodeClass: GoogleDocsNode, credentialType: "google-docs", parameters: { operation: "appendText", documentId: "d" }, code: "GRAPH_GOOGLE_DOCS_TEXT_REQUIRED" },
  { name: "google docs replaceAllText requires find text", kind: "core.io.googleDocs", nodeClass: GoogleDocsNode, credentialType: "google-docs", parameters: { operation: "replaceAllText", documentId: "d" }, code: "GRAPH_GOOGLE_DOCS_REPLACE_REQUIRED" },
  { name: "google docs batchUpdate requires a document id", kind: "core.io.googleDocs", nodeClass: GoogleDocsNode, credentialType: "google-docs", parameters: { operation: "batchUpdate" }, code: "GRAPH_GOOGLE_DOCS_DOCUMENT_REQUIRED" },
  { name: "google docs rejects malformed requests JSON", kind: "core.io.googleDocs", nodeClass: GoogleDocsNode, credentialType: "google-docs", parameters: { operation: "batchUpdate", documentId: "d", requests: "not-json" }, code: "GRAPH_GOOGLE_DOCS_REQUESTS_INVALID" },
  { name: "google docs maps an auth failure to OPERATION_FAILED", kind: "core.io.googleDocs", nodeClass: GoogleDocsNode, credentialType: "google-docs", parameters: { operation: "getDocument", documentId: "d" }, code: "GRAPH_GOOGLE_DOCS_OPERATION_FAILED" },

  // Microsoft SharePoint
  { name: "sharepoint requires an operation", kind: "core.io.microsoftSharePoint", nodeClass: MicrosoftSharePointNode, credentialType: "microsoft-sharepoint", parameters: { operation: "" }, code: "GRAPH_SHAREPOINT_OPERATION_REQUIRED" },
  { name: "sharepoint getSite requires a site id", kind: "core.io.microsoftSharePoint", nodeClass: MicrosoftSharePointNode, credentialType: "microsoft-sharepoint", parameters: { operation: "getSite" }, code: "GRAPH_SHAREPOINT_SITE_REQUIRED" },
  { name: "sharepoint listLists requires a site id", kind: "core.io.microsoftSharePoint", nodeClass: MicrosoftSharePointNode, credentialType: "microsoft-sharepoint", parameters: { operation: "listLists" }, code: "GRAPH_SHAREPOINT_SITE_REQUIRED" },
  { name: "sharepoint listItems requires site and list", kind: "core.io.microsoftSharePoint", nodeClass: MicrosoftSharePointNode, credentialType: "microsoft-sharepoint", parameters: { operation: "listItems" }, code: "GRAPH_SHAREPOINT_LIST_REQUIRED" },
  { name: "sharepoint createListItem requires fields", kind: "core.io.microsoftSharePoint", nodeClass: MicrosoftSharePointNode, credentialType: "microsoft-sharepoint", parameters: { operation: "createListItem", siteId: "s", listId: "l" }, code: "GRAPH_SHAREPOINT_ITEM_REQUIRED" },
  { name: "sharepoint rejects malformed fields JSON", kind: "core.io.microsoftSharePoint", nodeClass: MicrosoftSharePointNode, credentialType: "microsoft-sharepoint", parameters: { operation: "createListItem", siteId: "s", listId: "l", fields: "not-json" }, code: "GRAPH_SHAREPOINT_FIELDS_INVALID" },
  { name: "sharepoint listDriveItems requires a site id", kind: "core.io.microsoftSharePoint", nodeClass: MicrosoftSharePointNode, credentialType: "microsoft-sharepoint", parameters: { operation: "listDriveItems" }, code: "GRAPH_SHAREPOINT_SITE_REQUIRED" },
  { name: "sharepoint maps an auth failure to OPERATION_FAILED", kind: "core.io.microsoftSharePoint", nodeClass: MicrosoftSharePointNode, credentialType: "microsoft-sharepoint", parameters: { operation: "listSites" }, code: "GRAPH_SHAREPOINT_OPERATION_FAILED" },

  // Google Calendar
  { name: "google calendar requires an operation", kind: "core.io.googleCalendar", nodeClass: GoogleCalendarNode, credentialType: "google-calendar", parameters: { operation: "" }, code: "GRAPH_GOOGLE_CALENDAR_OPERATION_REQUIRED" },
  { name: "google calendar createEvent requires summary, start and end", kind: "core.io.googleCalendar", nodeClass: GoogleCalendarNode, credentialType: "google-calendar", parameters: { operation: "createEvent" }, code: "GRAPH_GOOGLE_CALENDAR_EVENT_REQUIRED" },
  { name: "google calendar rejects malformed attendees JSON", kind: "core.io.googleCalendar", nodeClass: GoogleCalendarNode, credentialType: "google-calendar", parameters: { operation: "createEvent", summary: "s", start: "2026-01-01", end: "2026-01-02", attendees: "[not-json" }, code: "GRAPH_GOOGLE_CALENDAR_ATTENDEES_INVALID" },
  { name: "google calendar getEvent requires an event id", kind: "core.io.googleCalendar", nodeClass: GoogleCalendarNode, credentialType: "google-calendar", parameters: { operation: "getEvent" }, code: "GRAPH_GOOGLE_CALENDAR_EVENT_REQUIRED" },
  { name: "google calendar updateEvent requires an event id", kind: "core.io.googleCalendar", nodeClass: GoogleCalendarNode, credentialType: "google-calendar", parameters: { operation: "updateEvent" }, code: "GRAPH_GOOGLE_CALENDAR_EVENT_REQUIRED" },
  { name: "google calendar deleteEvent requires an event id", kind: "core.io.googleCalendar", nodeClass: GoogleCalendarNode, credentialType: "google-calendar", parameters: { operation: "deleteEvent" }, code: "GRAPH_GOOGLE_CALENDAR_EVENT_REQUIRED" },
  { name: "google calendar maps an auth failure to OPERATION_FAILED", kind: "core.io.googleCalendar", nodeClass: GoogleCalendarNode, credentialType: "google-calendar", parameters: { operation: "listCalendars" }, code: "GRAPH_GOOGLE_CALENDAR_OPERATION_FAILED" },
];

describe("Stage 5c vendor nodes — operation routing and error codes", () => {
  it.each(ERROR_CASES)("$name", async (entry) => {
    const credentialId = registerSecret(
      `error-${entry.credentialType}`,
      entry.credentialType,
      {}
    );
    const context = buildNodeContext(entry.kind, {
      parameters: base(entry.parameters),
      engine: engineWithResolver(),
    });
    expect(
      await graphCodeOf(() =>
        executeNode(
          entry.nodeClass,
          nodeExecutionRequest(entry.inputs ?? {}, {
            kind: entry.kind,
            credentials: reference(credentialId, entry.credentialType),
          }),
          context
        )
      )
    ).toBe(entry.code);
  });

  it.each(CONTRACTS)(
    "$kind surfaces the routed operation name on transport failure",
    async (entry) => {
      const credentialId = registerSecret(
        `routing-${entry.credentialType}`,
        entry.credentialType,
        {}
      );
      const operation = {
        "core.comms.discord": { operation: "listMessages", channelId: "c" },
        "core.comms.whatsApp": { operation: "sendText", to: "1", text: "x" },
        "core.comms.microsoftOutlook": { operation: "listEvents" },
        "core.io.microsoftExcel": { operation: "listTables", itemId: "i" },
        "core.io.confluence": { operation: "listSpaces" },
        "core.io.jira": { operation: "search", jql: "project = P" },
        "core.io.googleDocs": { operation: "getDocument", documentId: "d" },
        "core.io.microsoftSharePoint": { operation: "listSites" },
        "core.io.googleCalendar": { operation: "listEvents" },
      }[entry.kind] as Record<string, unknown>;
      const context = buildNodeContext(entry.kind, {
        parameters: base(operation),
        engine: engineWithResolver(),
      });
      await expect(
        executeNode(
          entry.nodeClass,
          nodeExecutionRequest(
            {},
            {
              kind: entry.kind,
              credentials: reference(credentialId, entry.credentialType),
            }
          ),
          context
        )
      ).rejects.toMatchObject({
        graphCode: expect.stringMatching(/^GRAPH_[A-Z_]+_OPERATION_FAILED$/),
        message: expect.stringContaining(String(operation.operation)),
      });
    }
  );
});

describe("Stage 5c vendor nodes — JSON/array field parsing", () => {
  it("discord parses a JSON embeds array and an object into an embed list", async () => {
    const credentialId = registerSecret("parse-discord", "discord", {});
    for (const embeds of ['[{"title":"a"}]', '{"title":"a"}', [{ title: "a" }]]) {
      const context = buildNodeContext("core.comms.discord", {
        parameters: base({
          operation: "sendMessage",
          channelId: "c",
          content: "x",
          embeds,
        }),
        engine: engineWithResolver(),
      });
      expect(
        await graphCodeOf(() =>
          executeNode(
            DiscordNode,
            nodeExecutionRequest(
              {},
              {
                kind: "core.comms.discord",
                credentials: reference(credentialId, "discord"),
              }
            ),
            context
          )
        )
      ).toBe("GRAPH_DISCORD_OPERATION_FAILED");
    }
  });

  it("whatsapp parses a JSON components array and an object into a component list", async () => {
    const credentialId = registerSecret("parse-whatsapp", "whatsapp", {});
    for (const components of ['[{"type":"body"}]', '{"type":"body"}']) {
      const context = buildNodeContext("core.comms.whatsApp", {
        parameters: base({
          operation: "sendTemplate",
          to: "1",
          templateName: "t",
          languageCode: "en",
          components,
        }),
        engine: engineWithResolver(),
      });
      expect(
        await graphCodeOf(() =>
          executeNode(
            WhatsAppNode,
            nodeExecutionRequest(
              {},
              {
                kind: "core.comms.whatsApp",
                credentials: reference(credentialId, "whatsapp"),
              }
            ),
            context
          )
        )
      ).toBe("GRAPH_WHATSAPP_OPERATION_FAILED");
    }
  });

  it("outlook parses JSON, comma and semicolon attendee lists", async () => {
    const credentialId = registerSecret("parse-outlook", "microsoft-outlook", {});
    for (const attendees of ['["a@example.com"]', "a@example.com,b@example.com", "a@example.com;b@example.com"]) {
      const context = buildNodeContext("core.comms.microsoftOutlook", {
        parameters: base({
          operation: "createEvent",
          subject: "s",
          start: "2026-01-01T00:00:00Z",
          end: "2026-01-01T01:00:00Z",
          attendees,
        }),
        engine: engineWithResolver(),
      });
      expect(
        await graphCodeOf(() =>
          executeNode(
            MicrosoftOutlookNode,
            nodeExecutionRequest(
              {},
              {
                kind: "core.comms.microsoftOutlook",
                credentials: reference(credentialId, "microsoft-outlook"),
              }
            ),
            context
          )
        )
      ).toBe("GRAPH_OUTLOOK_OPERATION_FAILED");
    }
  });

  it("excel parses JSON rows and wraps a flat row for range writes", async () => {
    const credentialId = registerSecret("parse-excel", "microsoft-excel", {});
    for (const values of ['[[1,2],[3,4]]', [1, 2, 3]]) {
      const context = buildNodeContext("core.io.microsoftExcel", {
        parameters: base({
          operation: "updateRange",
          itemId: "i",
          worksheet: "Sheet1",
          range: "A1:B2",
          values,
        }),
        engine: engineWithResolver(),
      });
      expect(
        await graphCodeOf(() =>
          executeNode(
            MicrosoftExcelNode,
            nodeExecutionRequest(
              {},
              {
                kind: "core.io.microsoftExcel",
                credentials: reference(credentialId, "microsoft-excel"),
              }
            ),
            context
          )
        )
      ).toBe("GRAPH_EXCEL_OPERATION_FAILED");
    }
  });

  it("jira parses a JSON fields object", async () => {
    const credentialId = registerSecret("parse-jira", "jira", {});
    for (const fields of ['{"labels":["x"]}', { labels: ["x"] }]) {
      const context = buildNodeContext("core.io.jira", {
        parameters: base({
          operation: "updateIssue",
          issueKey: "P-1",
          fields,
        }),
        engine: engineWithResolver(),
      });
      expect(
        await graphCodeOf(() =>
          executeNode(
            JiraNode,
            nodeExecutionRequest(
              {},
              {
                kind: "core.io.jira",
                credentials: reference(credentialId, "jira"),
              }
            ),
            context
          )
        )
      ).toBe("GRAPH_JIRA_OPERATION_FAILED");
    }
  });

  it("google docs parses a JSON requests array", async () => {
    const credentialId = registerSecret("parse-docs", "google-docs", {});
    for (const requests of ['[{"insertText":{}}]', [{ insertText: {} }]]) {
      const context = buildNodeContext("core.io.googleDocs", {
        parameters: base({ operation: "batchUpdate", documentId: "d", requests }),
        engine: engineWithResolver(),
      });
      expect(
        await graphCodeOf(() =>
          executeNode(
            GoogleDocsNode,
            nodeExecutionRequest(
              {},
              {
                kind: "core.io.googleDocs",
                credentials: reference(credentialId, "google-docs"),
              }
            ),
            context
          )
        )
      ).toBe("GRAPH_GOOGLE_DOCS_OPERATION_FAILED");
    }
  });

  it("sharepoint parses a JSON fields object", async () => {
    const credentialId = registerSecret(
      "parse-sharepoint",
      "microsoft-sharepoint",
      {}
    );
    for (const fields of ['{"Title":"x"}', { Title: "x" }]) {
      const context = buildNodeContext("core.io.microsoftSharePoint", {
        parameters: base({
          operation: "createListItem",
          siteId: "s",
          listId: "l",
          fields,
        }),
        engine: engineWithResolver(),
      });
      expect(
        await graphCodeOf(() =>
          executeNode(
            MicrosoftSharePointNode,
            nodeExecutionRequest(
              {},
              {
                kind: "core.io.microsoftSharePoint",
                credentials: reference(credentialId, "microsoft-sharepoint"),
              }
            ),
            context
          )
        )
      ).toBe("GRAPH_SHAREPOINT_OPERATION_FAILED");
    }
  });

  it("google calendar parses JSON, comma and semicolon attendee lists", async () => {
    const credentialId = registerSecret(
      "parse-calendar",
      "google-calendar",
      {}
    );
    for (const attendees of ['["a@example.com"]', "a@example.com,b@example.com", "a@example.com;b@example.com"]) {
      const context = buildNodeContext("core.io.googleCalendar", {
        parameters: base({
          operation: "createEvent",
          summary: "s",
          start: "2026-01-01T00:00:00Z",
          end: "2026-01-01T01:00:00Z",
          attendees,
        }),
        engine: engineWithResolver(),
      });
      expect(
        await graphCodeOf(() =>
          executeNode(
            GoogleCalendarNode,
            nodeExecutionRequest(
              {},
              {
                kind: "core.io.googleCalendar",
                credentials: reference(credentialId, "google-calendar"),
              }
            ),
            context
          )
        )
      ).toBe("GRAPH_GOOGLE_CALENDAR_OPERATION_FAILED");
    }
  });
});
