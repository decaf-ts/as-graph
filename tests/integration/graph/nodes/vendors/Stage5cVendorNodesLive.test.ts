/**
 * @module as-graph/tests/integration/graph/nodes/vendors/Stage5cVendorNodesLive
 * @summary Integration coverage for the nine SAA-1450 Stage 5c vendor node
 * kinds through {@link GraphRunService}.
 * @description Every run goes through the production run service against a
 * process-local loopback HTTP stub (the recorded-fixture equivalent): create the
 * run, wait for it, assert the terminal status and projected outputs, and assert
 * the exact request the node-driven service emitted. No provider is contacted.
 * Each vendor also declares a read-only credential-gated live case that skips
 * with the exact missing environment variable when no real access is supplied.
 *
 * The nine kinds are pinned as built-in registrations by a dedicated case; the
 * remaining behavioural cases register the same production manifest+class pairs
 * directly when the built-in class map omits them, so the node→service→run
 * contract can be verified independently of that wiring defect.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";

import type { GraphWorkflowDocument } from "../../../../../src/shared/graph";
import type { GraphExecutionEngine } from "../../../../../src/engine/execution/GraphExecutionEngine";
import type { GraphNodeCatalogue } from "../../../../../src/engine/catalog/GraphNodeCatalogue";
import { GraphNodeExecutorRegistry } from "../../../../../src/engine/registry/GraphNodeExecutorRegistry";
import { registerBuiltInGraphNodes } from "../../../../../src/engine/catalog/GraphBuiltInRegistrations";
import {
  GraphRunService,
  InMemoryGraphRunEventStore,
  InMemoryGraphRunStore,
  defineGraphNode,
  type GraphRun,
} from "../../../../../src";
import { graphNodeConfig, type GraphNodeClass } from "../../../../../src/node/base";
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
} from "../../../../../src/node";
import {
  bootEngine,
  documentEdge,
  documentNode,
  documentPort,
  freshCatalogue,
} from "../../../../unit/graph/engine-fixtures";
import {
  TEST_CREDENTIAL_SERVICES,
  clearCredentials,
  setCredential,
  uniqueName,
} from "../real-service-support";
import {
  startHttpStub,
  type HttpStub,
  type StubRequest,
} from "../loopback-support";
import { credentialGatedIt, envValue } from "../credential-gated";

jest.setTimeout(120_000);

const RUN_TIMEOUT_MS = 60_000;

const VENDOR_NODES: Record<string, GraphNodeClass> = {
  "core.comms.discord": DiscordNode,
  "core.comms.whatsApp": WhatsAppNode,
  "core.comms.microsoftOutlook": MicrosoftOutlookNode,
  "core.io.microsoftExcel": MicrosoftExcelNode,
  "core.io.confluence": ConfluenceNode,
  "core.io.jira": JiraNode,
  "core.io.googleDocs": GoogleDocsNode,
  "core.io.microsoftSharePoint": MicrosoftSharePointNode,
  "core.io.googleCalendar": GoogleCalendarNode,
};

const CREDENTIAL_TYPE: Record<string, string> = {
  "core.comms.discord": "discord",
  "core.comms.whatsApp": "whatsapp",
  "core.comms.microsoftOutlook": "microsoft-outlook",
  "core.io.microsoftExcel": "microsoft-excel",
  "core.io.confluence": "confluence",
  "core.io.jira": "jira",
  "core.io.googleDocs": "google-docs",
  "core.io.microsoftSharePoint": "microsoft-sharepoint",
  "core.io.googleCalendar": "google-calendar",
};

let http: HttpStub;
let engine: GraphExecutionEngine;
let catalogue: GraphNodeCatalogue;

/** Registers the same production manifest+class executor when the built-in map omits a kind. */
async function registerMissingVendorNodes(
  target: GraphNodeCatalogue
): Promise<void> {
  for (const [kind, nodeClass] of Object.entries(VENDOR_NODES)) {
    if (await target.has(kind)) continue;
    target.register(
      defineGraphNode({
        manifest: GRAPH_BUILT_IN_NODE_MANIFESTS_BY_KIND[kind],
        executor: {
          execute: (request, context) => {
            const instance = nodeClass.instantiate({
              ...graphNodeConfig(context.node),
              ...(request.parameters as Record<string, unknown>),
              ...((context.node.state as Record<string, unknown>) ?? {}),
            });
            return instance.execute(request, context);
          },
        },
      })
    );
  }
}

