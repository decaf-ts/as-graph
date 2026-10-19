/**
 * @module as-graph/tests/integration/graph/nodes/comms/commsNodes
 * @summary SAA-1027 Stage 3b: node→service integration coverage for the five
 * comms node kinds.
 * @description The Slack, Telegram, Teams, Gmail and Email vendors have no live
 * credentials in this workspace, so each suite runs the production node
 * instantiation/execution contract against a process-local loopback HTTP stub
 * (or SMTP stub for the SMTP email path) and asserts the exact request the real
 * integration service emitted. IMAP is exercised through the absent optional
 * `imapflow` dependency to prove the dynamic-load fallback.
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
  runNode,
  setCredential,
} from "../real-service-support";
import {
  startHttpStub,
  startSmtpStub,
  type HttpStub,
  type SmtpStub,
  type StubRequest,
} from "../loopback-support";

jest.setTimeout(60000);

const SECRETS = {
  slack: "xoxb-saa1035-slack-secret",
  telegram: "123456:saa1035-telegram-secret",
  teams: "saa1035-teams-secret",
  gmail: "saa1035-gmail-secret",
  graph: "saa1035-graph-secret",
} as const;

const CREDENTIALS = {
  slack: credential("GRAPH_CREDENTIAL_SAA1035_SLACK", "slack"),
  telegram: credential("GRAPH_CREDENTIAL_SAA1035_TELEGRAM", "telegram"),
  teams: credential("GRAPH_CREDENTIAL_SAA1035_TEAMS", "teams"),
  teamsWebhook: credential(
    "GRAPH_CREDENTIAL_SAA1035_TEAMS_WEBHOOK",
    "teams"
  ),
  gmail: credential("GRAPH_CREDENTIAL_SAA1035_GMAIL", "gmail"),
  email: credential("GRAPH_CREDENTIAL_SAA1035_EMAIL", "email"),
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

describe("core.comms.* node → service integration (loopback vendors)", () => {
  let http: HttpStub;
  let smtp: SmtpStub;

  beforeAll(async () => {
    smtp = await startSmtpStub();
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

    setCredential("GRAPH_CREDENTIAL_SAA1035_SLACK", SECRETS.slack);
    setCredential("GRAPH_CREDENTIAL_SAA1035_TELEGRAM", SECRETS.telegram);
    setCredential("GRAPH_CREDENTIAL_SAA1035_TEAMS", SECRETS.teams);
    setCredential(
      "GRAPH_CREDENTIAL_SAA1035_TEAMS_WEBHOOK",
      JSON.stringify({ webhookUrl: `${http.baseUrl}/webhook` })
    );
    setCredential("GRAPH_CREDENTIAL_SAA1035_GMAIL", SECRETS.gmail);
    setCredential(
      "GRAPH_CREDENTIAL_SAA1035_EMAIL",
      JSON.stringify({ provider: "graph", token: SECRETS.graph })
    );
  });

  afterAll(async () => {
    clearCredentials(
      "GRAPH_CREDENTIAL_SAA1035_SLACK",
      "GRAPH_CREDENTIAL_SAA1035_TELEGRAM",
      "GRAPH_CREDENTIAL_SAA1035_TEAMS",
      "GRAPH_CREDENTIAL_SAA1035_TEAMS_WEBHOOK",
      "GRAPH_CREDENTIAL_SAA1035_GMAIL",
      "GRAPH_CREDENTIAL_SAA1035_EMAIL"
    );
    await http.close();
    await smtp.close();
  });

  it("Slack posts a message with the bearer token and reports channel/ts", async () => {
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

  it("Slack lists conversations, fetches one and reads a user", async () => {
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

  it("Slack maps a vendor ok:false response to a graph execution error", async () => {
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

  it("Telegram sends messages, reads bot identity, updates and chat actions", async () => {
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

  it("Teams delivers a webhook and the Graph channel/list operations", async () => {
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

  it("Gmail sends MIME, lists, reads and labels messages", async () => {
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
    clearCredentials("GRAPH_CREDENTIAL_SAA1035_EMAIL");
    setCredential(
      "GRAPH_CREDENTIAL_SAA1035_EMAIL",
      JSON.stringify({
        provider: "smtp",
        from: "smtp-sender@example.com",
      })
    );
    const smtpResult = await runNode(
      EmailSendNode,
      "core.comms.emailSend",
      {
        operation: "send",
        provider: "smtp",
        host: smtp.host,
        port: smtp.port,
        secure: false,
        to: ["smtp-recipient@example.com"],
        subject: "SAA-1035 smtp",
        text: "smtp body",
      },
      {},
      CREDENTIALS.email
    );
    expect(smtpResult.result).toMatchObject({
      from: "smtp-sender@example.com",
      recipients: ["smtp-recipient@example.com"],
      provider: "smtp",
    });
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0].from).toBe("smtp-sender@example.com");
    expect(smtp.messages[0].recipients).toEqual([
      "smtp-recipient@example.com",
    ]);
    expect(smtp.messages[0].raw).toContain("Subject: SAA-1035 smtp");

    setCredential(
      "GRAPH_CREDENTIAL_SAA1035_EMAIL",
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

  it("Email IMAP fails closed with the optional-dependency message when imapflow is absent", async () => {
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
  });

  it("never echoes a vendor secret into a node result", async () => {
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
