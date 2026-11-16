/**
 * @module as-graph/tests/unit/graph/nodes/IoNodeKinds.test
 * @summary Unit coverage for the SAA-746 Stage 1 general-engine IO nodes.
 * @description Drives the instance `execute` contract of `core.io.httpRequest`,
 * `core.io.respondToWebhook`, `core.io.extractFromFile`, `core.io.readPDF`, and
 * `core.io.readWriteFile` against a real local HTTP server, a real PDF fixture,
 * and `os.tmpdir()` — no mocked transport or filesystem — plus the documented
 * `GraphExecutionError` failure codes.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GRAPH_HTTP_MAX_RESPONSE_BYTES } from "../../../../src/engine/constants";

import { ExtractFromFileNode } from "../../../../src/node/io/extract-from-file/node";
import { HttpRequestNode } from "../../../../src/node/io/http-request/node";
import { ReadWriteFileNode } from "../../../../src/node/io/read-write-file/node";
import { RespondToWebhookNode } from "../../../../src/node/io/respond-to-webhook/node";
import type { GraphNodeClass } from "../../../../src/node/base";
import type { GraphExecutionValues } from "../../../../src/engine/types";
import type { GraphExecutionEngine } from "../../../../src/engine/execution/GraphExecutionEngine";
import { GraphWebhookResponseRegistry } from "../../../../src/engine/execution/GraphWebhookResponseRegistry";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";
import { buildNodeContext } from "./node-test-utils";

async function run(
  nodeClass: GraphNodeClass,
  kind: string,
  parameters: Record<string, unknown>,
  inputs: Record<string, unknown>,
  engine?: GraphExecutionEngine
): Promise<GraphExecutionValues> {
  const context = buildNodeContext(kind, { parameters, engine });
  return await executeNode(nodeClass, nodeExecutionRequest(inputs), context);
}

function asEngine(value: unknown): GraphExecutionEngine {
  return value as GraphExecutionEngine;
}

/** Bytes that are not valid UTF-8, so a text decode would corrupt them. */
const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0x80]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xc3]);