function stubReply(request: StubRequest): { status: number; body: unknown } {
  const path = decodeURIComponent(request.path);
  if (path === "/v1/documents/D1" && request.method === "GET") {
    return { status: 200, body: { documentId: "D1", body: { content: [{ endIndex: 10 }] } } };
  }
  if (path === "/wiki/rest/api/content/P1" && request.method === "GET") {
    return { status: 200, body: { id: "P1", title: "Title", version: { number: 3 } } };
  }
  if (path.endsWith("/workbook/worksheets")) {
    return { status: 200, body: { value: [{ name: "Sheet1" }] } };
  }
  if (path.endsWith("/workbook/worksheets/Sheet1/range(address='A1:B2')")) {
    return { status: 200, body: { values: [[1, 2]] } };
  }
  if (path.endsWith("/messages") && request.method === "POST") {
    return { status: 200, body: { id: "M-NEW", channel_id: "C1", messages: [{ id: "wamid.1" }] } };
  }
  if (path.endsWith("/channels/C1") && request.method === "GET") {
    return { status: 200, body: { id: "C1", name: "general" } };
  }
  if (path.endsWith("/channels/C1/messages") && request.method === "GET") {
    return { status: 200, body: [{ id: "M1" }] };
  }
  if (path === "/v19.0/MEDIA") {
    return { status: 200, body: { url: "https://example.invalid/media" } };
  }
  if (path === "/v1.0/me/sendMail") {
    return { status: 202, body: {} };
  }
  if (path === "/v1.0/me/events" && request.method === "GET") {
    return { status: 200, body: { value: [{ id: "E1", subject: "sync" }] } };
  }
  if (path === "/v1.0/me/events" && request.method === "POST") {
    return { status: 201, body: { id: "E1", subject: "sync" } };
  }
  if (path === "/wiki/rest/api/content" && request.method === "POST") {
    return { status: 200, body: { id: "P2", title: "T" } };
  }
  if (path === "/jira/rest/api/2/issue" && request.method === "POST") {
    return { status: 201, body: { id: "1", key: "P-1" } };
  }
  if (path === "/jira/rest/api/2/search") {
    return { status: 200, body: { issues: [{ key: "P-1" }] } };
  }
  if (path === "/v1/documents" && request.method === "POST") {
    return { status: 200, body: { documentId: "D1" } };
  }
  if (path.endsWith(":batchUpdate")) {
    return { status: 200, body: {} };
  }
  if (path === "/v1.0/sites") {
    return { status: 200, body: { value: [{ id: "S1", displayName: "Site" }] } };
  }
  if (path === "/v1.0/sites/S1/lists/L1/items" && request.method === "POST") {
    return { status: 201, body: { id: "I1", fields: { Title: "x" } } };
  }
  if (path === "/calendar/v3/users/me/calendarList") {
    return { status: 200, body: { items: [{ id: "primary" }] } };
  }
  if (path.endsWith("/events") && request.method === "GET") {
    return { status: 200, body: { items: [{ id: "E1", summary: "sync" }] } };
  }
  if (path.endsWith("/events") && request.method === "POST") {
    return { status: 200, body: { id: "E1", summary: "sync" } };
  }
  return { status: 200, body: { ok: true } };
}

beforeAll(async () => {
  http = await startHttpStub(stubReply);
  catalogue = freshCatalogue();
  engine = await bootEngine({
    registry: new GraphNodeExecutorRegistry(catalogue),
    nodeCredentials: TEST_CREDENTIAL_SERVICES,
  });
  await registerBuiltInGraphNodes(catalogue);
  await registerMissingVendorNodes(catalogue);

  for (const [kind, credentialType] of Object.entries(CREDENTIAL_TYPE)) {
    setCredential(`saa1453-${kind}`, "loopback-token", {
      credentialType,
    });
  }
});

afterAll(async () => {
  clearCredentials(
    ...Object.keys(CREDENTIAL_TYPE).map((kind) => `saa1453-${kind}`)
  );
  await http.close();
});

