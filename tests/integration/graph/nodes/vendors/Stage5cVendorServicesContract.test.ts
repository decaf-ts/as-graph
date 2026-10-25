/**
 * @module as-graph/tests/integration/graph/nodes/vendors/Stage5cVendorServicesContract
 * @summary Service contract coverage for the nine SAA-1450 Stage 5c vendor
 * integration services.
 * @description Drives the public service classes from
 * `@decaf-ts/integrations` against a process-local loopback HTTP stub. No
 * provider is contacted. Every case asserts the exact request
 * method/path/query/body and the provider's auth-header shape (Discord `Bot`,
 * Bearer, Google API key, Jira/Confluence Basic), plus the shared decaf error
 * mapping for 404/409/5xx and transport failures.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
} from "@decaf-ts/db-decorators";

import { DiscordService } from "@decaf-ts/integrations/comms/discord";
import { WhatsAppService } from "@decaf-ts/integrations/comms/whatsapp";
import { MicrosoftOutlookService } from "@decaf-ts/integrations/comms/outlook";
import { MicrosoftExcelService } from "@decaf-ts/integrations/io/microsoft-excel";
import { ConfluenceService } from "@decaf-ts/integrations/io/confluence";
import { JiraService } from "@decaf-ts/integrations/io/jira";
import { GoogleDocsService } from "@decaf-ts/integrations/io/google-docs";
import { MicrosoftSharePointService } from "@decaf-ts/integrations/io/microsoft-sharepoint";
import { GoogleCalendarService } from "@decaf-ts/integrations/calendar/google-calendar";
import {
  startHttpStub,
  type HttpStub,
  type StubRequest,
} from "../loopback-support";

jest.setTimeout(60_000);

const ENV_KEYS = [
  "COMMS__DISCORD__TOKEN",
  "COMMS__DISCORD__BASE_URL",
  "COMMS__WHATS_APP__TOKEN",
  "COMMS__WHATS_APP__PHONE_NUMBER_ID",
  "COMMS__WHATS_APP__BASE_URL",
  "COMMS__OUTLOOK__TOKEN",
  "COMMS__OUTLOOK__BASE_URL",
  "IO__MICROSOFT_EXCEL__TOKEN",
  "IO__MICROSOFT_EXCEL__BASE_URL",
  "IO__CONFLUENCE__USERNAME",
  "IO__CONFLUENCE__TOKEN",
  "IO__CONFLUENCE__BASE_URL",
  "IO__JIRA__USERNAME",
  "IO__JIRA__TOKEN",
  "IO__JIRA__BASE_URL",
  "IO__GOOGLE_DOCS__TOKEN",
  "IO__GOOGLE_DOCS__API_KEY",
  "IO__GOOGLE_DOCS__BASE_URL",
  "IO__MICROSOFT_SHARE_POINT__TOKEN",
  "IO__MICROSOFT_SHARE_POINT__BASE_URL",
  "CALENDAR__GOOGLE_CALENDAR__TOKEN",
  "CALENDAR__GOOGLE_CALENDAR__API_KEY",
  "CALENDAR__GOOGLE_CALENDAR__CALENDAR_ID",
  "CALENDAR__GOOGLE_CALENDAR__BASE_URL",
] as const;

interface Failure {
  status: number;
  body: unknown;
}

let http: HttpStub;
let failure: Failure | undefined;

function reply(request: StubRequest): { status: number; body: unknown } {
  if (failure) return { status: failure.status, body: failure.body };
  const path = decodeURIComponent(request.path);
  if (path === "/v1/documents/D1" && request.method === "GET") {
    return { status: 200, body: { body: { content: [{ endIndex: 10 }] } } };
  }
  if (path === "/wiki/rest/api/content/P1" && request.method === "GET") {
    return { status: 200, body: { id: "P1", version: { number: 3 } } };
  }
  return { status: 200, body: { ok: true, echo: request.body ?? null } };
}

/** The most recent request whose decoded path matches the predicate. */
function requestFor(
  predicate: (request: StubRequest) => boolean
): StubRequest {
  const request = [...http.requests].reverse().find(predicate);
  if (!request) throw new Error("expected request was not recorded");
  return request;
}

function configOf(service: unknown): Record<string, unknown> {
  return (service as { config: Record<string, unknown> }).config;
}

function decodedPath(request: StubRequest): string {
  return decodeURIComponent(request.path);
}

