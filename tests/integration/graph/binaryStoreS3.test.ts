/**
 * @module as-graph/tests/integration/graph/binaryStoreS3
 * @summary Workflow binaries in real S3 (MinIO): engine runs, the run binary
 * endpoint, a restarted store, run retention and pin holding.
 * @description Runs against the IT MinIO (`docker/tests-compose.yml`, port
 * 59000, bucket `test-bucket`; `npm run prepare-it-tests`). The store is booted
 * the way the standalone backend boots it: `createGraphBinaryStore()` with the
 * integrations `BLOBS__S3__*` environment. Every test writes under its own key
 * prefix and removes it afterwards.
 */
import { jest, describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  BlobGraphBinaryStore,
  createGraphBinaryStore,
  graphBinaryPinHolder,
} from "../../../src/engine";
import { bootFixtureEngine } from "../../fixtures/workflow-engine";
import { resolveDocument } from "../../unit/graph/engine-fixtures";
import {
  spreadsheetFilesDocument,
  SPREADSHEET_FILES_INPUTS,
} from "../../../src/workflows";
import type { GraphBinaryReference } from "../../../src/shared/graph/document/GraphBinaryReference";
import { GraphExecutionModule } from "../../../src/nest/graph/GraphExecutionModule";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { GraphRunService } from "../../../src/engine/runs/GraphRunService";
import {
  resetGraphInjectables,
  resetGraphValueAdapter,
} from "../../unit/graph/engine-fixtures";
import { TestRequestContextModule } from "../../unit/nest/graphRunTestSupport";
import { ENDPOINTS } from "./nodes/real-service-support";

jest.setTimeout(120000);

const ENDPOINT = `http://${ENDPOINTS.s3.host}:${ENDPOINTS.s3.port}`;
const BUCKET = ENDPOINTS.s3.bucket;
const PREFIX = `as-graph-it/binaries-${randomUUID()}`;

const s3 = new S3Client({
  region: ENDPOINTS.s3.region,
  endpoint: ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: ENDPOINTS.s3.accessKeyId,
    secretAccessKey: ENDPOINTS.s3.secretAccessKey,
  },
});

