/**
 * @module as-graph/tests/integration/graph/nodes/comms/commsNodes
 * @summary SAA-1027 Stage 3b: node→service integration coverage for the five
 * comms node kinds.
 * @description The Slack, Telegram, Teams and Gmail suites are **contract**
 * coverage: they run the production node instantiation/execution contract
 * against a process-local loopback HTTP stub and assert the exact request the
 * real integration service emitted. That block is explicitly not a live-matrix
 * PASS. The live success path for those four SaaS vendors is credential-gated
 * and skips with the exact missing variable when the operator has not supplied
 * real access: `AS_GRAPH_IT_SLACK_BOT_TOKEN`,
 * `AS_GRAPH_IT_TELEGRAM_BOT_TOKEN`, `AS_GRAPH_IT_TEAMS_WEBHOOK_URL`, and
 * `AS_GRAPH_IT_GMAIL_ACCESS_TOKEN` (+ optional `AS_GRAPH_IT_GMAIL_USER_ID`).
 * The Email vendor is live against the Mailpit container (`AS_GRAPH_IT_SMTP_*`,
 * `AS_GRAPH_IT_MAILPIT_HTTP`) and keeps its loopback Graph-inbox contract case.
 * The IMAP dynamic-load fallback is exercised only when the optional
 * `imapflow` package is not installed in this workspace.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { SlackNode } from "../../../../../src/node/comms/slack/node";
import { TelegramNode } from "../../../../../src/node/comms/telegram/node";
import { TeamsNode } from "../../../../../src/node/comms/teams/node";
import { GmailNode } from "../../../../../src/node/comms/gmail/node";
import { EmailSendNode } from "../../../../../src/node/comms/email-send/node";
import {
  credential,
  clearCredentials,
  ENDPOINTS,
  runNode,
  setCredential,
} from "../real-service-support";
import {
  startHttpStub,
  type HttpStub,
  type StubRequest,
} from "../loopback-support";
import { credentialGatedIt, envValue } from "../credential-gated";

jest.setTimeout(60000);

const imapflowInstalled = (() => {
  try {
    require.resolve("imapflow");
    return true;
  } catch {
    return false;
  }
})();

const SECRETS = {
  slack: "xoxb-saa1035-slack-secret",
  telegram: "123456:saa1035-telegram-secret",
  teams: "saa1035-teams-secret",
  gmail: "saa1035-gmail-secret",
  graph: "saa1035-graph-secret",
} as const;

const CREDENTIALS = {
  slack: credential("it-saa1035-SLACK", "slack"),
  telegram: credential("it-saa1035-TELEGRAM", "telegram"),
  teams: credential("it-saa1035-TEAMS", "teams"),
  teamsWebhook: credential(
    "it-saa1035-TEAMS_WEBHOOK",
    "teams"
  ),
  gmail: credential("it-saa1035-GMAIL", "gmail"),
  email: credential("it-saa1035-EMAIL", "email"),
} as const;

interface CommsReply {
  body: Record<string, unknown>;
}

function stubReply(
  request: StubRequest,
  handler: (request: StubRequest) => CommsReply
): CommsReply {
  return handler(request);
}

describe("core.comms.* vendor contract (loopback stub; NOT a live-matrix claim)", () => {
  let http: HttpStub;

  beforeAll(async () => {
    http = await startHttpStub((request) =>
      stubReply(request, (value) => {
        const body = (value.body ?? {}) as Record<string, unknown>;
        const path = value.path;

        if (path === "/api/chat.postMessage") {
          if (body.channel === "C-FAIL") {
            return { body: { ok: false, error: "channel_not_found" } };
          }
          return {
            body: {
              ok: true,
              channel: body.channel,
              ts: "1700000000.000100",
              text: body.text,
            },
          };
        }
        if (path === "/api/conversations.list") {
          return {
            body: {
              ok: true,
              channels: [
                {
                  id: "C-SAA1035",
                  name: "general",
                  is_private: false,
                  num_members: 3,
                  topic: { value: "topic" },
                  purpose: { value: "purpose" },
                },
              ],
              response_metadata: { next_cursor: "cursor-2" },
            },
          };
        }
        if (path === "/api/conversations.info") {
          return {
            body: {
              ok: true,
              channel: {
                id: body.channel,
                name: "general",
                num_members: 4,
              },
            },
          };
        }
        if (path === "/api/users.info") {
          return {
            body: { ok: true, user: { id: body.user, name: "tester" } },
          };
        }

        if (path.startsWith("/bot") && path.endsWith("/sendMessage")) {
          return {
            body: {
              ok: true,
              result: {
                message_id: 42,
                date: 1700000000,
                chat: { id: Number(body.chat_id) },
                text: body.text,
              },
            },
          };
        }
        if (path.startsWith("/bot") && path.endsWith("/getMe")) {
          return {
            body: {
              ok: true,
              result: { id: 7, is_bot: true, username: "saa1035_bot" },
            },
          };
        }
        if (path.startsWith("/bot") && path.endsWith("/getUpdates")) {
          return { body: { ok: true, result: [{ update_id: 1 }] } };
        }
        if (path.startsWith("/bot") && path.endsWith("/sendChatAction")) {
          return { body: { ok: true, result: true } };
        }

        if (path === "/webhook") {
          return { body: { ok: true, received: body.text } };
        }
        if (path === "/v1.0/teams/T-SAA1035/channels/C-SAA1035/messages") {
          return { body: { id: "teams-message-1" } };
        }
        if (path === "/v1.0/teams") {
          return { body: { value: [{ id: "T-SAA1035", displayName: "Team" }] } };
        }
        if (path === "/v1.0/teams/T-SAA1035/channels") {
          return { body: { value: [{ id: "C-SAA1035" }] } };
        }

        if (path === "/gmail/v1/users/me/messages/send") {
          return {
            body: { id: "gmail-message-1", threadId: "thread-1", labelIds: ["SENT"] },
          };
        }
        if (path === "/gmail/v1/users/me/messages") {
          return {
            body: {
              messages: [{ id: "gmail-1", threadId: "thread-1" }],
              nextPageToken: "page-2",
              resultSizeEstimate: 1,
            },
          };
        }
        if (path === "/gmail/v1/users/me/messages/gmail-1") {
          return { body: { id: "gmail-1", snippet: "hello" } };
        }
        if (path === "/gmail/v1/users/me/labels") {
          return { body: { labels: [{ id: "INBOX", name: "INBOX" }] } };
        }

        if (path === "/graph/me/messages") {
          return { body: { value: [{ id: "graph-1", subject: "hello" }] } };
        }

        return { status: 404, body: { error: `unhandled ${path}` } };
      })
    );

    setCredential("it-saa1035-SLACK", SECRETS.slack);
    setCredential("it-saa1035-TELEGRAM", SECRETS.telegram);
    setCredential("it-saa1035-TEAMS", SECRETS.teams);
    setCredential(
      "it-saa1035-TEAMS_WEBHOOK",
      JSON.stringify({ webhookUrl: `${http.baseUrl}/webhook` })
    );
    setCredential("it-saa1035-GMAIL", SECRETS.gmail);
    setCredential(
      "it-saa1035-EMAIL",
      JSON.stringify({ provider: "graph", token: SECRETS.graph })
    );
  });

  afterAll(async () => {
    clearCredentials(
      "it-saa1035-SLACK",
      "it-saa1035-TELEGRAM",
      "it-saa1035-TEAMS",
      "it-saa1035-TEAMS_WEBHOOK",
      "it-saa1035-GMAIL",
      "it-saa1035-EMAIL"
    );
    await http.close();
  });

  it("contract: Slack posts a message with the bearer token and reports channel/ts", async () => {
    const before = http.requests.length;
    const result = await runNode(
      SlackNode,
      "core.comms.slack",
      {
        operation: "postMessage",
        channel: "C-SAA1035",
        text: "hello slack",
        baseUrl: `${http.baseUrl}/api`,
      },
      {},
      CREDENTIALS.slack
    );

    expect(result.result).toMatchObject({
      channel: "C-SAA1035",
      ts: "1700000000.000100",
    });
    expect(result.channel).toBe("C-SAA1035");
    expect(result.ts).toBe("1700000000.000100");
    const request = http.requests[before];
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/api/chat.postMessage");
    expect(request.headers.authorization).toBe(`Bearer ${SECRETS.slack}`);
    expect(request.body).toMatchObject({
      channel: "C-SAA1035",
      text: "hello slack",
    });
  });

  it("contract: Slack lists conversations, fetches one and reads a user", async () => {
    const listed = await runNode(
      SlackNode,
      "core.comms.slack",
      { operation: "listConversations", limit: 5, baseUrl: `${http.baseUrl}/api` },
      {},
      CREDENTIALS.slack
    );
    expect(listed.result).toMatchObject({
      channels: [{ id: "C-SAA1035", memberCount: 3 }],
      nextCursor: "cursor-2",
    });

    const conversation = await runNode(
      SlackNode,
      "core.comms.slack",
      {
        operation: "getConversation",
        channel: "C-SAA1035",
        baseUrl: `${http.baseUrl}/api`,
      },
      {},
      CREDENTIALS.slack
    );
    expect(conversation.channel).toBe("C-SAA1035");

    const user = await runNode(
      SlackNode,
      "core.comms.slack",
      {
        operation: "getUser",
        userId: "U-SAA1035",
        baseUrl: `${http.baseUrl}/api`,
      },
      {},
      CREDENTIALS.slack
    );
    expect(user.result).toEqual({ id: "U-SAA1035", name: "tester" });
  });

  it("contract: Slack maps a vendor ok:false response to a graph execution error", async () => {
    await expect(
      runNode(
        SlackNode,
        "core.comms.slack",
        {
          operation: "postMessage",
          channel: "C-FAIL",
          text: "nope",
          baseUrl: `${http.baseUrl}/api`,
        },
        {},
        CREDENTIALS.slack
      )
    ).rejects.toMatchObject({
      graphCode: "GRAPH_SLACK_OPERATION_FAILED",
      message: expect.stringContaining("channel_not_found"),
    });
  });

  it("contract: Telegram sends messages, reads bot identity, updates and chat actions", async () => {
    const before = http.requests.length;
    const sent = await runNode(
      TelegramNode,
      "core.comms.telegram",
      {
        operation: "sendMessage",
        chatId: 1001,
        text: "hello telegram",
        baseUrl: http.baseUrl,
      },
      {},
      CREDENTIALS.telegram
    );
    expect(sent.result).toMatchObject({ message_id: 42, text: "hello telegram" });
    expect(sent.messageId).toBe(42);
    expect(http.requests[before].path).toBe(
      `/bot${SECRETS.telegram}/sendMessage`
    );

    const me = await runNode(
      TelegramNode,
      "core.comms.telegram",
      { operation: "getMe", baseUrl: http.baseUrl },
      {},
      CREDENTIALS.telegram
    );
    expect(me.result).toMatchObject({ username: "saa1035_bot" });

    const updates = await runNode(
      TelegramNode,
      "core.comms.telegram",
      { operation: "getUpdates", limit: 10, baseUrl: http.baseUrl },
      {},
      CREDENTIALS.telegram
    );
    expect(updates.result).toEqual([{ update_id: 1 }]);

    const action = await runNode(
      TelegramNode,
      "core.comms.telegram",
      {
        operation: "sendChatAction",
        chatId: 1001,
        action: "typing",
        baseUrl: http.baseUrl,
      },
      {},
      CREDENTIALS.telegram
    );
    expect(action.result).toBe(true);
  });

  it("contract: Teams delivers a webhook and the Graph channel/list operations", async () => {
    const webhook = await runNode(
      TeamsNode,
      "core.comms.teams",
      { operation: "sendWebhook", text: "webhook hello", title: "SAA-1035" },
      {},
      CREDENTIALS.teamsWebhook
    );
    expect(webhook.result).toEqual({ ok: true, received: "webhook hello" });

    const channel = await runNode(
      TeamsNode,
      "core.comms.teams",
      {
        operation: "sendChannelMessage",
        teamId: "T-SAA1035",
        channelId: "C-SAA1035",
        content: "channel hello",
        baseUrl: `${http.baseUrl}/v1.0`,
      },
      {},
      CREDENTIALS.teams
    );
    expect(channel.result).toEqual({ id: "teams-message-1" });

    const teams = await runNode(
      TeamsNode,
      "core.comms.teams",
      { operation: "listTeams", limit: 5, baseUrl: `${http.baseUrl}/v1.0` },
      {},
      CREDENTIALS.teams
    );
    expect(teams.result).toEqual([
      { id: "T-SAA1035", displayName: "Team" },
    ]);

    const channels = await runNode(
      TeamsNode,
      "core.comms.teams",
      {
        operation: "listChannels",
        teamId: "T-SAA1035",
        baseUrl: `${http.baseUrl}/v1.0`,
      },
      {},
      CREDENTIALS.teams
    );
    expect(channels.result).toEqual([{ id: "C-SAA1035" }]);
  });

  it("contract: Gmail sends MIME, lists, reads and labels messages", async () => {
    const before = http.requests.length;
    const sent = await runNode(
      GmailNode,
      "core.comms.gmail",
      {
        operation: "send",
        from: "sender@example.com",
        to: ["recipient@example.com"],
        subject: "SAA-1035 gmail",
        text: "gmail body",
        baseUrl: `${http.baseUrl}/gmail/v1`,
      },
      {},
      CREDENTIALS.gmail
    );
    expect(sent.result).toMatchObject({ id: "gmail-message-1" });
    expect(sent.id).toBe("gmail-message-1");

    const sendRequest = http.requests[before];
    const sendBody = sendRequest.body as { raw: string };
    const decoded = Buffer.from(sendBody.raw, "base64url").toString("utf8");
    expect(decoded).toContain("Subject: SAA-1035 gmail");
    expect(decoded).toContain("To: recipient@example.com");

    const listed = await runNode(
      GmailNode,
      "core.comms.gmail",
      {
        operation: "list",
        query: "subject:SAA-1035",
        maxResults: 5,
        baseUrl: `${http.baseUrl}/gmail/v1`,
      },
      {},
      CREDENTIALS.gmail
    );
    expect(listed.result).toMatchObject({
      messages: [{ id: "gmail-1" }],
      nextPageToken: "page-2",
    });

    const message = await runNode(
      GmailNode,
      "core.comms.gmail",
      {
        operation: "get",
        messageId: "gmail-1",
        format: "minimal",
        baseUrl: `${http.baseUrl}/gmail/v1`,
      },
      {},
      CREDENTIALS.gmail
    );
    expect(message.result).toMatchObject({ id: "gmail-1" });

    const labels = await runNode(
      GmailNode,
      "core.comms.gmail",
      {
        operation: "labels",
        baseUrl: `${http.baseUrl}/gmail/v1`,
      },
      {},
      CREDENTIALS.gmail
    );
    expect(labels.result).toEqual([{ id: "INBOX", name: "INBOX" }]);
  });

  it("Email sends over SMTP and lists a Graph inbox", async () => {
    clearCredentials("it-saa1035-EMAIL");
    setCredential(
      "it-saa1035-EMAIL",
      JSON.stringify({
        provider: "smtp",
        from: "smtp-sender@example.com",
      })
    );
    const subject = `SAA-1144 mailpit ${Date.now()}`;
    const smtpResult = await runNode(
      EmailSendNode,
      "core.comms.emailSend",
      {
        operation: "send",
        provider: "smtp",
        host: ENDPOINTS.mailpit.host,
        port: ENDPOINTS.mailpit.port,
        secure: false,
        to: ["smtp-recipient@example.com"],
        subject,
        text: "smtp body via live Mailpit",
      },
      {},
      CREDENTIALS.email
    );
    expect(smtpResult.result).toMatchObject({
      from: "smtp-sender@example.com",
      recipients: ["smtp-recipient@example.com"],
      provider: "smtp",
    });

    const listed = await fetch(
      `${ENDPOINTS.mailpit.httpUrl}/api/v1/messages?limit=50`
    );
    expect(listed.ok).toBe(true);
    const mailpitInbox = (await listed.json()) as {
      messages?: Array<{ ID: string; Subject?: string; To?: Array<{ Address: string }> }>;
    };
    const delivered = mailpitInbox.messages?.find(
      (message) => message.Subject === subject
    );
    expect(delivered).toBeDefined();
    expect(delivered!.To?.map((entry) => entry.Address)).toContain(
      "smtp-recipient@example.com"
    );

    const raw = await fetch(
      `${ENDPOINTS.mailpit.httpUrl}/api/v1/message/${delivered!.ID}`
    );
    expect(raw.ok).toBe(true);
    const body = (await raw.json()) as { Text?: string };
    expect(body.Text).toContain("smtp body via live Mailpit");

    setCredential(
      "it-saa1035-EMAIL",
      JSON.stringify({ provider: "graph", token: SECRETS.graph })
    );
    const inbox = await runNode(
      EmailSendNode,
      "core.comms.emailSend",
      {
        operation: "listInbox",
        limit: 5,
        baseUrl: `${http.baseUrl}/graph`,
      },
      {},
      CREDENTIALS.email
    );
    expect(inbox.result).toEqual([{ id: "graph-1", subject: "hello" }]);
  });

  (imapflowInstalled ? it.skip : it)(
    "Email IMAP fails closed with the optional-dependency message when imapflow is absent",
    async () => {
    await expect(
      runNode(
        EmailSendNode,
        "core.comms.emailSend",
        {
          operation: "listImap",
          host: "127.0.0.1",
          port: 143,
          secure: false,
        },
        {},
        CREDENTIALS.email
      )
      ).rejects.toMatchObject({
        graphCode: "GRAPH_EMAIL_OPERATION_FAILED",
        message: expect.stringContaining("optional 'imapflow' package"),
      });
    }
  );

  it("contract: never echoes a vendor secret into a node result", async () => {
    const result = await runNode(
      SlackNode,
      "core.comms.slack",
      {
        operation: "postMessage",
        channel: "C-SAA1035",
        text: "no leak",
        baseUrl: `${http.baseUrl}/api`,
      },
      {},
      CREDENTIALS.slack
    );
    const serialized = JSON.stringify(result);
    for (const secret of Object.values(SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
  });
});

/**
 * Live SaaS success paths. These are the only cases the node-kind matrix may
 * count as live for Slack, Telegram, Teams and Gmail; the loopback block above
 * is contract coverage and must never be reported as a live PASS.
 */