beforeAll(async () => {
  http = await startHttpStub(reply);
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterAll(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  await http.close();
});

function resetFailure(): void {
  failure = undefined;
}

describe("Stage 5c vendor service contracts — auth, path, body", () => {
  it("Discord sends the Bot auth header and exact channel/guild requests", async () => {
    const service = new DiscordService();
    await service.initialize({
      token: "discord-token",
      baseUrl: `${http.baseUrl}/api/v10`,
    });

    await service.sendMessage({
      channelId: "C1",
      content: "hello",
      embeds: [{ title: "t" }],
    });
    let request = requestFor((r) => decodedPath(r) === "/api/v10/channels/C1/messages" && r.method === "POST");
    expect(request.headers.authorization).toBe("Bot discord-token");
    expect(request.headers["content-type"]).toContain("application/json");
    expect(request.body).toEqual({
      content: "hello",
      tts: false,
      embeds: [{ title: "t" }],
    });

    await service.getMessage("C1", "M1");
    request = requestFor((r) => decodedPath(r) === "/api/v10/channels/C1/messages/M1");
    expect(request.method).toBe("GET");

    await service.listMessages({ channelId: "C1", limit: 5, before: "B1" });
    request = requestFor((r) => decodedPath(r) === "/api/v10/channels/C1/messages" && r.method === "GET");
    expect(request.query.get("limit")).toBe("5");
    expect(request.query.get("before")).toBe("B1");

    await service.getChannel("C1");
    expect(
      requestFor((r) => decodedPath(r) === "/api/v10/channels/C1").method
    ).toBe("GET");

    await service.listChannels("G1");
    expect(
      requestFor((r) => decodedPath(r) === "/api/v10/guilds/G1/channels").method
    ).toBe("GET");

    await service.createChannel({
      guildId: "G1",
      name: "general",
      topic: "topic",
      parentId: "P1",
    });
    request = requestFor((r) => decodedPath(r) === "/api/v10/guilds/G1/channels" && r.method === "POST");
    expect(request.body).toEqual({
      name: "general",
      type: 0,
      topic: "topic",
      parent_id: "P1",
    });

    await service.deleteChannel("C1");
    expect(
      requestFor((r) => decodedPath(r) === "/api/v10/channels/C1" && r.method === "DELETE")
    ).toBeDefined();

    await service.addReaction({ channelId: "C1", messageId: "M1", emoji: "ok" });
    expect(
      requestFor(
        (r) =>
          decodedPath(r) === "/api/v10/channels/C1/messages/M1/reactions/ok/@me" &&
          r.method === "PUT"
      )
    ).toBeDefined();

    await expect(service.sendMessage({ channelId: "", content: "x" })).rejects.toBeInstanceOf(InternalError);
    await service.shutdown();
  });

  it("WhatsApp sends Bearer auth and exact text/template/media/read requests", async () => {
    const service = new WhatsAppService();
    await service.initialize({
      token: "whatsapp-token",
      phoneNumberId: "PHONE",
      baseUrl: `${http.baseUrl}/v19.0`,
    });
    const prefix = "/v19.0/PHONE/messages";

    await service.sendText({ to: "1555", text: "hi", previewUrl: true });
    let request = requestFor((r) => decodedPath(r) === prefix && r.method === "POST");
    expect(request.headers.authorization).toBe("Bearer whatsapp-token");
    expect(request.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "1555",
      type: "text",
      text: { body: "hi", preview_url: true },
    });

    await service.sendTemplate({
      to: "1555",
      templateName: "welcome",
      languageCode: "en_US",
      components: [{ type: "body" }],
    });
    request = requestFor((r) => decodedPath(r) === prefix && r.method === "POST");
    expect(request.body).toEqual({
      messaging_product: "whatsapp",
      to: "1555",
      type: "template",
      template: {
        name: "welcome",
        language: { code: "en_US" },
        components: [{ type: "body" }],
      },
    });

    await service.sendMedia({
      to: "1555",
      type: "document",
      mediaId: "MEDIA",
      filename: "a.pdf",
      caption: "cap",
    });
    request = requestFor((r) => decodedPath(r) === prefix && r.method === "POST");
    expect(request.body).toMatchObject({
      type: "document",
      document: { id: "MEDIA", caption: "cap", filename: "a.pdf" },
    });

    await service.sendMedia({ to: "1555", type: "image", link: "https://x/y.png" });
    request = requestFor((r) => decodedPath(r) === prefix && r.method === "POST");
    expect(request.body).toMatchObject({
      image: { link: "https://x/y.png" },
    });

    await service.markAsRead({ messageId: "WAMID" });
    request = requestFor((r) => decodedPath(r) === prefix && r.method === "POST");
    expect(request.body).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "WAMID",
    });

    await service.getMedia("MEDIA");
    request = requestFor((r) => decodedPath(r) === "/v19.0/MEDIA");
    expect(request.method).toBe("GET");
    expect(request.headers.authorization).toBe("Bearer whatsapp-token");

    await expect(
      service.sendText({ to: "1", text: "x" })
    ).resolves.toBeDefined();
    await expect(service.getMedia("")).rejects.toBeInstanceOf(InternalError);
    await service.shutdown();
  });

  it("Outlook sends Bearer auth and exact mail/event requests", async () => {
    const service = new MicrosoftOutlookService();
    await service.initialize({
      token: "outlook-token",
      baseUrl: `${http.baseUrl}/v1.0`,
    });

    await service.sendMail({
      to: "a@example.com,b@example.com",
      cc: "c@example.com;d@example.com",
      bcc: ["e@example.com"],
      subject: "subject",
      body: "body",
      contentType: "HTML",
    });
    let request = requestFor((r) => decodedPath(r) === "/v1.0/me/sendMail" && r.method === "POST");
    expect(request.headers.authorization).toBe("Bearer outlook-token");
    expect(request.body).toEqual({
      message: {
        subject: "subject",
        body: { contentType: "HTML", content: "body" },
        toRecipients: [
          { emailAddress: { address: "a@example.com" } },
          { emailAddress: { address: "b@example.com" } },
        ],
        ccRecipients: [
          { emailAddress: { address: "c@example.com" } },
          { emailAddress: { address: "d@example.com" } },
        ],
        bccRecipients: [{ emailAddress: { address: "e@example.com" } }],
      },
      saveToSentItems: true,
    });

    await service.listMessages({ top: 5, filter: "isRead eq false", search: "hello" });
    request = requestFor(
      (r) => decodedPath(r) === "/v1.0/me/mailFolders/inbox/messages"
    );
    expect(request.query.get("$top")).toBe("5");
    expect(request.query.get("$filter")).toBe("isRead eq false");
    expect(request.query.get("$search")).toBe("hello");

    await service.getMessage("M1");
    expect(requestFor((r) => decodedPath(r) === "/v1.0/me/messages/M1").method).toBe("GET");

    await service.listEvents({ top: 3 });
    request = requestFor((r) => decodedPath(r) === "/v1.0/me/events" && r.method === "GET");
    expect(request.query.get("$top")).toBe("3");

    await service.createEvent({
      subject: "sync",
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-01T01:00:00Z",
      body: "body",
      location: "Room",
      attendees: "a@example.com",
    });
    request = requestFor((r) => decodedPath(r) === "/v1.0/me/events" && r.method === "POST");
    expect(request.body).toEqual({
      subject: "sync",
      body: { contentType: "Text", content: "body" },
      start: { dateTime: "2026-01-01T00:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-01-01T01:00:00Z", timeZone: "UTC" },
      location: { displayName: "Room" },
      attendees: [
        {
          emailAddress: { address: "a@example.com" },
          type: "required",
        },
      ],
    });

    await service.deleteEvent("E1");
    expect(requestFor((r) => decodedPath(r) === "/v1.0/me/events/E1" && r.method === "DELETE")).toBeDefined();

    await expect(
      service.sendMail({ to: "", subject: "s", body: "b" })
    ).rejects.toBeInstanceOf(InternalError);
    await service.shutdown();
  });

  it("Microsoft Excel sends Bearer auth and exact workbook/range/table requests", async () => {
    const service = new MicrosoftExcelService();
    await service.initialize({
      token: "excel-token",
      baseUrl: `${http.baseUrl}/v1.0`,
    });

    await service.listWorksheets({ itemId: "ITEM" });
    expect(
      requestFor(
        (r) =>
          decodedPath(r) === "/v1.0/me/drive/items/ITEM/workbook/worksheets"
      ).method
    ).toBe("GET");

    await service.listWorksheets({ itemId: "ITEM", driveId: "DRIVE" });
    expect(
      requestFor(
        (r) =>
          decodedPath(r) ===
          "/v1.0/drives/DRIVE/items/ITEM/workbook/worksheets"
      )
    ).toBeDefined();

    const rangePath =
      "/v1.0/me/drive/items/ITEM/workbook/worksheets/Sheet1/range(address='A1:B2')";
    await service.getRange({ itemId: "ITEM", worksheet: "Sheet1", range: "A1:B2" });
    expect(requestFor((r) => decodedPath(r) === rangePath).method).toBe("GET");

    await service.updateRange({
      itemId: "ITEM",
      worksheet: "Sheet1",
      range: "A1:B2",
      values: [[1, 2]],
    });
    let request = requestFor((r) => decodedPath(r) === rangePath && r.method === "PATCH");
    expect(request.headers.authorization).toBe("Bearer excel-token");
    expect(request.body).toEqual({ values: [[1, 2]] });

    await service.listTables({ itemId: "ITEM" });
    expect(
      requestFor((r) => decodedPath(r) === "/v1.0/me/drive/items/ITEM/workbook/tables")
    ).toBeDefined();

    await service.addTableRow({ itemId: "ITEM", tableId: "T1", values: [1, 2] });
    request = requestFor(
      (r) => decodedPath(r) === "/v1.0/me/drive/items/ITEM/workbook/tables/T1/rows/add"
    );
    expect(request.method).toBe("POST");
    expect(request.body).toEqual({ values: [[1, 2]] });

    await expect(
      service.getRange({ itemId: "ITEM", worksheet: "", range: "" })
    ).rejects.toBeInstanceOf(InternalError);
    await service.shutdown();
  });

  it("Confluence sends Basic or Bearer auth and exact content requests", async () => {
    const service = new ConfluenceService();
    await service.initialize({
      username: "user@example.com",
      token: "confluence-token",
      baseUrl: `${http.baseUrl}/wiki`,
    });
    const basic = `Basic ${Buffer.from(
      "user@example.com:confluence-token"
    ).toString("base64")}`;

    await service.getPage("P1");
    let request = requestFor((r) => decodedPath(r) === "/wiki/rest/api/content/P1");
    expect(request.headers.authorization).toBe(basic);
    expect(request.query.get("expand")).toBe("body.storage,version");

    await service.listSpaces(5);
    request = requestFor((r) => decodedPath(r) === "/wiki/rest/api/space");
    expect(request.query.get("limit")).toBe("5");

    await service.createPage({
      spaceKey: "SPACE",
      title: "Title",
      body: "Body",
      parentId: "PARENT",
    });
    request = requestFor((r) => decodedPath(r) === "/wiki/rest/api/content" && r.method === "POST");
    expect(request.body).toEqual({
      type: "page",
      title: "Title",
      space: { key: "SPACE" },
      ancestors: [{ id: "PARENT" }],
      body: { storage: { value: "Body", representation: "storage" } },
    });

    await service.updatePage({ pageId: "P1", title: "Title", body: "Body" });
    request = requestFor((r) => decodedPath(r) === "/wiki/rest/api/content/P1" && r.method === "PUT");
    expect(request.body).toMatchObject({
      id: "P1",
      type: "page",
      title: "Title",
      version: { number: 4 },
      body: { storage: { value: "Body", representation: "storage" } },
    });

    await service.updatePage({ pageId: "P1", title: "Title", body: "Body", version: 9 });
    request = requestFor((r) => decodedPath(r) === "/wiki/rest/api/content/P1" && r.method === "PUT");
    expect((request.body as { version: { number: number } }).version.number).toBe(9);

    await service.deletePage("P1");
    expect(
      requestFor((r) => decodedPath(r) === "/wiki/rest/api/content/P1" && r.method === "DELETE")
    ).toBeDefined();

    await service.search({ cql: "type=page", limit: 2 });
    request = requestFor((r) => decodedPath(r) === "/wiki/rest/api/content/search");
    expect(request.query.get("cql")).toBe("type=page");
    expect(request.query.get("limit")).toBe("2");

    await expect(
      service.search({ cql: "" })
    ).rejects.toBeInstanceOf(InternalError);
    await service.shutdown();

    const bearer = new ConfluenceService();
    await bearer.initialize({
      token: "bearer-token",
      baseUrl: `${http.baseUrl}/wiki`,
    });
    await bearer.getPage("P2");
    expect(
      requestFor((r) => decodedPath(r) === "/wiki/rest/api/content/P2").headers
        .authorization
    ).toBe("Bearer bearer-token");
    await bearer.shutdown();
  });

  it("Jira sends Basic or Bearer auth and exact issue/search requests", async () => {
    const service = new JiraService();
    await service.initialize({
      username: "user@example.com",
      token: "jira-token",
      baseUrl: `${http.baseUrl}/jira`,
    });
    const basic = `Basic ${Buffer.from("user@example.com:jira-token").toString(
      "base64"
    )}`;

    await service.createIssue({
      projectKey: "P",
      summary: "Summary",
      issueType: "Bug",
      description: "Description",
      fields: { labels: ["x"] },
    });
    let request = requestFor((r) => decodedPath(r) === "/jira/rest/api/2/issue" && r.method === "POST");
    expect(request.headers.authorization).toBe(basic);
    expect(request.headers.accept).toBe("application/json");
    expect(request.body).toEqual({
      fields: {
        project: { key: "P" },
        summary: "Summary",
        issuetype: { name: "Bug" },
        description: "Description",
        labels: ["x"],
      },
    });

    await service.getIssue("P-1", ["summary", "status"]);
    request = requestFor((r) => decodedPath(r) === "/jira/rest/api/2/issue/P-1" && r.method === "GET");
    expect(request.query.get("fields")).toBe("summary,status");

    await service.updateIssue({ issueKey: "P-1", fields: { summary: "s" } });
    request = requestFor((r) => decodedPath(r) === "/jira/rest/api/2/issue/P-1" && r.method === "PUT");
    expect(request.body).toEqual({ fields: { summary: "s" } });

    await service.deleteIssue("P-1");
    expect(
      requestFor((r) => decodedPath(r) === "/jira/rest/api/2/issue/P-1" && r.method === "DELETE")
    ).toBeDefined();

    await service.addComment({ issueKey: "P-1", body: "note" });
    request = requestFor((r) => decodedPath(r) === "/jira/rest/api/2/issue/P-1/comment");
    expect(request.body).toEqual({ body: "note" });

    await service.getTransitions("P-1");
    expect(
      requestFor((r) => decodedPath(r) === "/jira/rest/api/2/issue/P-1/transitions" && r.method === "GET")
    ).toBeDefined();

    await service.transitionIssue({ issueKey: "P-1", transitionId: "31" });
    request = requestFor((r) => decodedPath(r) === "/jira/rest/api/2/issue/P-1/transitions" && r.method === "POST");
    expect(request.body).toEqual({ transition: { id: "31" } });

    await service.search({ jql: "project = P", maxResults: 7, fields: ["summary"] });
    request = requestFor((r) => decodedPath(r) === "/jira/rest/api/2/search");
    expect(request.body).toEqual({
      jql: "project = P",
      maxResults: 7,
      fields: ["summary"],
    });

    await expect(service.search({ jql: "" })).rejects.toBeInstanceOf(InternalError);
    await service.shutdown();

    const bearer = new JiraService();
    await bearer.initialize({
      token: "bearer-token",
      baseUrl: `${http.baseUrl}/jira`,
    });
    await bearer.getIssue("P-2");
    const bearerRequest = requestFor(
      (r) => decodedPath(r) === "/jira/rest/api/2/issue/P-2"
    );
    expect(bearerRequest.headers.authorization).toBe("Bearer bearer-token");
    expect(bearerRequest.headers.accept).toBe("application/json");
    await bearer.shutdown();
  });

  it("Google Docs sends Bearer or API-key auth and exact document requests", async () => {
    const service = new GoogleDocsService();
    await service.initialize({
      token: "docs-token",
      baseUrl: `${http.baseUrl}/v1`,
    });

    await service.getDocument("D1");
    let request = requestFor((r) => decodedPath(r) === "/v1/documents/D1");
    expect(request.headers.authorization).toBe("Bearer docs-token");

    await service.createDocument("Title");
    request = requestFor((r) => decodedPath(r) === "/v1/documents" && r.method === "POST");
    expect(request.body).toEqual({ title: "Title" });

    await service.batchUpdate("D1", [{ insertText: {} }]);
    request = requestFor((r) => decodedPath(r) === "/v1/documents/D1:batchUpdate");
    expect(request.body).toEqual({ requests: [{ insertText: {} }] });

    await service.appendText("D1", "more");
    request = requestFor((r) => decodedPath(r) === "/v1/documents/D1:batchUpdate" && r.method === "POST");
    expect(request.body).toEqual({
      requests: [
        { insertText: { location: { index: 9 }, text: "more" } },
      ],
    });

    await service.replaceAllText({
      documentId: "D1",
      find: "a",
      replace: "b",
      matchCase: true,
    });
    request = requestFor((r) => decodedPath(r) === "/v1/documents/D1:batchUpdate");
    expect(request.body).toEqual({
      requests: [
        {
          replaceAllText: {
            containsText: { text: "a", matchCase: true },
            replaceText: "b",
          },
        },
      ],
    });

    await service.shutdown();

    const apiKey = new GoogleDocsService();
    await apiKey.initialize({
      apiKey: "docs-key",
      baseUrl: `${http.baseUrl}/v1`,
    });
    await apiKey.getDocument("D2");
    const keyed = requestFor((r) => decodedPath(r) === "/v1/documents/D2");
    expect(keyed.headers["x-goog-api-key"]).toBe("docs-key");
    expect(keyed.headers.authorization).toBeUndefined();
    await apiKey.shutdown();
  });

  it("Microsoft SharePoint sends Bearer auth and exact site/list/item requests", async () => {
    const service = new MicrosoftSharePointService();
    await service.initialize({
      token: "sharepoint-token",
      baseUrl: `${http.baseUrl}/v1.0`,
    });

    await service.listSites();
    let request = requestFor((r) => decodedPath(r) === "/v1.0/sites");
    expect(request.query.get("search")).toBe("*");

    await service.getSite("S1");
    expect(requestFor((r) => decodedPath(r) === "/v1.0/sites/S1").method).toBe("GET");

    await service.listLists("S1");
    expect(requestFor((r) => decodedPath(r) === "/v1.0/sites/S1/lists")).toBeDefined();

    await service.listItems({ siteId: "S1", listId: "L1", top: 5, filter: "x eq 1" });
    request = requestFor((r) => decodedPath(r) === "/v1.0/sites/S1/lists/L1/items");
    expect(request.headers.authorization).toBe("Bearer sharepoint-token");
    expect(request.query.get("$expand")).toBe("fields");
    expect(request.query.get("$top")).toBe("5");
    expect(request.query.get("$filter")).toBe("x eq 1");

    await service.createListItem({ siteId: "S1", listId: "L1", fields: { Title: "x" } });
    request = requestFor(
      (r) => decodedPath(r) === "/v1.0/sites/S1/lists/L1/items" && r.method === "POST"
    );
    expect(request.body).toEqual({ fields: { Title: "x" } });

    await service.listDriveItems({ siteId: "S1", top: 2 });
    request = requestFor(
      (r) => decodedPath(r) === "/v1.0/sites/S1/drive/items/root/children"
    );
    expect(request.query.get("$top")).toBe("2");

    await service.listDriveItems({ siteId: "S1", itemId: "I1" });
    expect(
      requestFor(
        (r) => decodedPath(r) === "/v1.0/sites/S1/drive/items/I1/children"
      )
    ).toBeDefined();

    await expect(
      service.getSite("")
    ).rejects.toBeInstanceOf(InternalError);
    await service.shutdown();
  });

  it("Google Calendar sends Bearer or API-key auth and exact event requests", async () => {
    const service = new GoogleCalendarService();
    await service.initialize({
      token: "calendar-token",
      calendarId: "CAL",
      baseUrl: `${http.baseUrl}/calendar/v3`,
    });

    await service.listCalendars();
    let request = requestFor(
      (r) => decodedPath(r) === "/calendar/v3/users/me/calendarList"
    );
    expect(request.headers.authorization).toBe("Bearer calendar-token");

    await service.listEvents({ maxResults: 4, q: "sync", singleEvents: true });
    request = requestFor(
      (r) => decodedPath(r) === "/calendar/v3/calendars/CAL/events"
    );
    expect(request.query.get("maxResults")).toBe("4");
    expect(request.query.get("q")).toBe("sync");
    expect(request.query.get("singleEvents")).toBe("true");

    await service.createEvent({
      summary: "sync",
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-01T01:00:00Z",
      timeZone: "Europe/Lisbon",
      attendees: ["a@example.com"],
    });
    request = requestFor(
      (r) => decodedPath(r) === "/calendar/v3/calendars/CAL/events" && r.method === "POST"
    );
    expect(request.body).toEqual({
      summary: "sync",
      start: {
        dateTime: "2026-01-01T00:00:00Z",
        timeZone: "Europe/Lisbon",
      },
      end: { dateTime: "2026-01-01T01:00:00Z", timeZone: "Europe/Lisbon" },
      attendees: [{ email: "a@example.com" }],
    });

    await service.createEvent({
      summary: "all-day",
      start: "2026-01-01",
      end: "2026-01-02",
    });
    request = requestFor(
      (r) => decodedPath(r) === "/calendar/v3/calendars/CAL/events" && r.method === "POST"
    );
    expect(request.body).toMatchObject({
      start: { date: "2026-01-01" },
      end: { date: "2026-01-02" },
    });

    await service.getEvent("CAL", "E1");
    expect(
      requestFor((r) => decodedPath(r) === "/calendar/v3/calendars/CAL/events/E1")
    ).toBeDefined();

    await service.updateEvent("E1", {
      calendarId: "CAL",
      summary: "updated",
      start: "2026-01-01T02:00:00Z",
    });
    request = requestFor(
      (r) =>
        decodedPath(r) === "/calendar/v3/calendars/CAL/events/E1" &&
        r.method === "PATCH"
    );
    expect(request.body).toEqual({
      summary: "updated",
      start: { dateTime: "2026-01-01T02:00:00Z" },
    });

    await service.deleteEvent("CAL", "E1");
    expect(
      requestFor(
        (r) =>
          decodedPath(r) === "/calendar/v3/calendars/CAL/events/E1" &&
          r.method === "DELETE"
      )
    ).toBeDefined();

    await service.shutdown();

    const apiKey = new GoogleCalendarService();
    await apiKey.initialize({
      apiKey: "calendar-key",
      baseUrl: `${http.baseUrl}/calendar/v3`,
    });
    await apiKey.listEvents();
    const keyed = requestFor(
      (r) => decodedPath(r) === "/calendar/v3/calendars/primary/events"
    );
    expect(keyed.query.get("key")).toBe("calendar-key");
    expect(keyed.headers.authorization).toBeUndefined();
    await apiKey.shutdown();
  });
});