/** Creates an isolated run service bound to the shared test engine. */
function newService(): GraphRunService {
  return new GraphRunService(
    engine,
    new InMemoryGraphRunStore(),
    new InMemoryGraphRunEventStore(),
    {
      limits: {
        executionTimeoutMs: RUN_TIMEOUT_MS,
        eventReplayWindowMs: 1_000,
        maxEventsPerRun: 400,
      },
    }
  );
}

/** Builds a one-node workflow that routes `result` plus the named extra ports. */
function runDocument(
  kind: string,
  parameters: Record<string, unknown>,
  extraOutputs: string[] = []
): GraphWorkflowDocument {
  return {
    id: uniqueName("saa1453-wf"),
    name: "saa1453",
    inputs: [],
    outputs: ["result", ...extraOutputs].map((port) => documentPort(port)),
    nodes: [documentNode("vendor", kind, parameters)],
    edges: [
      documentEdge("e-result", ["node", "vendor", "result"], ["workflow", "result"]),
      ...extraOutputs.map((port) =>
        documentEdge(`e-${port}`, ["node", "vendor", port], ["workflow", port])
      ),
    ],
  };
}

/** Starts a run, waits for it to settle and asserts success. */
async function runWorkflow(
  service: GraphRunService,
  document: GraphWorkflowDocument,
  owner: string
): Promise<GraphRun> {
  const run = await service.createRun(
    { workflow: document, inputs: {} },
    owner
  );
  const settled = await service.waitForRun(run.runId, owner);
  expect(settled.error).toBeUndefined();
  expect(settled.status).toBe("succeeded");
  service.release(run.runId);
  return settled;
}

/** Requests recorded since the given index. */
function requestsSince(index: number): StubRequest[] {
  return http.requests.slice(index);
}

describe("Stage 5c vendor node registration", () => {
  it("registers all nine Stage 5c kinds through registerBuiltInGraphNodes", async () => {
    const builtIns = freshCatalogue();
    await registerBuiltInGraphNodes(builtIns);
    const missing: string[] = [];
    for (const kind of Object.keys(VENDOR_NODES)) {
      if (!(await builtIns.has(kind))) missing.push(kind);
    }
    expect(missing).toEqual([]);
    for (const [kind, nodeClass] of Object.entries(VENDOR_NODES)) {
      expect(GRAPH_BUILT_IN_NODE_CLASSES_BY_KIND[kind]).toBe(nodeClass);
    }
  });
});

