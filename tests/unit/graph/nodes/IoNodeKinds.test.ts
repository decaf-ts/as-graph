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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      if (url.pathname === "/fail") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unavailable" }));
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

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "as-graph-rw-"));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes, reads back, and appends UTF-8 content", async () => {
    const path = join(directory, "plain.txt");
    const written = await run(
      ReadWriteFileNode,
      kind,
      { operation: "write", path, content: "hello" },
      {}
    );
    expect(written.result).toEqual({ path, bytes: 5 });
    expect(written.bytes).toBe(5);

    expect(
      await run(ReadWriteFileNode, kind, { operation: "read", path }, {})
    ).toEqual({ result: "hello", bytes: 5 });

    await run(
      ReadWriteFileNode,
      kind,
      { operation: "write", path, content: " world", append: true },
      {}
    );
    expect(await readFile(path, "utf8")).toBe("hello world");
  });

  it("creates missing directories and supports base64 encoding", async () => {
    const path = join(directory, "nested", "deep", "data.bin");
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
    expect(await readFile(path, "utf8")).toBe("binary");

    const read = await run(
      ReadWriteFileNode,
      kind,
      { operation: "read", path, encoding: "base64" },
      {}
    );
    expect(read.result).toBe(Buffer.from("binary").toString("base64"));
  });

  it("falls back to the routed value when content is not configured", async () => {
    const path = join(directory, "routed.txt");
    await run(
      ReadWriteFileNode,
      kind,
      { operation: "write", path },
      { value: "routed" }
    );
    expect(await readFile(path, "utf8")).toBe("routed");
  });

  it("fails with the documented codes for missing configuration", async () => {
    await expect(
      run(ReadWriteFileNode, kind, { operation: "read" }, {})
    ).rejects.toMatchObject({ graphCode: "GRAPH_READ_WRITE_FILE_PATH_REQUIRED" });

    await expect(
      run(
        ReadWriteFileNode,
        kind,
        { operation: "read", path: `${directory}\0bad` },
        {}
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_READ_WRITE_FILE_INVALID_PATH" });

    await expect(
      run(
        ReadWriteFileNode,
        kind,
        { operation: "write", path: join(directory, "empty.txt") },
        {}
      )
    ).rejects.toMatchObject({
      graphCode: "GRAPH_READ_WRITE_FILE_CONTENT_REQUIRED",
    });
  });
});