describe("Stage 5c vendor service contracts — error mapping", () => {
  const cases = [
    {
      name: "Discord",
      make: async () => {
        const service = new DiscordService();
        await service.initialize({
          token: "t",
          baseUrl: `${http.baseUrl}/api/v10`,
        });
        return service;
      },
      call: async (service: unknown) =>
        (service as DiscordService).getChannel("C1"),
    },
    {
      name: "WhatsApp",
      make: async () => {
        const service = new WhatsAppService();
        await service.initialize({
          token: "t",
          phoneNumberId: "P",
          baseUrl: `${http.baseUrl}/v19.0`,
        });
        return service;
      },
      call: async (service: unknown) =>
        (service as WhatsAppService).getMedia("M"),
    },
    {
      name: "Microsoft Outlook",
      make: async () => {
        const service = new MicrosoftOutlookService();
        await service.initialize({
          token: "t",
          baseUrl: `${http.baseUrl}/v1.0`,
        });
        return service;
      },
      call: async (service: unknown) =>
        (service as MicrosoftOutlookService).getMessage("M"),
    },
    {
      name: "Microsoft Excel",
      make: async () => {
        const service = new MicrosoftExcelService();
        await service.initialize({
          token: "t",
          baseUrl: `${http.baseUrl}/v1.0`,
        });
        return service;
      },
      call: async (service: unknown) =>
        (service as MicrosoftExcelService).listWorksheets({ itemId: "I" }),
    },
    {
      name: "Confluence",
      make: async () => {
        const service = new ConfluenceService();
        await service.initialize({
          token: "t",
          baseUrl: `${http.baseUrl}/wiki`,
        });
        return service;
      },
      call: async (service: unknown) =>
        (service as ConfluenceService).getPage("P1"),
    },
    {
      name: "Jira",
      make: async () => {
        const service = new JiraService();
        await service.initialize({
          token: "t",
          baseUrl: `${http.baseUrl}/jira`,
        });
        return service;
      },
      call: async (service: unknown) =>
        (service as JiraService).getIssue("P-1"),
    },
    {
      name: "Google Docs",
      make: async () => {
        const service = new GoogleDocsService();
        await service.initialize({
          token: "t",
          baseUrl: `${http.baseUrl}/v1`,
        });
        return service;
      },
      call: async (service: unknown) =>
        (service as GoogleDocsService).getDocument("D1"),
    },
    {
      name: "Microsoft SharePoint",
      make: async () => {
        const service = new MicrosoftSharePointService();
        await service.initialize({
          token: "t",
          baseUrl: `${http.baseUrl}/v1.0`,
        });
        return service;
      },
      call: async (service: unknown) =>
        (service as MicrosoftSharePointService).getSite("S1"),
    },
    {
      name: "Google Calendar",
      make: async () => {
        const service = new GoogleCalendarService();
        await service.initialize({
          token: "t",
          baseUrl: `${http.baseUrl}/calendar/v3`,
        });
        return service;
      },
      call: async (service: unknown) =>
        (service as GoogleCalendarService).getEvent("primary", "E1"),
    },
  ];

  it.each(cases)(
    "$name maps 404 to NotFoundError and 500 to BadRequestError",
    async ({ make, call }) => {
      const service = await make();
      failure = { status: 404, body: { error: "missing" } };
      await expect(call(service)).rejects.toBeInstanceOf(NotFoundError);
      failure = { status: 500, body: { error: "boom" } };
      await expect(call(service)).rejects.toBeInstanceOf(BadRequestError);
      resetFailure();
      await (service as { shutdown(): Promise<void> }).shutdown();
    }
  );

  it.each(cases)(
    "$name maps 409 to ConflictError",
    async ({ make, call }) => {
      const service = await make();
      failure = { status: 409, body: { error: "conflict" } };
      await expect(call(service)).rejects.toBeInstanceOf(ConflictError);
      resetFailure();
      await (service as { shutdown(): Promise<void> }).shutdown();
    }
  );

  it.each(cases)(
    "$name maps a transport failure to InternalError",
    async ({ name }) => {
      const makeUnreachable: Record<string, () => Promise<unknown>> = {
        Discord: async () => {
          const service = new DiscordService();
          await service.initialize({
            token: "t",
            baseUrl: "http://127.0.0.1:1/api",
            timeout: 500,
          });
          return service;
        },
        WhatsApp: async () => {
          const service = new WhatsAppService();
          await service.initialize({
            token: "t",
            phoneNumberId: "P",
            baseUrl: "http://127.0.0.1:1",
            timeout: 500,
          });
          return service;
        },
        "Microsoft Outlook": async () => {
          const service = new MicrosoftOutlookService();
          await service.initialize({
            token: "t",
            baseUrl: "http://127.0.0.1:1",
            timeout: 500,
          });
          return service;
        },
        "Microsoft Excel": async () => {
          const service = new MicrosoftExcelService();
          await service.initialize({
            token: "t",
            baseUrl: "http://127.0.0.1:1",
            timeout: 500,
          });
          return service;
        },
        Confluence: async () => {
          const service = new ConfluenceService();
          await service.initialize({
            token: "t",
            baseUrl: "http://127.0.0.1:1",
            timeout: 500,
          });
          return service;
        },
        Jira: async () => {
          const service = new JiraService();
          await service.initialize({
            token: "t",
            baseUrl: "http://127.0.0.1:1",
            timeout: 500,
          });
          return service;
        },
        "Google Docs": async () => {
          const service = new GoogleDocsService();
          await service.initialize({
            token: "t",
            baseUrl: "http://127.0.0.1:1",
            timeout: 500,
          });
          return service;
        },
        "Microsoft SharePoint": async () => {
          const service = new MicrosoftSharePointService();
          await service.initialize({
            token: "t",
            baseUrl: "http://127.0.0.1:1",
            timeout: 500,
          });
          return service;
        },
        "Google Calendar": async () => {
          const service = new GoogleCalendarService();
          await service.initialize({
            token: "t",
            baseUrl: "http://127.0.0.1:1",
            timeout: 500,
          });
          return service;
        },
      };
      const unreachable = await makeUnreachable[name]();
      const call = cases.find((entry) => entry.name === name)!.call;
      await expect(call(unreachable)).rejects.toBeInstanceOf(InternalError);
      await (unreachable as { shutdown(): Promise<void> }).shutdown();
    }
  );
});

