/**
 * @module as-graph/tests/integration/graph/nodes/serviceOrderStage3b
 * @summary SAA-1027 Stage 3b: service-order review of environment resolution,
 * HTTP error mapping, and the optional IMAP dependency.
 * @description Drives the integration services directly (not through a node) to
 * prove the shared service-order contract: explicit-then-environment config,
 * the documented decaf error mapping for 404/409/5xx/transport/vendor
 * failures, and that `imapflow` stays a dynamic optional import with no hard
 * runtime dependency. It may be installed for development tests, while
 * consumers opt in through its optional peer dependency.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
} from "@decaf-ts/db-decorators";
import { SlackService } from "@decaf-ts/integrations/comms/slack";
import { EmailService } from "@decaf-ts/integrations/comms/email";
import { GithubService } from "@decaf-ts/integrations/devops/github";
import { GoogleSheetsService } from "@decaf-ts/integrations/io/google-sheets";
import { GraphqlService } from "@decaf-ts/integrations/io/graphql";
import { startHttpStub, type HttpStub } from "./loopback-support";

jest.setTimeout(60000);

const ENV_KEYS = [
  "COMMS__SLACK__TOKEN",
  "COMMS__SLACK__BASE_URL",
  "DEVOPS__GITHUB__TOKEN",
  "DEVOPS__GITHUB__BASE_URL",
  "IO__GOOGLE_SHEETS__TOKEN",
  "IO__GOOGLE_SHEETS__BASE_URL",
  "IO__GRAPHQL__ENDPOINT",
  "IO__GRAPHQL__TOKEN",
] as const;

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

describe("SAA-1027 Stage 3b service order", () => {
  let http: HttpStub;
  let reply: Reply;

  beforeAll(async () => {
    reply = { status: 200, body: {} };
    http = await startHttpStub((request) => {
      const path = decodeURIComponent(request.path);
      if (path === "/api/chat.postMessage") {
        return {
          status: reply.status,
          body:
            reply.status === 200 && reply.body["ok"] === undefined
              ? {
                  ok: true,
                  channel: "C-SAA1035",
                  ts: "1700000000.000001",
                }
              : reply.body,
        };
      }
      if (path === "/github/repos/acme/widgets") {
        return { status: reply.status, body: reply.body };
      }
      if (path === "/v4/spreadsheets/SHEET-SAA1035/values/A1:B2") {
        return {
          status: reply.status,
          body:
            reply.status === 200
              ? {
                  spreadsheetId: "SHEET-SAA1035",
                  range: "A1:B2",
                  values: [["ok"]],
                }
              : reply.body,
        };
      }
      if (path === "/graphql") {
        return {
          status: reply.status,
          body:
            reply.status === 200
              ? { data: { viewer: { login: "saa1035" } } }
              : reply.body,
        };
      }
      return { status: 404, body: { error: `unhandled ${path}` } };
    });
  });

  afterAll(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    await http.close();
  });

  it("resolves comms, devops and io config from double-underscore environment keys", async () => {
    process.env["COMMS__SLACK__TOKEN"] = "env-slack-token";
    process.env["COMMS__SLACK__BASE_URL"] = `${http.baseUrl}/api`;
    process.env["DEVOPS__GITHUB__TOKEN"] = "env-github-token";
    process.env["DEVOPS__GITHUB__BASE_URL"] = `${http.baseUrl}/github`;
    process.env["IO__GOOGLE_SHEETS__TOKEN"] = "env-sheets-token";
    process.env["IO__GOOGLE_SHEETS__BASE_URL"] = `${http.baseUrl}/v4/spreadsheets`;
    process.env["IO__GRAPHQL__ENDPOINT"] = `${http.baseUrl}/graphql`;
    process.env["IO__GRAPHQL__TOKEN"] = "env-graphql-token";

    const before = http.requests.length;

    const slack = new SlackService();
    await slack.initialize({});
    await slack.postMessage({ channel: "C-SAA1035", text: "env" });

    const github = new GithubService();
    await github.initialize({});
    await github.getRepository({ owner: "acme", repo: "widgets" });

    const sheets = new GoogleSheetsService();
    await sheets.initialize({});
    await sheets.getValues("SHEET-SAA1035", "A1:B2");

    const graphql = new GraphqlService();
    await graphql.initialize({});
    await graphql.request({ query: "{ viewer { login } }" });

    const requests = http.requests.slice(before);
    expect(requests).toHaveLength(4);
    expect(requests[0].headers.authorization).toBe(
      "Bearer env-slack-token"
    );
    expect(requests[1].headers.authorization).toBe(
      "Bearer env-github-token"
    );
    expect(requests[2].headers.authorization).toBe(
      "Bearer env-sheets-token"
    );
    expect(requests[3].headers.authorization).toBe(
      "Bearer env-graphql-token"
    );

    await slack.shutdown();
    await github.shutdown();
    await sheets.shutdown();
    await graphql.shutdown();
  });

  it("maps 404, 409, 5xx, transport and vendor failures onto decaf errors", async () => {
    const slack = new SlackService();
    await slack.initialize({
      token: "service-order-token",
      baseUrl: `${http.baseUrl}/api`,
    });

    reply = { status: 404, body: { error: "missing" } };
    await expect(
      slack.postMessage({ channel: "C-SAA1035", text: "404" })
    ).rejects.toBeInstanceOf(NotFoundError);

    reply = { status: 409, body: { error: "conflict" } };
    await expect(
      slack.postMessage({ channel: "C-SAA1035", text: "409" })
    ).rejects.toBeInstanceOf(ConflictError);

    reply = { status: 500, body: { error: "boom" } };
    await expect(
      slack.postMessage({ channel: "C-SAA1035", text: "500" })
    ).rejects.toBeInstanceOf(BadRequestError);

    reply = { status: 200, body: { ok: false, error: "channel_not_found" } };
    await expect(
      slack.postMessage({ channel: "C-SAA1035", text: "vendor" })
    ).rejects.toBeInstanceOf(InternalError);

    await slack.shutdown();

    const unreachable = new SlackService();
    await unreachable.initialize({
      token: "service-order-token",
      baseUrl: "http://127.0.0.1:1/api",
      timeout: 1000,
    });
    await expect(
      unreachable.postMessage({ channel: "C-SAA1035", text: "offline" })
    ).rejects.toBeInstanceOf(InternalError);
    await unreachable.shutdown();
  });

  it("keeps imapflow dynamic and optional at runtime", async () => {
    const packageJson = JSON.parse(
      readFileSync(
        resolve(__dirname, "../../../../../integrations/package.json"),
        "utf8"
      )
    ) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(packageJson.dependencies?.["imapflow"]).toBeUndefined();
    expect(packageJson.optionalDependencies?.["imapflow"]).toBeUndefined();
    expect(packageJson.peerDependencies?.["imapflow"]).toBeDefined();
    expect(packageJson.peerDependenciesMeta?.["imapflow"]?.optional).toBe(
      true
    );

    const source = readFileSync(
      resolve(
        __dirname,
        "../../../../../integrations/src/comms/email/EmailService.ts"
      ),
      "utf8"
    );
    expect(source).toContain('const moduleName = "imapflow"');
    expect(source).toContain("await import(moduleName)");

    const email = new EmailService();
    await email.initialize({
      provider: "graph",
      token: "service-order-token",
      graphBaseUrl: `${http.baseUrl}/graph`,
    });
    const imapflowInstalled = (() => {
      try {
        require.resolve("imapflow");
        return true;
      } catch {
        return false;
      }
    })();
    await expect(email.listImapMessages()).rejects.toBeInstanceOf(
      InternalError
    );
    await expect(email.listImapMessages()).rejects.toThrow(
      imapflowInstalled
        ? /IMAP requires a host/
        : /optional 'imapflow' package/
    );
    await email.shutdown();
  });
});
