/**
 * @module as-graph/tests/integration/graph/binaryStreaming
 * @summary File nodes stream through the binary store; non-streaming nodes
 * load files under the in-memory ceiling; expired pins are swept.
 */
import { jest, describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBlobStoreService } from "@decaf-ts/integrations/blob/memory";
import { BlobGraphBinaryStore } from "../../../src/engine/binary/BlobGraphBinaryStore";
import { isGraphBinaryReference } from "../../../src/shared/graph/document/GraphBinaryReference";
import { bootFixtureEngine } from "../../fixtures/workflow-engine";
import { resolveDocument } from "../../unit/graph/engine-fixtures";
import { document, edge, node, port } from "../../../src/workflows/builders";
import { GraphPinningService } from "../../../src/engine/pinning/GraphPinningService";
import { GraphPinningPolicy } from "../../../src/engine/pinning/GraphPinningPolicy";
import { GraphPinningDependencyResolver } from "../../../src/engine/pinning/GraphPinningDependencyResolver";
import { createGraphValueRepository } from "../../../src/engine/store/GraphValueRepository";
import { createRamGraphAdapter } from "../../../src/ram";
import { graphBinaryPinHolder } from "../../../src/engine/binary/GraphBinaryStore";
import { serializeGraphValueKey } from "../../../src/engine/store/GraphValueRepository";

jest.setTimeout(60000);

async function blobStore(): Promise<BlobGraphBinaryStore> {
  const blobs = new MemoryBlobStoreService();
  await blobs.boot({ provider: "memory", sourceId: `streaming-${Math.random()}` });
  return new BlobGraphBinaryStore(blobs as never, { deleteGraceMs: 0 });
}

async function run(doc: ReturnType<typeof document>, inputs: Record<string, unknown>, store: BlobGraphBinaryStore) {
  const { engine, catalogue } = await bootFixtureEngine({ binaryStore: store });
  await resolveDocument(doc, catalogue);
  return { engine, result: await engine.execute(doc, inputs) };
}

describe("streaming file nodes", () => {
  let base: string;
  let server: Server;
  let url: string;
  const previous = { base: process.env["GRAPH_FILE_IO_BASE"] };
  const big = Buffer.alloc(3 * 1024 * 1024, 0x61);

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "as-graph-streaming-"));
    process.env["GRAPH_FILE_IO_BASE"] = base;
    await writeFile(join(base, "big.bin"), big);
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(big);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/blob.bin`;
  });

  afterAll(async () => {
    if (previous.base === undefined) delete process.env["GRAPH_FILE_IO_BASE"];
    else process.env["GRAPH_FILE_IO_BASE"] = previous.base;
    await rm(base, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("read → write copies a file disk-to-disk through the store as a reference", async () => {
    const store = await blobStore();
    const doc = document({
      id: "stream-copy",
      name: "stream-copy",
      outputs: [port("file"), port("written")],
      nodes: [
        node("read", "core.io.readBinaryFile", { filePath: "big.bin" }),
        node("write", "core.io.writeBinaryFile", { fileName: "copy/big.bin" }),
      ],
      edges: [
        edge("e1", ["node", "read", "result"], ["node", "write", "value"]),
        edge("e2", ["node", "read", "result"], ["workflow", "file"]),
        edge("e3", ["node", "write", "result"], ["workflow", "written"]),
      ],
    });
    const { result } = await run(doc, {}, store);
    expect(result.status).toBe("succeeded");
    // The streaming writer received the reference, never hydrated bytes.
    expect(isGraphBinaryReference(result.nodeResults["write"].inputs["value"])).toBe(true);
    expect(isGraphBinaryReference(result.outputs["file"])).toBe(true);
    expect((await readFile(join(base, "copy/big.bin"))).equals(big)).toBe(true);
  });

  it("streams an HTTP file response into the store, under its own limit", async () => {
    const store = await blobStore();
    const doc = document({
      id: "stream-http",
      name: "stream-http",
      outputs: [port("file")],
      nodes: [node("get", "core.io.httpRequest", { url, responseFormat: "file" })],
      edges: [edge("e1", ["node", "get", "result"], ["workflow", "file"])],
    });
    const { result } = await run(doc, {}, store);
    const file = result.outputs["file"] as { id: string; byteLength: number; fileName: string };
    expect(file.byteLength).toBe(big.byteLength);
    expect(file.fileName).toBe("blob.bin");
    expect((await store.read(file.id))?.equals(big)).toBe(true);

    process.env["GRAPH_HTTP_MAX_FILE_BYTES"] = "1024";
    try {
      const tooBig = await run(doc, {}, store);
      expect(tooBig.result.status).toBe("failed");
      expect(JSON.stringify(tooBig.result.nodeResults["get"].error)).toContain(
        "GRAPH_HTTP_RESPONSE_TOO_LARGE"
      );
    } finally {
      delete process.env["GRAPH_HTTP_MAX_FILE_BYTES"];
    }
  });

  it("refuses to load a file above GRAPH_BINARY_MAX_BUFFER_BYTES into a non-streaming node", async () => {
    const store = await blobStore();
    const doc = document({
      id: "stream-cap",
      name: "stream-cap",
      outputs: [port("text")],
      nodes: [
        node("read", "core.io.readBinaryFile", { filePath: "big.bin" }),
        node("parse", "core.io.extractFromFile", { format: "text" }),
      ],
      edges: [
        edge("e1", ["node", "read", "result"], ["node", "parse", "value"]),
        edge("e2", ["node", "parse", "result"], ["workflow", "text"]),
      ],
    });
    process.env["GRAPH_BINARY_MAX_BUFFER_BYTES"] = String(1024 * 1024);
    try {
      const { result } = await run(doc, {}, store);
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result.nodeResults["parse"]?.error ?? result)).toContain(
        "GRAPH_BINARY_TOO_LARGE"
      );
    } finally {
      delete process.env["GRAPH_BINARY_MAX_BUFFER_BYTES"];
    }
  });
});

describe("expired pin sweep", () => {
  it("removes expired pins and releases the files they held", async () => {
    const store = await blobStore();
    const values = createGraphValueRepository(
      (await createRamGraphAdapter(`pin-sweep-${Math.random()}`)) as never
    );
    const pinning = new GraphPinningService(
      values,
      new GraphPinningPolicy(),
      new GraphPinningDependencyResolver(),
      store
    );
    const id = await store.write("run-1", Buffer.from("pinned"), {
      fileName: "p.txt",
      mimeType: "text/plain",
      byteLength: 6,
    });
    const key = { workflowId: "wf", nodeId: "n", fingerprint: "fp" };
    await values.writeCached(key, {
      key,
      outputs: { file: { fileName: "p.txt", mimeType: "text/plain", byteLength: 6, id } },
      pinned: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-01-02T00:00:00Z",
    } as never);
    await store.hold(graphBinaryPinHolder(serializeGraphValueKey(key)), id);
    await store.deleteRun("run-1");
    expect(await store.read(id)).toBeDefined();

    expect(await pinning.sweepExpired(new Date("2026-01-03T00:00:00Z"))).toBe(1);
    expect(await values.readCached(key)).toBeUndefined();
    expect(await store.read(id)).toBeUndefined();
  });
});