describe("Stage 5c vendor nodes through GraphRunService (loopback stub)", () => {
  it("core.comms.discord sends a message and lists channel messages", async () => {
    const service = newService();
    const owner = uniqueName("saa1453-discord-owner");
    const credentialId = `saa1453-${"core.comms.discord"}`;
    const before = http.requests.length;

    const sent = await runWorkflow(
      service,
      runDocument("core.comms.discord", {
        operation: "sendMessage",
        channelId: "C1",
        content: "hello",
        baseUrl: `${http.baseUrl}/api/v10`,
        credentialRef: credentialId,
      }, ["messageId"]),
      owner
    );
    expect(sent.result?.outputs.result).toMatchObject({ id: "M-NEW" });
    expect(sent.result?.outputs.messageId).toBe("M-NEW");

    const listed = await runWorkflow(
      service,
      runDocument("core.comms.discord", {
        operation: "listMessages",
        channelId: "C1",
        limit: 5,
        before: "B1",
        baseUrl: `${http.baseUrl}/api/v10`,
        credentialRef: credentialId,
      }),
      owner
    );
    expect(listed.result?.outputs.result).toEqual([{ id: "M1" }]);

    const requests = requestsSince(before);
    const post = requests.find((r) => r.method === "POST");
    expect(post?.path).toBe("/api/v10/channels/C1/messages");
    expect(post?.headers.authorization).toBe("Bot loopback-token");
    expect(post?.body).toEqual({
      content: "hello",
      tts: false,
    });
    const list = requests.find(
      (r) => r.method === "GET" && r.path.endsWith("/channels/C1/messages")
    );
    expect(list?.query.get("limit")).toBe("5");
    expect(list?.query.get("before")).toBe("B1");
  });

  it("core.comms.whatsApp sends text and fetches media", async () => {
    const service = newService();
    const owner = uniqueName("saa1453-whatsapp-owner");
    const credentialId = `saa1453-${"core.comms.whatsApp"}`;
    const before = http.requests.length;

    const sent = await runWorkflow(
      service,
      runDocument("core.comms.whatsApp", {
        operation: "sendText",
        phoneNumberId: "PHONE",
        to: "1555",
        text: "hi",
        baseUrl: `${http.baseUrl}/v19.0`,
        credentialRef: credentialId,
      }, ["messageId"]),
      owner
    );
    expect(sent.result?.outputs.result).toMatchObject({
      messages: [{ id: "wamid.1" }],
    });
    expect(sent.result?.outputs.messageId).toBe("wamid.1");

    const media = await runWorkflow(
      service,
      runDocument("core.comms.whatsApp", {
        operation: "getMedia",
        mediaId: "MEDIA",
        baseUrl: `${http.baseUrl}/v19.0`,
        credentialRef: credentialId,
      }),
      owner
    );
    expect(media.result?.outputs.result).toMatchObject({
      url: "https://example.invalid/media",
    });

    const requests = requestsSince(before);
    const post = requests.find((r) => r.method === "POST");
    expect(post?.path).toBe("/v19.0/PHONE/messages");
    expect(post?.headers.authorization).toBe("Bearer loopback-token");
    expect(post?.body).toMatchObject({
      messaging_product: "whatsapp",
      to: "1555",
      type: "text",
    });
  });

  it("core.comms.microsoftOutlook sends mail and lists events", async () => {
    const service = newService();
    const owner = uniqueName("saa1453-outlook-owner");
    const credentialId = `saa1453-${"core.comms.microsoftOutlook"}`;
    const before = http.requests.length;

    const sent = await runWorkflow(
      service,
      runDocument("core.comms.microsoftOutlook", {
        operation: "sendMail",
        to: "a@example.com",
        subject: "subject",
        body: "body",
        baseUrl: `${http.baseUrl}/v1.0`,
        credentialRef: credentialId,
      }),
      owner
    );
    expect(sent.result?.outputs.result).toMatchObject({ sent: true });

    const listed = await runWorkflow(
      service,
      runDocument("core.comms.microsoftOutlook", {
        operation: "listEvents",
        top: 3,
        baseUrl: `${http.baseUrl}/v1.0`,
        credentialRef: credentialId,
      }),
      owner
    );
    expect(listed.result?.outputs.result).toEqual({
      value: [{ id: "E1", subject: "sync" }],
    });

    const requests = requestsSince(before);
    const mail = requests.find((r) => r.path === "/v1.0/me/sendMail");
    expect(mail?.headers.authorization).toBe("Bearer loopback-token");
    expect(mail?.body).toMatchObject({
      message: { subject: "subject", toRecipients: [{ emailAddress: { address: "a@example.com" } }] },
      saveToSentItems: true,
    });
    const events = requests.find(
      (r) => r.path === "/v1.0/me/events" && r.method === "GET"
    );
    expect(events?.query.get("$top")).toBe("3");
  });

  it("core.io.microsoftExcel lists worksheets and writes a range", async () => {
    const service = newService();
    const owner = uniqueName("saa1453-excel-owner");
    const credentialId = `saa1453-${"core.io.microsoftExcel"}`;
    const before = http.requests.length;

    const listed = await runWorkflow(
      service,
      runDocument("core.io.microsoftExcel", {
        operation: "listWorksheets",
        itemId: "ITEM",
        baseUrl: `${http.baseUrl}/v1.0`,
        credentialRef: credentialId,
      }),
      owner
    );
    expect(listed.result?.outputs.result).toEqual({
      value: [{ name: "Sheet1" }],
    });

    const written = await runWorkflow(
      service,
      runDocument("core.io.microsoftExcel", {
        operation: "updateRange",
        itemId: "ITEM",
        worksheet: "Sheet1",
        range: "A1:B2",
        values: "[[1,2]]",
        baseUrl: `${http.baseUrl}/v1.0`,
        credentialRef: credentialId,
      }),
      owner
    );
    expect(written.result?.outputs.result).toEqual({ values: [[1, 2]] });

    const requests = requestsSince(before);
    expect(
      requests.find((r) => r.path.endsWith("/workbook/worksheets"))?.headers
        .authorization
    ).toBe("Bearer loopback-token");
    const patch = requests.find((r) => r.method === "PATCH");
    expect(decodeURIComponent(patch?.path ?? "")).toContain(
      "range(address='A1:B2')"
    );
    expect(patch?.body).toEqual({ values: [[1, 2]] });
  });

  it("core.io.confluence reads and creates a page", async () => {
    const service = newService();
    const owner = uniqueName("saa1453-confluence-owner");
    const credentialId = `saa1453-${"core.io.confluence"}`;
    setCredential(credentialId, JSON.stringify({
      token: "confluence-token",
      username: "user@example.com",
    }), { credentialType: "confluence" });
    const before = http.requests.length;

    const page = await runWorkflow(
      service,
      runDocument("core.io.confluence", {
        operation: "getPage",
        pageId: "P1",
        baseUrl: `${http.baseUrl}/wiki`,
        credentialRef: credentialId,
      }),
      owner
    );
    expect(page.result?.outputs.result).toMatchObject({ id: "P1" });

    const created = await runWorkflow(
      service,
      runDocument("core.io.confluence", {
        operation: "createPage",
        spaceKey: "SPACE",
        title: "T",
        body: "B",
        baseUrl: `${http.baseUrl}/wiki`,
        credentialRef: credentialId,
      }),
      owner
    );
    expect(created.result?.outputs.result).toMatchObject({ id: "P2" });

    const requests = requestsSince(before);
    const get = requests.find((r) => r.path === "/wiki/rest/api/content/P1");
    expect(get?.headers.authorization).toBe(
      `Basic ${Buffer.from("user@example.com:confluence-token").toString("base64")}`
    );
    const create = requests.find(
      (r) => r.path === "/wiki/rest/api/content" && r.method === "POST"
    );
    expect(create?.body).toMatchObject({
      space: { key: "SPACE" },
      body: { storage: { representation: "storage" } },
    });
  });

  it("core.io.jira creates an issue and searches", async () => {
    const service = newService();
    const owner = uniqueName("saa1453-jira-owner");
    const credentialId = `saa1453-${"core.io.jira"}`;
    const before = http.requests.length;

    const created = await runWorkflow(
      service,
      runDocument("core.io.jira", {
        operation: "createIssue",
        projectKey: "P",
        summary: "Summary",
        issueType: "Bug",
        fields: '{"labels":["x"]}',
        baseUrl: `${http.baseUrl}/jira`,
        credentialRef: credentialId,
      }, ["issueKey"]),
      owner
    );
    expect(created.result?.outputs.result).toMatchObject({ key: "P-1" });
    expect(created.result?.outputs.issueKey).toBe("P-1");

    const searched = await runWorkflow(
      service,
      runDocument("core.io.jira", {
        operation: "search",
        jql: "project = P",
        maxResults: 5,
        baseUrl: `${http.baseUrl}/jira`,
        credentialRef: credentialId,
      }),
      owner
    );
    expect(searched.result?.outputs.result).toEqual({
      issues: [{ key: "P-1" }],
    });

    const requests = requestsSince(before);
    const issue = requests.find(
      (r) => r.path === "/jira/rest/api/2/issue" && r.method === "POST"
    );
    expect(issue?.headers.authorization).toBe("Bearer loopback-token");
    expect(issue?.body).toEqual({
      fields: {
        project: { key: "P" },
        summary: "Summary",
        issuetype: { name: "Bug" },
        labels: ["x"],
      },
    });
    const search = requests.find((r) => r.path === "/jira/rest/api/2/search");
    expect(search?.body).toEqual({ jql: "project = P", maxResults: 5 });
  });

  it("core.io.googleDocs creates a document and appends text", async () => {
    const service = newService();
    const owner = uniqueName("saa1453-docs-owner");
    const credentialId = `saa1453-${"core.io.googleDocs"}`;
    const before = http.requests.length;

    const created = await runWorkflow(
      service,
      runDocument("core.io.googleDocs", {
        operation: "createDocument",
        title: "T",
        baseUrl: `${http.baseUrl}/v1`,
        credentialRef: credentialId,
      }, ["documentId"]),
      owner
    );
    expect(created.result?.outputs.result).toMatchObject({ documentId: "D1" });
    expect(created.result?.outputs.documentId).toBe("D1");

    const appended = await runWorkflow(
      service,
      runDocument("core.io.googleDocs", {
        operation: "appendText",
        documentId: "D1",
        text: "more",
        baseUrl: `${http.baseUrl}/v1`,
        credentialRef: credentialId,
      }),
      owner
    );
    expect(appended.result?.outputs.result).toEqual({});

    const requests = requestsSince(before);
    const create = requests.find(
      (r) => r.path === "/v1/documents" && r.method === "POST"
    );
    expect(create?.headers.authorization).toBe("Bearer loopback-token");
    expect(create?.body).toEqual({ title: "T" });
    const append = requests.find(
      (r) => r.path === "/v1/documents/D1:batchUpdate"
    );
    expect(append?.body).toEqual({
      requests: [{ insertText: { location: { index: 9 }, text: "more" } }],
    });
  });

  it("core.io.microsoftSharePoint lists sites and creates a list item", async () => {
    const service = newService();
    const owner = uniqueName("saa1453-sharepoint-owner");
    const credentialId = `saa1453-${"core.io.microsoftSharePoint"}`;
    const before = http.requests.length;

    const sites = await runWorkflow(
      service,
      runDocument("core.io.microsoftSharePoint", {
        operation: "listSites",
        search: "*",
        baseUrl: `${http.baseUrl}/v1.0`,
        credentialRef: credentialId,
      }),
      owner
    );
    expect(sites.result?.outputs.result).toEqual({
      value: [{ id: "S1", displayName: "Site" }],
    });

    const created = await runWorkflow(
      service,
      runDocument("core.io.microsoftSharePoint", {
        operation: "createListItem",
        siteId: "S1",
        listId: "L1",
        fields: '{"Title":"x"}',
        baseUrl: `${http.baseUrl}/v1.0`,
        credentialRef: credentialId,
      }),
      owner
    );
    expect(created.result?.outputs.result).toMatchObject({ id: "I1" });

    const requests = requestsSince(before);
    const list = requests.find((r) => r.path === "/v1.0/sites");
    expect(list?.headers.authorization).toBe("Bearer loopback-token");
    const create = requests.find(
      (r) => r.path === "/v1.0/sites/S1/lists/L1/items"
    );
    expect(create?.body).toEqual({ fields: { Title: "x" } });
  });

  it("core.io.googleCalendar lists and creates events", async () => {
    const service = newService();
    const owner = uniqueName("saa1453-calendar-owner");
    const credentialId = `saa1453-${"core.io.googleCalendar"}`;
    const before = http.requests.length;

    const listed = await runWorkflow(
      service,
      runDocument("core.io.googleCalendar", {
        operation: "listEvents",
        calendarId: "CAL",
        maxResults: 4,
        q: "sync",
        baseUrl: `${http.baseUrl}/calendar/v3`,
        credentialRef: credentialId,
      }),
      owner
    );
    expect(listed.result?.outputs.result).toEqual({
      items: [{ id: "E1", summary: "sync" }],
    });

    const created = await runWorkflow(
      service,
      runDocument("core.io.googleCalendar", {
        operation: "createEvent",
        calendarId: "CAL",
        summary: "sync",
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-01T01:00:00Z",
        timeZone: "UTC",
        attendees: "a@example.com",
        baseUrl: `${http.baseUrl}/calendar/v3`,
        credentialRef: credentialId,
      }, ["eventId"]),
      owner
    );
    expect(created.result?.outputs.result).toMatchObject({ id: "E1" });
    expect(created.result?.outputs.eventId).toBe("E1");

    const requests = requestsSince(before);
    const list = requests.find(
      (r) => r.path === "/calendar/v3/calendars/CAL/events" && r.method === "GET"
    );
    expect(list?.headers.authorization).toBe("Bearer loopback-token");
    expect(list?.query.get("maxResults")).toBe("4");
    const create = requests.find(
      (r) => r.path === "/calendar/v3/calendars/CAL/events" && r.method === "POST"
    );
    expect(create?.body).toMatchObject({
      summary: "sync",
      start: { dateTime: "2026-01-01T00:00:00Z", timeZone: "UTC" },
      attendees: [{ email: "a@example.com" }],
    });
  });
});