describe("core.comms.* live SaaS integration (credential-gated)", () => {
  credentialGatedIt(
    "live: Slack lists one conversation with a real bot token",
    ["AS_GRAPH_IT_SLACK_BOT_TOKEN"],
    async () => {
      const id = "it-live-SLACK";
      setCredential(id, envValue("AS_GRAPH_IT_SLACK_BOT_TOKEN"));
      try {
        const result = await runNode(
          SlackNode,
          "core.comms.slack",
          { operation: "listConversations", limit: 1 },
          {},
          credential(id, "slack")
        );
        const body = result.result as { channels?: unknown[] };
        expect(body).toBeDefined();
        expect(Array.isArray(body.channels)).toBe(true);
      } finally {
        clearCredentials(id);
      }
    }
  );

  credentialGatedIt(
    "live: Telegram getMe returns the bot identity",
    ["AS_GRAPH_IT_TELEGRAM_BOT_TOKEN"],
    async () => {
      const id = "it-live-TELEGRAM";
      setCredential(id, envValue("AS_GRAPH_IT_TELEGRAM_BOT_TOKEN"));
      try {
        const result = await runNode(
          TelegramNode,
          "core.comms.telegram",
          { operation: "getMe" },
          {},
          credential(id, "telegram")
        );
        expect(result.result).toMatchObject({ is_bot: true });
      } finally {
        clearCredentials(id);
      }
    }
  );

  credentialGatedIt(
    "live: Teams delivers a webhook message",
    ["AS_GRAPH_IT_TEAMS_WEBHOOK_URL"],
    async () => {
      const id = "it-live-TEAMS";
      setCredential(
        id,
        JSON.stringify({ webhookUrl: envValue("AS_GRAPH_IT_TEAMS_WEBHOOK_URL") })
      );
      try {
        const result = await runNode(
          TeamsNode,
          "core.comms.teams",
          {
            operation: "sendWebhook",
            title: "as-graph live IT",
            text: `as-graph live IT ${Date.now()}`,
          },
          {},
          credential(id, "teams-webhook")
        );
        expect(result).toHaveProperty("result");
      } finally {
        clearCredentials(id);
      }
    }
  );

  credentialGatedIt(
    "live: Gmail lists labels with a real access token",
    ["AS_GRAPH_IT_GMAIL_ACCESS_TOKEN"],
    async () => {
      const id = "it-live-GMAIL";
      setCredential(
        id,
        JSON.stringify({
          token: envValue("AS_GRAPH_IT_GMAIL_ACCESS_TOKEN"),
          ...(process.env["AS_GRAPH_IT_GMAIL_USER_ID"]
            ? { userId: envValue("AS_GRAPH_IT_GMAIL_USER_ID") }
            : {}),
        })
      );
      try {
        const result = await runNode(
          GmailNode,
          "core.comms.gmail",
          { operation: "labels" },
          {},
          credential(id, "gmail")
        );
        expect(Array.isArray(result.result)).toBe(true);
      } finally {
        clearCredentials(id);
      }
    }
  );
});