describe("core.io.httpRequest", () => {
  const kind = "core.io.httpRequest";
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            method: request.method,
            echo: url.searchParams.get("echo"),
          })
        );
        return;
      }
      if (url.pathname === "/text") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("plain body");
        return;
      }
      if (url.pathname === "/created") {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ received: body }));
        });
        return;
      }
      if (url.pathname === "/report.pdf") {
        response.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="q4 report.pdf"',
        });
        response.end(PDF_BYTES);
        return;
      }
      if (url.pathname === "/images/logo.png") {
        response.writeHead(200, { "content-type": "image/png; charset=binary" });
        response.end(PNG_BYTES);
        return;
      }
      if (url.pathname === "/upload") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              contentType: request.headers["content-type"],
              base64: Buffer.concat(chunks).toString("base64"),
            })
          );
        });
        return;
      }
      if (url.pathname === "/fail") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      if (url.pathname === "/redirect-file") {
        response.writeHead(302, { location: "file:///etc/passwd" });
        response.end();
        return;
      }
      if (url.pathname.startsWith("/redirect/")) {
        const hop = Number(url.pathname.slice("/redirect/".length));
        response.writeHead(302, { location: `/redirect/${hop - 1}` });
        response.end();
        return;
      }
      if (url.pathname === "/large") {
        const body = Buffer.alloc(GRAPH_HTTP_MAX_RESPONSE_BYTES + 1, 0x61);
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-length": String(body.byteLength),
        });
        response.end(body);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen)
    );
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it("performs a GET and parses the JSON response", async () => {
    const result = await run(
      HttpRequestNode,
      kind,
      { url: `${baseUrl}/json`, query: { echo: "hello" } },
      {}
    );
    expect(result.result).toEqual({
      ok: true,
      method: "GET",
      echo: "hello",
    });
    expect(result.status).toBe(200);
    expect((result.headers as Record<string, string>)["content-type"]).toContain(
      "application/json"
    );
  });

  it("posts a JSON body and honours the text response format", async () => {
    const posted = await run(
      HttpRequestNode,
      kind,
      { url: `${baseUrl}/created`, method: "POST", body: { id: 7 } },
      {}
    );
    expect(posted.status).toBe(201);
    expect(posted.result).toEqual({ received: JSON.stringify({ id: 7 }) });

    const text = await run(
      HttpRequestNode,
      kind,
      { url: `${baseUrl}/text`, responseFormat: "text" },
      {}
    );
    expect(text.result).toBe("plain body");
  });

  it("emits a binary file for the file response format", async () => {
    const named = await run(
      HttpRequestNode,
      kind,
      { url: `${baseUrl}/report.pdf`, responseFormat: "file" },
      {}
    );
    expect(named.result).toEqual({
      fileName: "q4 report.pdf",
      mimeType: "application/pdf",
      byteLength: PDF_BYTES.byteLength,
      data: PDF_BYTES.toString("base64"),
    });

    // No Content-Disposition: the URL's last segment names the file and the
    // media type drops its parameters.
    const fromUrl = await run(
      HttpRequestNode,
      kind,
      { url: `${baseUrl}/images/logo.png`, responseFormat: "file" },
      {}
    );
    expect(fromUrl.result).toMatchObject({
      fileName: "logo.png",
      mimeType: "image/png",
      data: PNG_BYTES.toString("base64"),
    });

    const configured = await run(
      HttpRequestNode,
      kind,
      { url: `${baseUrl}/`, responseFormat: "file", fileName: "index.bin" },
      {}
    );
    expect(configured.result).toMatchObject({
      fileName: "index.bin",
      byteLength: 0,
    });
  });

  it("sends a routed file payload as the raw request body", async () => {
    const sent = await run(
      HttpRequestNode,
      kind,
      { url: `${baseUrl}/upload`, method: "POST" },
      {
        value: {
          fileName: "logo.png",
          mimeType: "image/png",
          byteLength: PNG_BYTES.byteLength,
          data: PNG_BYTES.toString("base64"),
        },
      }
    );
    expect(sent.result).toEqual({
      contentType: "image/png",
      base64: PNG_BYTES.toString("base64"),
    });
  });

  it("returns non-2xx responses unless failOnError is set", async () => {
    const tolerated = await run(
      HttpRequestNode,
      kind,
      { url: `${baseUrl}/fail` },
      {}
    );
    expect(tolerated.status).toBe(503);

    await expect(
      run(HttpRequestNode, kind, { url: `${baseUrl}/fail`, failOnError: true }, {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_HTTP_REQUEST_FAILED" });
  });

  it("times out when the server does not respond", async () => {
    const hanging = createServer(() => {
      // Intentionally never responds.
    });
    await new Promise<void>((resolveListen) =>
      hanging.listen(0, "127.0.0.1", resolveListen)
    );
    const address = hanging.address() as AddressInfo;
    try {
      await expect(
        run(
          HttpRequestNode,
          kind,
          {
            url: `http://127.0.0.1:${address.port}/hang`,
            timeoutMs: 50,
          },
          {}
        )
      ).rejects.toMatchObject({ graphCode: "GRAPH_HTTP_REQUEST_TIMEOUT" });
    } finally {
      await new Promise<void>((resolveClose) =>
        hanging.close(() => resolveClose())
      );
    }
  });

  it("rejects invalid URLs and non-http(s) protocols", async () => {
    await expect(
      run(HttpRequestNode, kind, { url: "not a url" }, {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_HTTP_INVALID_URL" });

    await expect(
      run(HttpRequestNode, kind, { url: "file:///etc/passwd" }, {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_HTTP_PROTOCOL_NOT_ALLOWED" });

    await expect(run(HttpRequestNode, kind, {}, {})).rejects.toMatchObject({
      graphCode: "GRAPH_HTTP_URL_REQUIRED",
    });
  });

  it("rejects a redirect that pivots to a non-http(s) protocol (C4)", async () => {
    await expect(
      run(HttpRequestNode, kind, { url: `${baseUrl}/redirect-file` }, {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_HTTP_PROTOCOL_NOT_ALLOWED" });
  });

  it("caps redirect hops at five (C4)", async () => {
    await expect(
      run(HttpRequestNode, kind, { url: `${baseUrl}/redirect/6` }, {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_HTTP_TOO_MANY_REDIRECTS" });
  });

  it("rejects a response body over the 10 MiB cap (C4)", async () => {
    await expect(
      run(
        HttpRequestNode,
        kind,
        { url: `${baseUrl}/large`, responseFormat: "text" },
        {}
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_HTTP_RESPONSE_TOO_LARGE" });
  });
});

describe("core.io.respondToWebhook", () => {
  const kind = "core.io.respondToWebhook";

  it("registers a run and resolves the delivery with the response shape", async () => {
    const registry = new GraphWebhookResponseRegistry();
    const pending = registry.register("run-1");
    const result = await run(
      RespondToWebhookNode,
      kind,
      {},
      { value: [{ first: 1 }, { second: 2 }] },
      asEngine({ webhookResponses: registry })
    );

    expect(result.delivered).toBe(true);
    await expect(pending).resolves.toEqual({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: { first: 1 },
      runId: "run-1",
      respondedAt: expect.any(String),
    });
    expect(result.response).toEqual(await pending);
  });

  it("supports allIncomingItems, noData, json, and text bodies", async () => {
    const cases: [Record<string, unknown>, unknown][] = [
      [
        { respondWith: "allIncomingItems" },
        [{ a: 1 }, { b: 2 }],
      ],
      [{ respondWith: "noData" }, null],
      [{ respondWith: "json", responseBody: '{"ok":true}' }, { ok: true }],
      [{ respondWith: "text", responseBody: "done" }, "done"],
    ];

    for (const [parameters, expected] of cases) {
      const registry = new GraphWebhookResponseRegistry();
      registry.register("run-1");
      const result = await run(
        RespondToWebhookNode,
        kind,
        parameters,
        { value: [{ a: 1 }, { b: 2 }] },
        asEngine({ webhookResponses: registry })
      );
      expect(result.response.body).toEqual(expected);
      expect(result.delivered).toBe(true);
    }
  });

  it("applies the configured status code and headers", async () => {
    const registry = new GraphWebhookResponseRegistry();
    registry.register("run-1");
    const result = await run(
      RespondToWebhookNode,
      kind,
      { responseCode: 202, responseHeaders: { "x-trace": "abc" } },
      { value: { ok: true } },
      asEngine({ webhookResponses: registry })
    );
    expect(result.response.statusCode).toBe(202);
    expect(result.response.headers).toEqual({
      "x-trace": "abc",
      "content-type": "application/json",
    });
  });

  it("reports delivered: false when no run is registered", async () => {
    const registry = new GraphWebhookResponseRegistry();
    const result = await run(
      RespondToWebhookNode,
      kind,
      {},
      { value: { ok: true } },
      asEngine({ webhookResponses: registry })
    );
    expect(result.delivered).toBe(false);
    expect(result.response.body).toEqual({ ok: true });
  });

  it("delivers only once and times out an unanswered registration", async () => {
    const registry = new GraphWebhookResponseRegistry();
    const pending = registry.register("run-timeout", 20);
    await expect(pending).rejects.toThrow(/within 20ms/);

    registry.register("run-once");
    expect(
      registry.deliver("run-once", {
        statusCode: 200,
        headers: {},
        body: null,
        runId: "run-once",
        respondedAt: new Date().toISOString(),
      })
    ).toBe(true);
    expect(
      registry.deliver("run-once", {
        statusCode: 200,
        headers: {},
        body: null,
        runId: "run-once",
        respondedAt: new Date().toISOString(),
      })
    ).toBe(false);
  });
});

describe("core.io.extractFromFile", () => {
  const kind = "core.io.extractFromFile";

  it("parses JSON from plain, base64, data-URI, and object-wrapper payloads", async () => {
    const json = '{"name":"Ada","score":7}';
    expect(
      await run(ExtractFromFileNode, kind, { format: "json" }, { value: json })
    ).toEqual({ result: { name: "Ada", score: 7 } });

    expect(
      await run(
        ExtractFromFileNode,
        kind,
        { format: "json", encoding: "base64" },
        { value: Buffer.from(json).toString("base64") }
      )
    ).toEqual({ result: { name: "Ada", score: 7 } });

    expect(
      await run(
        ExtractFromFileNode,
        kind,
        { format: "json" },
        { value: `data:application/json;base64,${Buffer.from(json).toString("base64")}` }
      )
    ).toEqual({ result: { name: "Ada", score: 7 } });

    expect(
      await run(
        ExtractFromFileNode,
        kind,
        { format: "json" },
        { value: { content: json } }
      )
    ).toEqual({ result: { name: "Ada", score: 7 } });
  });

  it("parses CSV with quoted fields, escaped quotes, and a header row", async () => {
    const csv = 'name,note\n"Smith, John","said ""hi"""\nJane,ok';
    const result = await run(
      ExtractFromFileNode,
      kind,
      { format: "csv" },
      { value: csv }
    );
    expect(result).toEqual({
      result: [
        { name: "Smith, John", note: 'said "hi"' },
        { name: "Jane", note: "ok" },
      ],
      rows: 2,
    });
  });

  it("honours a custom delimiter and headerRow: false", async () => {
    const result = await run(
      ExtractFromFileNode,
      kind,
      { format: "csv", delimiter: ";", headerRow: false },
      { value: "a;b\nc;d" }
    );
    expect(result).toEqual({
      result: [
        { column0: "a", column1: "b" },
        { column0: "c", column1: "d" },
      ],
      rows: 2,
    });
  });

  it("returns raw text", async () => {
    expect(
      await run(ExtractFromFileNode, kind, { format: "text" }, { value: "hello" })
    ).toEqual({ result: "hello" });
  });

  it("decodes a direct Buffer/Uint8Array/ArrayBuffer payload as text (SAA-946 D1)", async () => {
    await expect(
      run(
        ExtractFromFileNode,
        kind,
        { format: "text" },
        { value: Buffer.from("hello") }
      )
    ).resolves.toEqual({ result: "hello" });
    await expect(
      run(
        ExtractFromFileNode,
        kind,
        { format: "text" },
        { value: new Uint8Array(Buffer.from("hello")) }
      )
    ).resolves.toEqual({ result: "hello" });
    const arrayBuffer = new Uint8Array(Buffer.from("hello")).buffer;
    await expect(
      run(
        ExtractFromFileNode,
        kind,
        { format: "text" },
        { value: arrayBuffer }
      )
    ).resolves.toEqual({ result: "hello" });
  });

  it("fails with the documented codes for bad payloads and formats", async () => {
    await expect(
      run(ExtractFromFileNode, kind, { format: "json" }, { value: "{bad" })
    ).rejects.toMatchObject({ graphCode: "GRAPH_EXTRACT_FROM_FILE_INVALID_JSON" });

    await expect(
      run(ExtractFromFileNode, kind, { format: "bogus" }, { value: "x" })
    ).rejects.toMatchObject({
      graphCode: "GRAPH_EXTRACT_FROM_FILE_UNSUPPORTED_FORMAT",
    });

    await expect(
      run(ExtractFromFileNode, kind, {}, { value: 42 })
    ).rejects.toMatchObject({
      graphCode: "GRAPH_EXTRACT_FROM_FILE_INVALID_INPUT",
    });
  });
});

describe("core.io.readWriteFile", () => {
  const kind = "core.io.readWriteFile";
  let directory: string;
  let outside: string;
  const previousBase = process.env["GRAPH_FILE_IO_BASE"];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "as-graph-rw-"));
    outside = await mkdtemp(join(tmpdir(), "as-graph-rw-outside-"));
    process.env["GRAPH_FILE_IO_BASE"] = directory;
  });

  afterAll(async () => {
    if (previousBase === undefined) delete process.env["GRAPH_FILE_IO_BASE"];
    else process.env["GRAPH_FILE_IO_BASE"] = previousBase;
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("writes, reads back, and appends UTF-8 content relative to the base", async () => {
    const path = "plain.txt";
    const written = await run(
      ReadWriteFileNode,
      kind,
      { operation: "write", path, content: "hello" },
      {}
    );
    expect(written.result).toEqual({ path, bytes: 5 });
    expect(written.bytes).toBe(5);

    // A read yields a file (n8n's Read Files from Disk), never the text.
    expect(
      await run(ReadWriteFileNode, kind, { operation: "read", path }, {})
    ).toEqual({
      result: {
        fileName: "plain.txt",
        path,
        mimeType: "text/plain",
        byteLength: 5,
        data: Buffer.from("hello").toString("base64"),
      },
      bytes: 5,
    });

    await run(
      ReadWriteFileNode,
      kind,
      { operation: "write", path, content: " world", append: true },
      {}
    );
    expect(await readFile(join(directory, path), "utf8")).toBe("hello world");
  });

  it("writes the bytes of a routed file payload", async () => {
    const path = "copy.png";
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await run(
      ReadWriteFileNode,
      kind,
      { operation: "write", path },
      {
        value: {
          fileName: "logo.png",
          mimeType: "image/png",
          byteLength: bytes.byteLength,
          data: bytes.toString("base64"),
        },
      }
    );
    expect(await readFile(join(directory, path))).toEqual(bytes);
  });

  it("creates missing directories and supports base64 encoding", async () => {
    const path = join("nested", "deep", "data.bin");
    await run(
      ReadWriteFileNode,
      kind,
      {
        operation: "write",
        path,
        content: Buffer.from("binary").toString("base64"),
        encoding: "base64",
        createDirectories: true,
      },
      {}
    );
    expect(await readFile(join(directory, path), "utf8")).toBe("binary");

    const read = await run(
      ReadWriteFileNode,
      kind,
      { operation: "read", path },
      {}
    );
    expect(read.result).toMatchObject({
      fileName: "data.bin",
      mimeType: "application/octet-stream",
      data: Buffer.from("binary").toString("base64"),
    });
  });

  it("falls back to the routed value when content is not configured", async () => {
    const path = "routed.txt";
    await run(
      ReadWriteFileNode,
      kind,
      { operation: "write", path },
      { value: "routed" }
    );
    expect(await readFile(join(directory, path), "utf8")).toBe("routed");
  });

  it("fails with the documented codes for missing configuration", async () => {
    await expect(
      run(ReadWriteFileNode, kind, { operation: "read" }, {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_READ_WRITE_FILE_PATH_REQUIRED" });

    await expect(
      run(ReadWriteFileNode, kind, { operation: "read", path: "bad\0name" }, {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_READ_WRITE_FILE_INVALID_PATH" });

    await expect(
      run(
        ReadWriteFileNode,
        kind,
        { operation: "write", path: "empty.txt" },
        {}
      )
    ).rejects.toMatchObject({
      graphCode: "GRAPH_READ_WRITE_FILE_CONTENT_REQUIRED",
    });
  });

  it("rejects a relative path that escapes the base (C1)", async () => {
    await expect(
      run(ReadWriteFileNode, kind, { operation: "read", path: "../../.env" }, {})
    ).rejects.toMatchObject({
      graphCode: "GRAPH_READ_WRITE_FILE_PATH_FORBIDDEN",
    });
  });

  it("treats an absolute path as base-relative and refuses forbidden host directories (C1)", async () => {
    await expect(
      run(ReadWriteFileNode, kind, { operation: "read", path: "/etc/passwd" }, {})
    ).rejects.toMatchObject({
      graphCode: "GRAPH_READ_WRITE_FILE_PATH_FORBIDDEN",
    });
  });

  it("rejects a symlink inside the base that resolves outside it (C1)", async () => {
    const target = join(outside, "secret.txt");
    await writeFile(target, "outside secret", "utf8");
    await symlink(target, join(directory, "escape-link"));

    await expect(
      run(
        ReadWriteFileNode,
        kind,
        { operation: "read", path: "escape-link" },
        {}
      )
    ).rejects.toMatchObject({
      graphCode: "GRAPH_READ_WRITE_FILE_PATH_FORBIDDEN",
    });
  });

  it("rejects a path with a workdocs segment (C1)", async () => {
    await mkdir(join(directory, "workdocs"), { recursive: true });
    await writeFile(join(directory, "workdocs", "secret.md"), "docs", "utf8");

    await expect(
      run(
        ReadWriteFileNode,
        kind,
        { operation: "read", path: "workdocs/secret.md" },
        {}
      )
    ).rejects.toMatchObject({
      graphCode: "GRAPH_READ_WRITE_FILE_PATH_FORBIDDEN",
    });
  });
});
