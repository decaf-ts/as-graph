/**
 * @module as-graph/tests/integration/graph/nodes/credentialsStage3b
 * @summary SAA-1027 Stage 3b: every credential-bearing node fails closed before
 * touching its vendor.
 * @description Each kind is driven with a mismatched credential type (and two
 * representative malformed references) against a loopback HTTP stub. The suite
 * asserts the runtime error code and that the stub received zero requests, so a
 * credential failure can never leak a partial call to Slack, Telegram, Teams,
 * Gmail, Email, GitHub, GitLab, Google Sheets, Airtable or GraphQL.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import type { GraphNodeClass } from "../../../../src/node/base";
import { GithubNode } from "../../../../src/node/devops/github/node";
import { GitlabNode } from "../../../../src/node/devops/gitlab/node";
import { SlackNode } from "../../../../src/node/comms/slack/node";
import { TelegramNode } from "../../../../src/node/comms/telegram/node";
import { TeamsNode } from "../../../../src/node/comms/teams/node";
import { GmailNode } from "../../../../src/node/comms/gmail/node";
import { EmailSendNode } from "../../../../src/node/comms/email-send/node";
import { GoogleSheetsNode } from "../../../../src/node/io/google-sheets/node";
import { AirtableNode } from "../../../../src/node/io/airtable/node";
import { GraphqlNode } from "../../../../src/node/io/graphql/node";
import {
  credential,
  clearCredentials,
  runNode,
  setCredential,
} from "./real-service-support";
import { startHttpStub, type HttpStub } from "./loopback-support";

jest.setTimeout(60000);

interface FailClosedCase {
  kind: string;
  nodeClass: GraphNodeClass;
  parameters(baseUrl: string): Record<string, unknown>;
  expectedType: string;
}

const CASES: FailClosedCase[] = [
  {
    kind: "core.devops.github",
    nodeClass: GithubNode,
    expectedType: "github",
    parameters: (baseUrl) => ({
      operation: "getRepo",
      owner: "acme",
      repo: "widgets",
      baseUrl,
    }),
  },
  {
    kind: "core.devops.gitlab",
    nodeClass: GitlabNode,
    expectedType: "gitlab",
    parameters: (baseUrl) => ({
      operation: "getProject",
      projectId: "acme/widgets",
      baseUrl,
    }),
  },
  {
    kind: "core.comms.slack",
    nodeClass: SlackNode,
    expectedType: "slack",
    parameters: (baseUrl) => ({
      operation: "postMessage",
      channel: "C-SAA1035",
      text: "should not send",
      baseUrl,
    }),
  },
  {
    kind: "core.comms.telegram",
    nodeClass: TelegramNode,
    expectedType: "telegram",
    parameters: (baseUrl) => ({
      operation: "sendMessage",
      chatId: 1001,
      text: "should not send",
      baseUrl,
    }),
  },
  {
    kind: "core.comms.teams",
    nodeClass: TeamsNode,
    expectedType: "teams",
    parameters: (baseUrl) => ({
      operation: "sendWebhook",
      text: "should not send",
      baseUrl,
    }),
  },
  {
    kind: "core.comms.gmail",
    nodeClass: GmailNode,
    expectedType: "gmail",
    parameters: (baseUrl) => ({
      operation: "labels",
      baseUrl,
    }),
  },
  {
    kind: "core.comms.emailSend",
    nodeClass: EmailSendNode,
    expectedType: "email",
    parameters: (baseUrl) => ({
      operation: "listInbox",
      baseUrl,
    }),
  },
  {
    kind: "core.io.googleSheets",
    nodeClass: GoogleSheetsNode,
    expectedType: "google-sheets",
    parameters: (baseUrl) => ({
      operation: "get",
      spreadsheetId: "SHEET-SAA1035",
      range: "Sheet1!A1:B2",
      baseUrl,
    }),
  },
  {
    kind: "core.io.airtable",
    nodeClass: AirtableNode,
    expectedType: "airtable",
    parameters: (baseUrl) => ({
      operation: "list",
      baseId: "BASE-SAA1035",
      table: "Tasks",
      baseUrl,
    }),
  },
  {
    kind: "core.io.graphql",
    nodeClass: GraphqlNode,
    expectedType: "graphql",
    parameters: (baseUrl) => ({
      operation: "query",
      endpoint: `${baseUrl}/graphql`,
      query: "{ viewer { login } }",
    }),
  },
];

describe("SAA-1027 Stage 3b credential fail-closed", () => {
  let http: HttpStub;

  beforeAll(async () => {
    http = await startHttpStub(() => {
      throw new Error("a fail-closed credential path must not reach the vendor");
    });
    setCredential("GRAPH_CREDENTIAL_SAA1035_WRONG", "wrong-secret");
    setCredential("GRAPH_CREDENTIAL_SAA1035_SLACK", "{");
  });

  afterAll(async () => {
    clearCredentials(
      "GRAPH_CREDENTIAL_SAA1035_WRONG",
      "GRAPH_CREDENTIAL_SAA1035_SLACK"
    );
    await http.close();
  });

  it.each(CASES)(
    "rejects a mismatched credential type for $kind before any HTTP call",
    async ({ kind, nodeClass, parameters, expectedType }) => {
      const before = http.requests.length;
      await expect(
        runNode(
          nodeClass,
          kind,
          parameters(`${http.baseUrl}/v1`),
          {},
          credential("GRAPH_CREDENTIAL_SAA1035_WRONG", "not-" + expectedType)
        )
      ).rejects.toMatchObject({
        graphCode: "GRAPH_CREDENTIAL_TYPE_MISMATCH",
      });
      expect(http.requests).toHaveLength(before);
    }
  );

  it("rejects a credential ID that is not a GRAPH_CREDENTIAL_* variable", async () => {
    const before = http.requests.length;
    await expect(
      runNode(
        SlackNode,
        "core.comms.slack",
        {
          operation: "postMessage",
          channel: "C-SAA1035",
          text: "should not send",
          baseUrl: `${http.baseUrl}/v1`,
        },
        {},
        credential("not-a-credential-ref", "slack")
      )
    ).rejects.toMatchObject({
      graphCode: "GRAPH_CREDENTIAL_INVALID_REFERENCE",
    });
    expect(http.requests).toHaveLength(before);
  });

  it("rejects a malformed JSON credential with a clear format error", async () => {
    const before = http.requests.length;
    await expect(
      runNode(
        SlackNode,
        "core.comms.slack",
        {
          operation: "postMessage",
          channel: "C-SAA1035",
          text: "should not send",
          baseUrl: `${http.baseUrl}/v1`,
        },
        {},
        credential("GRAPH_CREDENTIAL_SAA1035_SLACK", "slack")
      )
    ).rejects.toMatchObject({
      graphCode: "GRAPH_CREDENTIAL_INVALID_FORMAT",
    });
    expect(http.requests).toHaveLength(before);
  });
});