describe("Stage 5c vendor service contracts — environment slices", () => {
  it("resolves every vendor slice from its double-underscore env key", async () => {
    process.env["COMMS__DISCORD__TOKEN"] = "env-discord";
    process.env["COMMS__DISCORD__BASE_URL"] = `${http.baseUrl}/api/v10`;
    process.env["COMMS__WHATS_APP__TOKEN"] = "env-whatsapp";
    process.env["COMMS__WHATS_APP__PHONE_NUMBER_ID"] = "ENVPHONE";
    process.env["COMMS__WHATS_APP__BASE_URL"] = `${http.baseUrl}/v19.0`;
    process.env["COMMS__OUTLOOK__TOKEN"] = "env-outlook";
    process.env["COMMS__OUTLOOK__BASE_URL"] = `${http.baseUrl}/v1.0`;
    process.env["IO__MICROSOFT_EXCEL__TOKEN"] = "env-excel";
    process.env["IO__MICROSOFT_EXCEL__BASE_URL"] = `${http.baseUrl}/v1.0`;
    process.env["IO__CONFLUENCE__USERNAME"] = "env-user";
    process.env["IO__CONFLUENCE__TOKEN"] = "env-confluence";
    process.env["IO__CONFLUENCE__BASE_URL"] = `${http.baseUrl}/wiki`;
    process.env["IO__JIRA__USERNAME"] = "env-user";
    process.env["IO__JIRA__TOKEN"] = "env-jira";
    process.env["IO__JIRA__BASE_URL"] = `${http.baseUrl}/jira`;
    process.env["IO__GOOGLE_DOCS__TOKEN"] = "env-docs";
    process.env["IO__GOOGLE_DOCS__BASE_URL"] = `${http.baseUrl}/v1`;
    process.env["IO__MICROSOFT_SHARE_POINT__TOKEN"] = "env-sharepoint";
    process.env["IO__MICROSOFT_SHARE_POINT__BASE_URL"] = `${http.baseUrl}/v1.0`;
    process.env["CALENDAR__GOOGLE_CALENDAR__TOKEN"] = "env-calendar";
    process.env["CALENDAR__GOOGLE_CALENDAR__CALENDAR_ID"] = "ENVCAL";
    process.env["CALENDAR__GOOGLE_CALENDAR__BASE_URL"] = `${http.baseUrl}/calendar/v3`;

    const discord = new DiscordService();
    await discord.initialize({});
    expect(configOf(discord).token).toBe("env-discord");
    await discord.getChannel("C1");
    expect(
      requestFor((r) => decodedPath(r) === "/api/v10/channels/C1").headers
        .authorization
    ).toBe("Bot env-discord");
    await discord.shutdown();

    const whatsapp = new WhatsAppService();
    await whatsapp.initialize({});
    expect(configOf(whatsapp).phoneNumberId).toBe("ENVPHONE");
    await whatsapp.sendText({ to: "1", text: "x" });
    expect(
      requestFor((r) => decodedPath(r) === "/v19.0/ENVPHONE/messages").headers
        .authorization
    ).toBe("Bearer env-whatsapp");
    await whatsapp.shutdown();

    const outlook = new MicrosoftOutlookService();
    await outlook.initialize({});
    expect(configOf(outlook).token).toBe("env-outlook");
    await outlook.listMessages();
    expect(
      requestFor(
        (r) => decodedPath(r) === "/v1.0/me/mailFolders/inbox/messages"
      ).headers.authorization
    ).toBe("Bearer env-outlook");
    await outlook.shutdown();

    const excel = new MicrosoftExcelService();
    await excel.initialize({});
    expect(configOf(excel).token).toBe("env-excel");
    await excel.listWorksheets({ itemId: "I" });
    expect(
      requestFor(
        (r) => decodedPath(r) === "/v1.0/me/drive/items/I/workbook/worksheets"
      ).headers.authorization
    ).toBe("Bearer env-excel");
    await excel.shutdown();

    const confluence = new ConfluenceService();
    await confluence.initialize({});
    expect(configOf(confluence).username).toBe("env-user");
    await confluence.listSpaces();
    expect(
      requestFor((r) => decodedPath(r) === "/wiki/rest/api/space").headers
        .authorization
    ).toBe(`Basic ${Buffer.from("env-user:env-confluence").toString("base64")}`);
    await confluence.shutdown();

    const jira = new JiraService();
    await jira.initialize({});
    expect(configOf(jira).username).toBe("env-user");
    await jira.getIssue("P-1");
    expect(
      requestFor((r) => decodedPath(r) === "/jira/rest/api/2/issue/P-1").headers
        .authorization
    ).toBe(`Basic ${Buffer.from("env-user:env-jira").toString("base64")}`);
    await jira.shutdown();

    const docs = new GoogleDocsService();
    await docs.initialize({});
    expect(configOf(docs).token).toBe("env-docs");
    await docs.getDocument("D1");
    expect(
      requestFor((r) => decodedPath(r) === "/v1/documents/D1").headers
        .authorization
    ).toBe("Bearer env-docs");
    await docs.shutdown();

    const sharepoint = new MicrosoftSharePointService();
    await sharepoint.initialize({});
    expect(configOf(sharepoint).token).toBe("env-sharepoint");
    await sharepoint.getSite("S1");
    expect(
      requestFor((r) => decodedPath(r) === "/v1.0/sites/S1").headers
        .authorization
    ).toBe("Bearer env-sharepoint");
    await sharepoint.shutdown();

    const calendar = new GoogleCalendarService();
    await calendar.initialize({});
    expect(configOf(calendar).calendarId).toBe("ENVCAL");
    await calendar.listEvents();
    expect(
      requestFor(
        (r) => decodedPath(r) === "/calendar/v3/calendars/ENVCAL/events"
      ).headers.authorization
    ).toBe("Bearer env-calendar");
    await calendar.shutdown();
  });
});