/**
 * Read-only live cases. Each skips with the exact missing environment variable
 * when the operator has not supplied real provider access.
 */
function liveCredential(
  id: string,
  credentialType: string,
  secret: string | Record<string, unknown>
): string {
  setCredential(id, secret, { credentialType });
  return id;
}

describe("Stage 5c vendor live credentials (read-only)", () => {
  credentialGatedIt(
    "core.comms.discord live getChannel",
    ["AS_GRAPH_IT_DISCORD_BOT_TOKEN", "AS_GRAPH_IT_DISCORD_CHANNEL_ID"],
    async () => {
      const id = liveCredential(
        "saa1453-live-discord",
        "discord",
        envValue("AS_GRAPH_IT_DISCORD_BOT_TOKEN")
      );
      const service = newService();
      const run = await runWorkflow(
        service,
        runDocument("core.comms.discord", {
          operation: "getChannel",
          channelId: envValue("AS_GRAPH_IT_DISCORD_CHANNEL_ID"),
          credentialRef: id,
        }),
        uniqueName("saa1453-live-discord-owner")
      );
      expect(run.result?.outputs.result).toBeDefined();
    }
  );

  credentialGatedIt(
    "core.comms.whatsApp live getMedia",
    [
      "AS_GRAPH_IT_WHATSAPP_TOKEN",
      "AS_GRAPH_IT_WHATSAPP_PHONE_NUMBER_ID",
      "AS_GRAPH_IT_WHATSAPP_MEDIA_ID",
    ],
    async () => {
      const id = liveCredential(
        "saa1453-live-whatsapp",
        "whatsapp",
        JSON.stringify({
          token: envValue("AS_GRAPH_IT_WHATSAPP_TOKEN"),
          phoneNumberId: envValue("AS_GRAPH_IT_WHATSAPP_PHONE_NUMBER_ID"),
        })
      );
      const service = newService();
      const run = await runWorkflow(
        service,
        runDocument("core.comms.whatsApp", {
          operation: "getMedia",
          mediaId: envValue("AS_GRAPH_IT_WHATSAPP_MEDIA_ID"),
          credentialRef: id,
        }),
        uniqueName("saa1453-live-whatsapp-owner")
      );
      expect(run.result?.outputs.result).toBeDefined();
    }
  );

  credentialGatedIt(
    "core.comms.microsoftOutlook live listMessages",
    ["AS_GRAPH_IT_OUTLOOK_ACCESS_TOKEN"],
    async () => {
      const id = liveCredential(
        "saa1453-live-outlook",
        "microsoft-outlook",
        envValue("AS_GRAPH_IT_OUTLOOK_ACCESS_TOKEN")
      );
      const service = newService();
      const run = await runWorkflow(
        service,
        runDocument("core.comms.microsoftOutlook", {
          operation: "listMessages",
          top: 1,
          credentialRef: id,
        }),
        uniqueName("saa1453-live-outlook-owner")
      );
      expect(run.result?.outputs.result).toBeDefined();
    }
  );

  credentialGatedIt(
    "core.io.microsoftExcel live listWorksheets",
    ["AS_GRAPH_IT_EXCEL_ACCESS_TOKEN", "AS_GRAPH_IT_EXCEL_ITEM_ID"],
    async () => {
      const id = liveCredential(
        "saa1453-live-excel",
        "microsoft-excel",
        envValue("AS_GRAPH_IT_EXCEL_ACCESS_TOKEN")
      );
      const service = newService();
      const run = await runWorkflow(
        service,
        runDocument("core.io.microsoftExcel", {
          operation: "listWorksheets",
          itemId: envValue("AS_GRAPH_IT_EXCEL_ITEM_ID"),
          credentialRef: id,
        }),
        uniqueName("saa1453-live-excel-owner")
      );
      expect(run.result?.outputs.result).toBeDefined();
    }
  );

  credentialGatedIt(
    "core.io.confluence live listSpaces",
    [
      "AS_GRAPH_IT_CONFLUENCE_BASE_URL",
      "AS_GRAPH_IT_CONFLUENCE_TOKEN",
    ],
    async () => {
      const id = liveCredential(
        "saa1453-live-confluence",
        "confluence",
        JSON.stringify({
          token: envValue("AS_GRAPH_IT_CONFLUENCE_TOKEN"),
          username: process.env["AS_GRAPH_IT_CONFLUENCE_USERNAME"]?.trim(),
        })
      );
      const service = newService();
      const run = await runWorkflow(
        service,
        runDocument("core.io.confluence", {
          operation: "listSpaces",
          baseUrl: envValue("AS_GRAPH_IT_CONFLUENCE_BASE_URL"),
          credentialRef: id,
        }),
        uniqueName("saa1453-live-confluence-owner")
      );
      expect(run.result?.outputs.result).toBeDefined();
    }
  );

  credentialGatedIt(
    "core.io.jira live search",
    ["AS_GRAPH_IT_JIRA_BASE_URL", "AS_GRAPH_IT_JIRA_TOKEN"],
    async () => {
      const id = liveCredential(
        "saa1453-live-jira",
        "jira",
        JSON.stringify({
          token: envValue("AS_GRAPH_IT_JIRA_TOKEN"),
          username: process.env["AS_GRAPH_IT_JIRA_USERNAME"]?.trim(),
        })
      );
      const service = newService();
      const run = await runWorkflow(
        service,
        runDocument("core.io.jira", {
          operation: "search",
          jql: "order by created DESC",
          maxResults: 1,
          baseUrl: envValue("AS_GRAPH_IT_JIRA_BASE_URL"),
          credentialRef: id,
        }),
        uniqueName("saa1453-live-jira-owner")
      );
      expect(run.result?.outputs.result).toBeDefined();
    }
  );

  credentialGatedIt(
    "core.io.googleDocs live getDocument",
    [
      "AS_GRAPH_IT_GOOGLE_DOCS_ACCESS_TOKEN",
      "AS_GRAPH_IT_GOOGLE_DOCS_DOCUMENT_ID",
    ],
    async () => {
      const id = liveCredential(
        "saa1453-live-docs",
        "google-docs",
        envValue("AS_GRAPH_IT_GOOGLE_DOCS_ACCESS_TOKEN")
      );
      const service = newService();
      const run = await runWorkflow(
        service,
        runDocument("core.io.googleDocs", {
          operation: "getDocument",
          documentId: envValue("AS_GRAPH_IT_GOOGLE_DOCS_DOCUMENT_ID"),
          credentialRef: id,
        }),
        uniqueName("saa1453-live-docs-owner")
      );
      expect(run.result?.outputs.result).toBeDefined();
    }
  );

  credentialGatedIt(
    "core.io.microsoftSharePoint live listSites",
    ["AS_GRAPH_IT_SHAREPOINT_ACCESS_TOKEN"],
    async () => {
      const id = liveCredential(
        "saa1453-live-sharepoint",
        "microsoft-sharepoint",
        envValue("AS_GRAPH_IT_SHAREPOINT_ACCESS_TOKEN")
      );
      const service = newService();
      const run = await runWorkflow(
        service,
        runDocument("core.io.microsoftSharePoint", {
          operation: "listSites",
          credentialRef: id,
        }),
        uniqueName("saa1453-live-sharepoint-owner")
      );
      expect(run.result?.outputs.result).toBeDefined();
    }
  );

  credentialGatedIt(
    "core.io.googleCalendar live listCalendars",
    ["AS_GRAPH_IT_GOOGLE_CALENDAR_ACCESS_TOKEN"],
    async () => {
      const id = liveCredential(
        "saa1453-live-calendar",
        "google-calendar",
        envValue("AS_GRAPH_IT_GOOGLE_CALENDAR_ACCESS_TOKEN")
      );
      const service = newService();
      const run = await runWorkflow(
        service,
        runDocument("core.io.googleCalendar", {
          operation: "listCalendars",
          credentialRef: id,
        }),
        uniqueName("saa1453-live-calendar-owner")
      );
      expect(run.result?.outputs.result).toBeDefined();
    }
  );
});
