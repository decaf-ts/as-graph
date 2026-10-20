/**
 * @module as-graph/tests/integration/graph/nodes/io/ioNodes
 * @summary SAA-1027 Stage 3b: node→service integration coverage for the four IO
 * node kinds.
 * @description Google Sheets, Airtable and GraphQL run against a process-local
 * HTTP stub that records the real integration-service request (method, path,
 * query, auth header and JSON body). That block is **contract** coverage and is
 * never a live-matrix PASS. The live success path for the two SaaS vendors is
 * credential-gated: Google Sheets needs
 * `AS_GRAPH_IT_GOOGLE_SHEETS_ACCESS_TOKEN`,
 * `AS_GRAPH_IT_GOOGLE_SHEETS_SPREADSHEET_ID` and
 * `AS_GRAPH_IT_GOOGLE_SHEETS_RANGE`; Airtable needs
 * `AS_GRAPH_IT_AIRTABLE_TOKEN`, `AS_GRAPH_IT_AIRTABLE_BASE_ID` and
 * `AS_GRAPH_IT_AIRTABLE_TABLE`. A missing variable is a SKIP naming it. The
 * spreadsheet-file kind is fully local and covers parse/write round-tripping
 * without a credential.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { GoogleSheetsNode } from "../../../../../src/node/io/google-sheets/node";
import { AirtableNode } from "../../../../../src/node/io/airtable/node";
import { GraphqlNode } from "../../../../../src/node/io/graphql/node";
import { SpreadsheetFileNode } from "../../../../../src/node/io/spreadsheet-file/node";
import {
  credential,
  clearCredentials,
  runNode,
  setCredential,
} from "../real-service-support";
import { startHttpStub, type HttpStub } from "../loopback-support";
import { credentialGatedIt, envValue } from "../credential-gated";

jest.setTimeout(60000);

const SECRETS = {
  sheets: "saa1035-sheets-secret",
  airtable: "saa1035-airtable-secret",
  graphql: "saa1035-graphql-secret",
} as const;

const CREDENTIALS = {
  sheets: credential("it-saa1035-SHEETS", "google-sheets"),
  airtable: credential("it-saa1035-AIRTABLE", "airtable"),
  graphql: credential("it-saa1035-GRAPHQL", "graphql"),
} as const;

describe("core.io.* vendor contract (loopback stub; NOT a live-matrix claim)", () => {
  let http: HttpStub;

  beforeAll(async () => {
    http = await startHttpStub((request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const path = decodeURIComponent(request.path);

      if (path === "/v4/spreadsheets/") {
        return {
          body: {
            spreadsheetId: "SHEET-NEW",
            spreadsheetUrl: `${http.baseUrl}/v4/spreadsheets/SHEET-NEW`,
          },
        };
      }
      if (path === "/v4/spreadsheets/SHEET-SAA1035/values/Sheet1!A1:B2") {
        if (request.method === "GET") {
          return {
            body: {
              spreadsheetId: "SHEET-SAA1035",
              range: "Sheet1!A1:B2",
              majorDimension: "ROWS",
              values: [
                ["name", "role"],
                ["ada", "engineer"],
              ],
            },
          };
        }
        return {
          body: {
            spreadsheetId: "SHEET-SAA1035",
            range: "Sheet1!A1:B2",
            values: body.values,
          },
        };
      }
      if (
        path ===
        "/v4/spreadsheets/SHEET-SAA1035/values/Sheet1!A1:B2:append"
      ) {
        return {
          body: {
            spreadsheetId: "SHEET-SAA1035",
            range: "Sheet1!A1:B2",
            values: body.values,
          },
        };
      }
      if (
        path === "/v4/spreadsheets/SHEET-SAA1035/values/Sheet1!A1:B2:clear"
      ) {
        return {
          body: {
            spreadsheetId: "SHEET-SAA1035",
            clearedRange: "Sheet1!A1:B2",
          },
        };
      }

      if (path === "/v0/BASE-SAA1035/Tasks") {
        if (request.method === "GET") {
          return {
            body: {
              records: [
                {
                  id: "rec-1",
                  createdTime: "2026-10-18T00:00:00.000Z",
                  fields: { name: "one" },
                },
              ],
              offset: "offset-2",
            },
          };
        }
        return {
          body: {
            id: "rec-created",
            createdTime: "2026-10-18T00:00:00.000Z",
            fields: body.fields,
          },
        };
      }
      if (path === "/v0/BASE-SAA1035/Tasks/rec-1") {
        if (request.method === "DELETE") {
          return { body: { id: "rec-1", deleted: true } };
        }
        return {
          body: {
            id: "rec-1",
            createdTime: "2026-10-18T00:00:00.000Z",
            fields: {
              name: "one",
              ...((body.fields as Record<string, unknown>) ?? {}),
            },
          },
        };
      }

      if (path === "/graphql") {
        const query = String(body.query ?? "");
        if (query.includes("BrokenQuery")) {
          return {
            body: {
              data: null,
              errors: [{ message: "Cannot query field", path: ["broken"] }],
            },
          };
        }
        return {
          body: {
            data: {
              viewer: {
                login: "saa1035",
                variables: body.variables ?? {},
              },
            },
          },
        };
      }

      return { status: 404, body: { error: `unhandled ${path}` } };
    });

    setCredential("it-saa1035-SHEETS", SECRETS.sheets);
    setCredential("it-saa1035-AIRTABLE", SECRETS.airtable);
    setCredential("it-saa1035-GRAPHQL", SECRETS.graphql);
  });

  afterAll(async () => {
    clearCredentials(
      "it-saa1035-SHEETS",
      "it-saa1035-AIRTABLE",
      "it-saa1035-GRAPHQL"
    );
    await http.close();
  });

  it("contract: Google Sheets gets, updates, appends, clears and creates", async () => {
    const baseUrl = `${http.baseUrl}/v4/spreadsheets`;
    const before = http.requests.length;
    const read = await runNode(
      GoogleSheetsNode,
      "core.io.googleSheets",
      {
        operation: "get",
        spreadsheetId: "SHEET-SAA1035",
        range: "Sheet1!A1:B2",
        baseUrl,
      },
      {},
      CREDENTIALS.sheets
    );
    expect(read.result).toMatchObject({
      spreadsheetId: "SHEET-SAA1035",
      range: "Sheet1!A1:B2",
      values: [
        ["name", "role"],
        ["ada", "engineer"],
      ],
    });
    expect(read.values).toEqual([
      ["name", "role"],
      ["ada", "engineer"],
    ]);
    expect(http.requests[before].method).toBe("GET");
    expect(http.requests[before].headers.authorization).toBe(
      `Bearer ${SECRETS.sheets}`
    );

    const updated = await runNode(
      GoogleSheetsNode,
      "core.io.googleSheets",
      {
        operation: "update",
        spreadsheetId: "SHEET-SAA1035",
        range: "Sheet1!A1:B2",
        values: [["grace", "admiral"]],
        valueInputOption: "RAW",
        baseUrl,
      },
      {},
      CREDENTIALS.sheets
    );
    expect(updated.values).toEqual([["grace", "admiral"]]);

    const appended = await runNode(
      GoogleSheetsNode,
      "core.io.googleSheets",
      {
        operation: "append",
        spreadsheetId: "SHEET-SAA1035",
        range: "Sheet1!A1:B2",
        values: [["linus", "kernel"]],
        baseUrl,
      },
      {},
      CREDENTIALS.sheets
    );
    expect(appended.values).toEqual([["linus", "kernel"]]);

    const cleared = await runNode(
      GoogleSheetsNode,
      "core.io.googleSheets",
      {
        operation: "clear",
        spreadsheetId: "SHEET-SAA1035",
        range: "Sheet1!A1:B2",
        baseUrl,
      },
      {},
      CREDENTIALS.sheets
    );
    expect(cleared.range).toBe("Sheet1!A1:B2");

    const created = await runNode(
      GoogleSheetsNode,
      "core.io.googleSheets",
      {
        operation: "create",
        title: "SAA-1035 metrics",
        baseUrl,
      },
      {},
      CREDENTIALS.sheets
    );
    expect(created.result).toMatchObject({
      spreadsheetId: "SHEET-NEW",
    });
  });

  it("contract: Airtable lists, gets, creates, updates and deletes records", async () => {
    const baseUrl = `${http.baseUrl}/v0`;
    const listed = await runNode(
      AirtableNode,
      "core.io.airtable",
      {
        operation: "list",
        baseId: "BASE-SAA1035",
        table: "Tasks",
        view: "Grid view",
        maxRecords: 5,
        fields: ["name"],
        sortField: "name",
        sortDirection: "asc",
        baseUrl,
      },
      {},
      CREDENTIALS.airtable
    );
    expect(listed.result).toMatchObject({
      records: [{ id: "rec-1" }],
      offset: "offset-2",
    });
    expect(listed.offset).toBe("offset-2");

    const fetched = await runNode(
      AirtableNode,
      "core.io.airtable",
      {
        operation: "get",
        baseId: "BASE-SAA1035",
        table: "Tasks",
        recordId: "rec-1",
        baseUrl,
      },
      {},
      CREDENTIALS.airtable
    );
    expect(fetched.records).toEqual([
      expect.objectContaining({ id: "rec-1" }),
    ]);

    const before = http.requests.length;
    const created = await runNode(
      AirtableNode,
      "core.io.airtable",
      {
        operation: "create",
        baseId: "BASE-SAA1035",
        table: "Tasks",
        recordFields: { name: "created" },
        baseUrl,
      },
      {},
      CREDENTIALS.airtable
    );
    expect(created.result).toMatchObject({
      id: "rec-created",
      fields: { name: "created" },
    });
    expect(http.requests[before]).toMatchObject({
      method: "POST",
      path: "/v0/BASE-SAA1035/Tasks",
    });

    const updated = await runNode(
      AirtableNode,
      "core.io.airtable",
      {
        operation: "update",
        baseId: "BASE-SAA1035",
        table: "Tasks",
        recordId: "rec-1",
        recordFields: { name: "updated" },
        baseUrl,
      },
      {},
      CREDENTIALS.airtable
    );
    expect(updated.result).toMatchObject({
      id: "rec-1",
      fields: { name: "updated" },
    });

    const deleted = await runNode(
      AirtableNode,
      "core.io.airtable",
      {
        operation: "delete",
        baseId: "BASE-SAA1035",
        table: "Tasks",
        recordId: "rec-1",
        baseUrl,
      },
      {},
      CREDENTIALS.airtable
    );
    expect(deleted.result).toEqual({ id: "rec-1", deleted: true });
  });

  it("contract: GraphQL runs a query with variables and surfaces vendor errors", async () => {
    const baseUrl = `${http.baseUrl}/graphql`;
    const before = http.requests.length;
    const queried = await runNode(
      GraphqlNode,
      "core.io.graphql",
      {
        operation: "query",
        endpoint: baseUrl,
        query: "query Viewer($id: ID!) { viewer(id: $id) { login } }",
        variables: { id: "saa1035" },
        operationName: "Viewer",
      },
      {},
      CREDENTIALS.graphql
    );
    expect(queried.result).toMatchObject({
      viewer: { login: "saa1035", variables: { id: "saa1035" } },
    });
    const request = http.requests[before];
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/graphql");
    expect(request.headers.authorization).toBe(
      `Bearer ${SECRETS.graphql}`
    );
    expect(request.body).toMatchObject({
      query: "query Viewer($id: ID!) { viewer(id: $id) { login } }",
      variables: { id: "saa1035" },
      operationName: "Viewer",
    });

    const failed = await runNode(
      GraphqlNode,
      "core.io.graphql",
      {
        operation: "query",
        endpoint: baseUrl,
        query: "query BrokenQuery { broken }",
      },
      {},
      CREDENTIALS.graphql
    );
    expect(failed.errors).toEqual([
      { message: "Cannot query field", path: ["broken"] },
    ]);
  });

  it("Spreadsheet File parses and writes CSV/JSON without a credential", async () => {
    const parsed = await runNode(
      SpreadsheetFileNode,
      "core.io.spreadsheetFile",
      {
        operation: "parse",
        format: "csv",
        content: "name,role\nada,engineer\ngrace,admiral",
        hasHeader: true,
      },
      {}
    );
    expect(parsed.header).toEqual(["name", "role"]);
    expect(parsed.rows).toEqual([
      ["ada", "engineer"],
      ["grace", "admiral"],
    ]);

    const written = await runNode(
      SpreadsheetFileNode,
      "core.io.spreadsheetFile",
      {
        operation: "write",
        format: "csv",
        rows: [
          ["name", "role"],
          ["linus", "kernel"],
        ],
      },
      {}
    );
    expect(written.content).toContain("name,role");
    expect(written.content).toContain("linus,kernel");

    const json = await runNode(
      SpreadsheetFileNode,
      "core.io.spreadsheetFile",
      {
        operation: "parse",
        format: "json",
        content: JSON.stringify([
          { name: "ada", role: "engineer" },
        ]),
        hasHeader: true,
      },
      {}
    );
    expect(json.rows).toEqual([["ada", "engineer"]]);
    expect(json.header).toEqual(["name", "role"]);
  });

  it("contract: never echoes an IO vendor secret into a node result", async () => {
    const result = await runNode(
      AirtableNode,
      "core.io.airtable",
      {
        operation: "get",
        baseId: "BASE-SAA1035",
        table: "Tasks",
        recordId: "rec-1",
        baseUrl: `${http.baseUrl}/v0`,
      },
      {},
      CREDENTIALS.airtable
    );
    const serialized = JSON.stringify(result);
    for (const secret of Object.values(SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
  });
});

/**
 * Live credential-gated success paths. The loopback block above is contract
 * coverage, not live infrastructure.
 */