/** Every object key under the test prefix. */
async function keysUnder(prefix = PREFIX): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${prefix}/`, ContinuationToken: token })
    );
    keys.push(...(page.Contents ?? []).map((object) => object.Key as string));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** Boots the S3 store from the integrations environment, as the backend does. */
async function storeFromEnvironment(): Promise<BlobGraphBinaryStore> {
  return createGraphBinaryStore();
}

const ENV: Record<string, string> = {
  GRAPH_BINARY_STORE: "s3",
  BLOBS__S3__SOURCE_ID: "as-graph-it",
  BLOBS__S3__BUCKET: BUCKET,
  BLOBS__S3__REGION: ENDPOINTS.s3.region,
  BLOBS__S3__ENDPOINT: ENDPOINT,
  BLOBS__S3__PREFIX: PREFIX,
  BLOBS__S3__FORCE_PATH_STYLE: "true",
  BLOBS__S3__AUTO_CREATE_BUCKET: "true",
  BLOBS__S3__CREDENTIALS__ACCESS_KEY_ID: ENDPOINTS.s3.accessKeyId,
  BLOBS__S3__CREDENTIALS__SECRET_ACCESS_KEY: ENDPOINTS.s3.secretAccessKey,
  // Delete released bytes at once (the deferred sweep has its own unit tests).
  GRAPH_BINARY_DELETE_GRACE_MS: "0",
};

describe("workflow binaries in S3 (MinIO)", () => {
  const previous: Record<string, string | undefined> = {};
  let fileIoBase: string;

  beforeAll(async () => {
    for (const [key, value] of Object.entries({ ...ENV })) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
    fileIoBase = await mkdtemp(join(tmpdir(), "as-graph-s3-binaries-"));
    previous["GRAPH_FILE_IO_BASE"] = process.env["GRAPH_FILE_IO_BASE"];
    process.env["GRAPH_FILE_IO_BASE"] = fileIoBase;
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(fileIoBase, { recursive: true, force: true });
    const keys = await keysUnder();
    for (let i = 0; i < keys.length; i += 1000) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
        })
      );
    }
  });

  it("boots from BLOBS__S3__* and keeps a run's files in the bucket, not in the run", async () => {
    const binaryStore = await storeFromEnvironment();
    expect(binaryStore.service.provider).toBe("s3");
    const { engine, catalogue } = await bootFixtureEngine({ binaryStore });
    await resolveDocument(spreadsheetFilesDocument, catalogue);
    const result = await engine.execute(spreadsheetFilesDocument, SPREADSHEET_FILES_INPUTS);
    expect(result.status).toBe("succeeded");

    const workbook = result.outputs["workbook"] as GraphBinaryReference;
    const digest = workbook.id.slice("graph-binary:".length);
    const keys = await keysUnder();
    // Only bytes live in the bucket; descriptors and holders are index rows.
    expect(keys).toContain(`${PREFIX}/bytes/${digest}`);
    expect(keys.every((key) => key.startsWith(`${PREFIX}/bytes/`))).toBe(true);
    // The run result carries references only.
    expect(JSON.stringify(result.outputs)).not.toContain('"data"');

    // A restarted backend (a new store over the same bucket) still serves the
    // file, its descriptor and the run's ownership of it.
    const restarted = await storeFromEnvironment();
    expect((await restarted.read(workbook.id))?.byteLength).toBe(workbook.byteLength);
    // Bytes are content-addressed: the descriptor is the first writer's (the
    // XLSX writer, before the file had a path on disk).
    expect(await restarted.describe(workbook.id)).toEqual({
      fileName: "team.xlsx",
      mimeType: workbook.mimeType,
      byteLength: workbook.byteLength,
    });
    expect(await restarted.belongsTo(result.runId, workbook.id)).toBe(true);

    // Releasing the run deletes every file only it held.
    await restarted.deleteRun(result.runId);
    expect(await keysUnder()).toEqual([]);
  });

  it("a pin keeps its file in S3 after the run is released, until unpinned", async () => {
    const store = await storeFromEnvironment();
    const id = await store.write("run-pin", Buffer.from("pinned bytes"), {
      fileName: "p.txt",
      mimeType: "text/plain",
      byteLength: 12,
    });
    await store.hold(graphBinaryPinHolder("wf:node:fingerprint"), id);
    await store.deleteRun("run-pin");
    expect((await store.read(id))?.toString()).toBe("pinned bytes");
    await store.releaseHolder(graphBinaryPinHolder("wf:node:fingerprint"));
    expect(await store.read(id)).toBeUndefined();
    expect(await keysUnder()).toEqual([]);
  });

  describe("through the HTTP backend", () => {
    let app: INestApplication;
    let binaryStore: BlobGraphBinaryStore;

    beforeAll(async () => {
      resetGraphInjectables();
      resetGraphValueAdapter();
      binaryStore = await storeFromEnvironment();
      const host = await createGraphBackendHost({
        variant: "local",
        base: {
          initAdapter: true,
          binaryStore,
          runs: {
            auth: "optional",
            allowAnonymousAccess: true,
            // Prune on demand only (no timer, nothing old enough yet).
            retention: { maxAgeMs: 24 * 3_600_000, intervalMs: 0 },
          },
          workflows: { auth: "optional", allowAnonymousAccess: true },
          engines: { auth: "optional" },
        },
      });
      const moduleRef = await Test.createTestingModule({
        imports: [TestRequestContextModule, GraphExecutionModule.forRoot(host.moduleOptions)],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      app?.get(GraphRunService).dispose();
      await app?.close();
    });

    it("deletes a finished run through DELETE ?purge=true, with its files", async () => {
      const api = () => request(app.getHttpServer());
      const created = await api()
        .post("/graph/runs")
        .send({ workflow: spreadsheetFilesDocument, inputs: SPREADSHEET_FILES_INPUTS });
      const runId = created.body.runId as string;
      let run: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 100; attempt++) {
        run = (await api().get(`/graph/runs/${runId}`)).body;
        if (["succeeded", "failed", "cancelled"].includes(String(run["status"]))) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(run["status"]).toBe("succeeded");
      expect((await keysUnder()).length).toBeGreaterThan(0);

      const deleted = await api().delete(`/graph/runs/${runId}?purge=true`);
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({ runId, status: "succeeded", deleted: true });
      expect((await api().get(`/graph/runs/${runId}`)).status).toBe(404);
      expect(await keysUnder()).toEqual([]);
      expect((await api().delete(`/graph/runs/${runId}?purge=true`)).status).toBe(404);
    });

    it("serves a run's file from S3, then prunes the run and its files", async () => {
      const api = () => request(app.getHttpServer());
      const created = await api()
        .post("/graph/runs")
        .send({ workflow: spreadsheetFilesDocument, inputs: SPREADSHEET_FILES_INPUTS });
      expect(created.status).toBeLessThan(300);
      const runId = created.body.runId as string;

      let run: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 100; attempt++) {
        run = (await api().get(`/graph/runs/${runId}`)).body;
        if (["succeeded", "failed", "cancelled"].includes(String(run["status"]))) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(run["status"]).toBe("succeeded");
      const outputs = (run["result"] as { outputs: Record<string, GraphBinaryReference> })
        .outputs;
      const csv = outputs["csv"];

      const expected =
        "name,role,years\nada,engineer,36\ngrace,admiral,85\nlinus,maintainer,33";
      // Default: a short-lived signed MinIO URL serving the right name/type.
      const redirect = await api().get(
        `/graph/runs/${runId}/binary/${encodeURIComponent(csv.id)}?action=view`
      );
      expect(redirect.status).toBe(302);
      expect(redirect.headers["location"]).toMatch(/^http:\/\/[^/]+:59000\/.*X-Amz-Signature=/);
      const signed = await fetch(redirect.headers["location"] as string);
      expect(signed.status).toBe(200);
      expect(signed.headers.get("content-type")).toBe("text/csv");
      expect(signed.headers.get("content-disposition")).toContain('filename="team.csv"');
      expect(await signed.text()).toBe(expected);
      // Download action: attachment, never sniffable inline.
      const attachment = await api().get(
        `/graph/runs/${runId}/binary/${encodeURIComponent(csv.id)}?action=download`
      );
      const downloaded = await fetch(attachment.headers["location"] as string);
      expect(downloaded.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");

      // GRAPH_BINARY_PRESIGN=off streams through the backend instead.
      process.env["GRAPH_BINARY_PRESIGN"] = "off";
      try {
        const streamed = await api()
          .get(`/graph/runs/${runId}/binary/${encodeURIComponent(csv.id)}?action=view`)
          .buffer(true);
        expect(streamed.status).toBe(200);
        expect(streamed.headers["content-type"]).toContain("text/csv");
        expect(streamed.text).toBe(expected);
      } finally {
        delete process.env["GRAPH_BINARY_PRESIGN"];
      }

      // The run is past retention 48h from now: pruning removes the run row,
      // its events and every file it alone held.
      const later = new Date(Date.now() + 48 * 3_600_000);
      expect(await app.get(GraphRunService).pruneRuns(later)).toContain(runId);
      expect((await api().get(`/graph/runs/${runId}`)).status).toBe(404);
      expect(await binaryStore.read(csv.id)).toBeUndefined();
      expect(await keysUnder()).toEqual([]);
    });
  });
});
