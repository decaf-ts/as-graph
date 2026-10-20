/**
 * @module as-graph/tests/integration/graph/nodes/io/IoNodesLive
 * @summary SAA-1144 live integration coverage for `core.io.httpRequest`,
 * `core.io.extractFromFile`, and `core.io.readWriteFile`.
 * @description Runs the production nodes through the shared `runNode` harness.
 * `httpRequest` talks to the booted Dagster GraphQL server over real HTTP,
 * `readWriteFile` round-trips bytes on the real filesystem under a temp base,
 * and `extractFromFile` parses a real file written by that round-trip.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpRequestNode } from "../../../../../src/node/io/http-request/node";
import { ExtractFromFileNode } from "../../../../../src/node/io/extract-from-file/node";
import { ReadWriteFileNode } from "../../../../../src/node/io/read-write-file/node";
import { ENDPOINTS, errorCodeOf, runNode } from "../real-service-support";

const HTTP_KIND = "core.io.httpRequest";
const EXTRACT_KIND = "core.io.extractFromFile";
const FILE_KIND = "core.io.readWriteFile";

describe(`core.io.httpRequest — live Dagster GraphQL (${ENDPOINTS.dagster.graphqlUrl})`, () => {
  it("POSTs a real GraphQL query and returns the parsed Dagster version", async () => {
    const result = await runNode(
      HttpRequestNode,
      HTTP_KIND,
      {
        url: ENDPOINTS.dagster.graphqlUrl,
        method: "POST",
        body: { query: "{ version }" },
        failOnError: true,
      },
      {}
    );

    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({
      data: { version: expect.any(String) },
    });
  });

  it("fails closed on an unreachable real endpoint", async () => {
    const error = await runNode(
      HttpRequestNode,
      HTTP_KIND,
      { url: "http://127.0.0.1:59999/does-not-exist", timeoutMs: 1500 },
      {}
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_HTTP_REQUEST_FAILED");
  });
});

describe("core.io.readWriteFile + core.io.extractFromFile — live filesystem", () => {
  let directory: string;
  const previousBase = process.env["GRAPH_FILE_IO_BASE"];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "saa1144-io-"));
    process.env["GRAPH_FILE_IO_BASE"] = directory;
  });

  afterAll(async () => {
    if (previousBase === undefined) delete process.env["GRAPH_FILE_IO_BASE"];
    else process.env["GRAPH_FILE_IO_BASE"] = previousBase;
    await rm(directory, { recursive: true, force: true });
  });

  it("writes and reads a real file, then parses it as JSON", async () => {
    const path = "payload.json";
    const content = JSON.stringify({ name: "Ada", score: 7 });

    const written = await runNode(
      ReadWriteFileNode,
      FILE_KIND,
      { operation: "write", path, content },
      {}
    );
    expect(written.result).toEqual({ path, bytes: content.length });

    const read = await runNode(
      ReadWriteFileNode,
      FILE_KIND,
      { operation: "read", path },
      {}
    );
    expect(read.result).toBe(content);

    const parsed = await runNode(
      ExtractFromFileNode,
      EXTRACT_KIND,
      { format: "json" },
      { value: read.result }
    );
    expect(parsed.result).toEqual({ name: "Ada", score: 7 });
  });

  it("appends, creates nested directories, and lists nothing outside the base", async () => {
    const path = join("nested", "deep", "rows.csv");
    await runNode(
      ReadWriteFileNode,
      FILE_KIND,
      {
        operation: "write",
        path,
        content: "name,note\nJane,ok\n",
        createDirectories: true,
      },
      {}
    );
    await runNode(
      ReadWriteFileNode,
      FILE_KIND,
      { operation: "write", path, content: "Ada,hi\n", append: true },
      {}
    );

    const read = await runNode(
      ReadWriteFileNode,
      FILE_KIND,
      { operation: "read", path },
      {}
    );
    expect(read.result).toBe("name,note\nJane,ok\nAda,hi\n");

    const parsed = await runNode(
      ExtractFromFileNode,
      EXTRACT_KIND,
      { format: "csv" },
      { value: read.result }
    );
    expect(parsed.result).toEqual([
      { name: "Jane", note: "ok" },
      { name: "Ada", note: "hi" },
    ]);
    expect(parsed.rows).toBe(2);

    const text = await runNode(
      ExtractFromFileNode,
      EXTRACT_KIND,
      { format: "text" },
      { value: Buffer.from("hello") }
    );
    expect(text.result).toBe("hello");
  });

  it("refuses a path outside the configured base", async () => {
    const error = await runNode(
      ReadWriteFileNode,
      FILE_KIND,
      { operation: "read", path: "../escape.txt" },
      {}
    ).catch((caught: unknown) => caught);
    expect(errorCodeOf(error)).toBe("GRAPH_READ_WRITE_FILE_PATH_FORBIDDEN");
  });
});
