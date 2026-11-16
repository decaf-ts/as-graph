/**
 * @module as-graph/tests/integration/graph/fileDemos
 * @summary End-to-end runs of the file demos through the real engine: files
 * travel as binary store references, parsed rows travel as data.
 * @description Runs `fixture-spreadsheet-files` on a temp file-IO base and
 * `fixture-http-file-download` against a loopback HTTP server, and asserts the
 * n8n split at every boundary: a file-producing node's output (and the
 * workflow output it feeds) is a `GraphBinaryReference` whose bytes live in
 * the engine's binary store, while a parsing node's output is plain rows.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootFixtureEngine } from "../../fixtures/workflow-engine";
import { resolveDocument } from "../../unit/graph/engine-fixtures";
import {
  httpFileDownloadDocument,
  spreadsheetFilesDocument,
  spreadsheetFilesFixture,
  SPREADSHEET_FILES_INPUTS,
  SPREADSHEET_FILES_PATH,
} from "../../../src/workflows";
import {
  isGraphBinaryPayload,
  isGraphBinaryReference,
  type GraphBinaryReference,
} from "../../../src/shared/graph/document/GraphBinaryReference";
import { WorkbookService } from "@decaf-ts/integrations/io/spreadsheet";

const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ODS = "application/vnd.oasis.opendocument.spreadsheet";

/** Asserts that no inline base64 payload survives anywhere in a value. */
function expectNoInlineBytes(value: unknown, depth = 0): void {
  expect(isGraphBinaryPayload(value)).toBe(false);
  if (depth > 6 || !value || typeof value !== "object") return;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    expectNoInlineBytes(entry, depth + 1);
  }
}

async function run(
  document: typeof spreadsheetFilesDocument,
  inputs: Record<string, unknown>
) {
  const { engine, catalogue } = await bootFixtureEngine();
  await resolveDocument(document, catalogue);
  const result = await engine.execute(document, inputs);
  return { engine, result };
}

describe("fixture-spreadsheet-files — files on the binary side, rows in the data", () => {
  let base: string;
  const previousBase = process.env["GRAPH_FILE_IO_BASE"];

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "as-graph-file-demo-"));
    process.env["GRAPH_FILE_IO_BASE"] = base;
  });

  afterAll(async () => {
    if (previousBase === undefined) delete process.env["GRAPH_FILE_IO_BASE"];
    else process.env["GRAPH_FILE_IO_BASE"] = previousBase;
    await rm(base, { recursive: true, force: true });
  });

  it("writes, reads and parses the workbook, and converts it to CSV and ODS", async () => {
    const { engine, result } = await run(
      spreadsheetFilesDocument,
      SPREADSHEET_FILES_INPUTS
    );
    expect(result.status).toBe("succeeded");
    for (const [key, value] of Object.entries(
      spreadsheetFilesFixture.expectedOutputs ?? {}
    )) {
      expect(result.outputs[key]).toEqual(value);
    }

    // Every file is a reference; no node result or output carries bytes.
    expectNoInlineBytes(result.outputs);
    for (const nodeResult of Object.values(result.nodeResults)) {
      expectNoInlineBytes(nodeResult.outputs);
    }

    const workbook = result.outputs["workbook"] as GraphBinaryReference;
    expect(isGraphBinaryReference(workbook)).toBe(true);
    expect(workbook).toMatchObject({
      fileName: "team.xlsx",
      mimeType: XLSX,
      path: SPREADSHEET_FILES_PATH,
    });
    // The bytes behind the reference are the workbook written to disk.
    const stored = await engine.binaryStore!.read(workbook.id);
    const onDisk = await readFile(join(base, SPREADSHEET_FILES_PATH));
    expect(stored).toEqual(onDisk);
    expect(new WorkbookService().read(stored!).sheetName).toBe("Team");
    expect(workbook.byteLength).toBe(onDisk.byteLength);

    // The reader got the bytes back (hydrated) even though only a reference
    // travelled: it parsed real rows.
    expect(result.nodeResults["sheet"].outputs["rows"]).toHaveLength(3);

    const csv = result.outputs["csv"] as GraphBinaryReference;
    expect(csv).toMatchObject({ fileName: "team.csv", mimeType: "text/csv" });
    expect((await engine.binaryStore!.read(csv.id))!.toString("utf8")).toBe(
      "name,role,years\nada,engineer,36\ngrace,admiral,85\nlinus,maintainer,33"
    );

    const ods = result.outputs["odsFile"] as GraphBinaryReference;
    expect(ods).toMatchObject({ fileName: "team.ods", mimeType: ODS });

    // The CSV writer emits only the file and its size, no text copy.
    expect(Object.keys(result.nodeResults["toCsv"].outputs).sort()).toEqual([
      "bytes",
      "result",
    ]);
  });
});

describe("fixture-http-file-download — HTTP file response and file upload", () => {
  const CSV = "sku,qty\nbolt,4\nnut,9\n";
  let server: Server;
  let baseUrl: string;
  let uploaded: { contentType?: string; body: Buffer } | undefined;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/exports/stock") {
        response.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="stock.csv"',
        });
        response.end(CSV);
        return;
      }
      if (request.url === "/upload" && request.method === "POST") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          uploaded = {
            contentType: request.headers["content-type"],
            body: Buffer.concat(chunks),
          };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ stored: uploaded.body.byteLength }));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen)
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it("downloads the CSV as a file, parses it into rows and uploads the bytes", async () => {
    const { engine, result } = await run(httpFileDownloadDocument, {
      url: `${baseUrl}/exports/stock`,
      uploadUrl: `${baseUrl}/upload`,
    });
    expect(result.status).toBe("succeeded");
    expectNoInlineBytes(result.outputs);
    // Outputs are the declared output ports only — never the run inputs.
    expect(Object.keys(result.outputs).sort()).toEqual(["file", "header", "rows", "uploaded"]);

    const file = result.outputs["file"] as GraphBinaryReference;
    expect(isGraphBinaryReference(file)).toBe(true);
    expect(file).toMatchObject({
      fileName: "stock.csv",
      mimeType: "text/csv",
      byteLength: Buffer.byteLength(CSV),
    });
    expect((await engine.binaryStore!.read(file.id))!.toString("utf8")).toBe(CSV);

    expect(result.outputs["header"]).toEqual(["sku", "qty"]);
    expect(result.outputs["rows"]).toEqual([
      ["bolt", "4"],
      ["nut", "9"],
    ]);

    expect(uploaded?.contentType).toBe("text/csv");
    expect(uploaded?.body.toString("utf8")).toBe(CSV);
    expect(result.outputs["uploaded"]).toEqual({ stored: Buffer.byteLength(CSV) });
  });

  it("fails the run when the download URL answers with an error status", async () => {
    const { result } = await run(httpFileDownloadDocument, {
      url: `${baseUrl}/missing`,
      uploadUrl: `${baseUrl}/upload`,
    }).catch((error: unknown) => ({ result: { status: "failed", error } }) as never);
    expect(result.status).toBe("failed");
  });
});