describe("core.io.* live SaaS integration (credential-gated)", () => {
  credentialGatedIt(
    "live: Google Sheets reads a real range",
    [
      "AS_GRAPH_IT_GOOGLE_SHEETS_ACCESS_TOKEN",
      "AS_GRAPH_IT_GOOGLE_SHEETS_SPREADSHEET_ID",
      "AS_GRAPH_IT_GOOGLE_SHEETS_RANGE",
    ],
    async () => {
      const id = "it-live-SHEETS";
      const spreadsheetId = envValue("AS_GRAPH_IT_GOOGLE_SHEETS_SPREADSHEET_ID");
      setCredential(id, envValue("AS_GRAPH_IT_GOOGLE_SHEETS_ACCESS_TOKEN"));
      try {
        const result = await runNode(
          GoogleSheetsNode,
          "core.io.googleSheets",
          {
            operation: "get",
            spreadsheetId,
            range: envValue("AS_GRAPH_IT_GOOGLE_SHEETS_RANGE"),
          },
          {},
          credential(id, "google-sheets")
        );
        expect(result.spreadsheetId).toBe(spreadsheetId);
        expect(Array.isArray(result.values ?? [])).toBe(true);
        expect(JSON.stringify(result)).not.toContain(
          envValue("AS_GRAPH_IT_GOOGLE_SHEETS_ACCESS_TOKEN")
        );
      } finally {
        clearCredentials(id);
      }
    }
  );

  credentialGatedIt(
    "live: Airtable lists records from a real base",
    [
      "AS_GRAPH_IT_AIRTABLE_TOKEN",
      "AS_GRAPH_IT_AIRTABLE_BASE_ID",
      "AS_GRAPH_IT_AIRTABLE_TABLE",
    ],
    async () => {
      const id = "it-live-AIRTABLE";
      setCredential(id, envValue("AS_GRAPH_IT_AIRTABLE_TOKEN"));
      try {
        const result = await runNode(
          AirtableNode,
          "core.io.airtable",
          {
            operation: "list",
            baseId: envValue("AS_GRAPH_IT_AIRTABLE_BASE_ID"),
            table: envValue("AS_GRAPH_IT_AIRTABLE_TABLE"),
            maxRecords: 1,
          },
          {},
          credential(id, "airtable")
        );
        expect(Array.isArray(result.records)).toBe(true);
        expect(JSON.stringify(result)).not.toContain(
          envValue("AS_GRAPH_IT_AIRTABLE_TOKEN")
        );
      } finally {
        clearCredentials(id);
      }
    }
  );
});