describe("Stage 5c vendor service contracts — public subpath exports", () => {
  it("publishes a package subpath export for every vendor service", () => {
    const packageJson = JSON.parse(
      readFileSync(
        resolve(__dirname, "../../../../../../integrations/package.json"),
        "utf8"
      )
    ) as { exports?: Record<string, unknown> };
    const expected = [
      "./comms/discord",
      "./comms/whatsapp",
      "./comms/outlook",
      "./io/microsoft-excel",
      "./io/confluence",
      "./io/jira",
      "./io/google-docs",
      "./io/microsoft-sharepoint",
      "./calendar/google-calendar",
    ];
    for (const subpath of expected) {
      expect(packageJson.exports?.[subpath]).toBeDefined();
    }
  });
});

describe("Stage 5c vendor service contracts — required configuration", () => {
  it("Jira and Confluence fail closed without a base URL", async () => {
    await expect(new JiraService().initialize({})).rejects.toBeInstanceOf(
      InternalError
    );
    await expect(
      new ConfluenceService().initialize({})
    ).rejects.toBeInstanceOf(InternalError);
  });

  it("keeps the provider default base URLs", async () => {
    const cases = [
      [new DiscordService(), "https://discord.com/api/v10"],
      [new WhatsAppService(), "https://graph.facebook.com/v19.0"],
      [new MicrosoftOutlookService(), "https://graph.microsoft.com/v1.0"],
      [new MicrosoftExcelService(), "https://graph.microsoft.com/v1.0"],
      [new GoogleDocsService(), "https://docs.googleapis.com/v1"],
      [new MicrosoftSharePointService(), "https://graph.microsoft.com/v1.0"],
      [
        new GoogleCalendarService(),
        "https://www.googleapis.com/calendar/v3",
      ],
    ] as const;
    for (const [service, expected] of cases) {
      const { client } = await service.initialize({ token: "t" });
      expect(client.defaults.baseURL).toBe(expected);
      await service.shutdown();
    }
  });
});
