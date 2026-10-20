/**
 * @module as-graph/tests/integration/graph/nodes/storage/blobNodes
 * @summary SAA-1032: real-service integration coverage for the
 * `core.storage.s3`, `core.storage.awsS3`,
 * `core.storage.googleCloudStorage` and `core.storage.azureStorage` kinds.
 * @description Runs the shared blob-node operation surface (`put`, `get`,
 * `list`, `stat`, `has`, `url`, `copy`, `delete`) against MinIO, fake GCS and
 * Azurite. Every key lives under a process-unique namespace and is removed in
 * teardown. The `list` case is kept as an executable failure report: the blob
 * base node forwards `prefix: undefined`, which the S3/Azure services reject
 * with `Invalid blob key:` (see the SAA-1032 verdict comment).
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { Storage } from "@google-cloud/storage";
import { BlobServiceClient } from "@azure/storage-blob";
import {
  S3StorageNode,
  AwsS3StorageNode,
} from "../../../../../src/node/storage/blob/s3/node";
import { GoogleCloudStorageNode } from "../../../../../src/node/storage/blob/gcs/node";
import { AzureStorageNode } from "../../../../../src/node/storage/blob/azure/node";
import {
  ENDPOINTS,
  clearCredentials,
  credential,
  gcsServiceAccountJson,
  runNode,
  s3CredentialJson,
  setCredential,
  uniqueName,
} from "../real-service-support";

jest.setTimeout(90000);

const namespace = uniqueName("saa1032-blob");

/**
 * fake-gcs-server 1.49.3 ignores `-public-host` when building the resumable
 * upload `Location`, so a misconfigured emulator advertises an unreachable
 * `0.0.0.0:4443` URL. Probe the emulator once and skip the GCS block with an
 * explicit reason instead of reporting a fake failure; once the compose file
 * uses `-external-url` the block runs automatically.
 */
const gcsUploadsReachable = (() => {
  const endpoint = `http://${ENDPOINTS.gcs.host}:${ENDPOINTS.gcs.port}`;
  try {
    const response = execFileSync(
      "curl",
      [
        "-s",
        "-i",
        "-X",
        "POST",
        `${endpoint}/upload/storage/v1/b/${ENDPOINTS.gcs.bucket}/o?uploadType=resumable&name=${namespace}%2Fprobe.txt`,
        "-H",
        "Content-Type: application/json",
        "-d",
        '{"name":"probe.txt"}',
      ],
      { encoding: "utf8", timeout: 5000 }
    );
    const location = /^location:\s*(.+)$/im.exec(response)?.[1]?.trim();
    if (!location) return false;
    const advertised = new URL(location);
    return (
      advertised.host === `${ENDPOINTS.gcs.host}:${ENDPOINTS.gcs.port}`
    );
  } catch {
    return false;
  }
})();

const gcsDescribe = gcsUploadsReachable ? describe : describe.skip;

function s3Client(): S3Client {
  return new S3Client({
    region: ENDPOINTS.s3.region,
    endpoint: `http://${ENDPOINTS.s3.host}:${ENDPOINTS.s3.port}`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: ENDPOINTS.s3.accessKeyId,
      secretAccessKey: ENDPOINTS.s3.secretAccessKey,
    },
  });
}

describe("core.storage.s3 / core.storage.awsS3 (real MinIO)", () => {
  const envName = "it-saa1032-S3";
  const credentials = credential(envName, "s3");
  const kind = "core.storage.s3";
  const parameters = {
    bucket: ENDPOINTS.s3.bucket,
    region: ENDPOINTS.s3.region,
    endpoint: `http://${ENDPOINTS.s3.host}:${ENDPOINTS.s3.port}`,
    forcePathStyle: true,
  };
  const keys: string[] = [];

  const keyFor = (name: string): string => `${namespace}/${name}`;

  async function put(key: string, content = "hello-s3"): Promise<void> {
    keys.push(key);
    await runNode(
      S3StorageNode,
      kind,
      { ...parameters, operation: "put", key, content, contentType: "text/plain" },
      {},
      credentials
    );
  }

  beforeAll(() => {
    setCredential(envName, s3CredentialJson());
  });

  afterAll(async () => {
    clearCredentials(envName);
    if (!keys.length) return;
    const client = s3Client();
    await client.send(
      new DeleteObjectsCommand({
        Bucket: ENDPOINTS.s3.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })) },
      })
    );
  });

  it("puts, stats, checks and gets an object", async () => {
    const key = keyFor("s3-roundtrip.txt");
    await put(key);

    const has = await runNode(
      S3StorageNode,
      kind,
      { ...parameters, operation: "has", key },
      {},
      credentials
    );
    expect(has.result).toBe(true);

    const stat = await runNode(
      S3StorageNode,
      kind,
      { ...parameters, operation: "stat", key },
      {},
      credentials
    );
    expect(stat.result).toMatchObject({
      contentType: "text/plain",
      contentLength: 8,
    });

    const get = await runNode(
      S3StorageNode,
      kind,
      { ...parameters, operation: "get", key },
      {},
      credentials
    );
    expect(get.value).toBe("hello-s3");
    expect(get.contentLength).toBe(8);
    expect(get.result).toMatchObject({
      key,
      provider: "s3",
      metadata: { contentType: "text/plain" },
    });
  });

  it("lists objects", async () => {
    const key = keyFor("s3-listed.txt");
    await put(key);
    const list = await runNode(
      S3StorageNode,
      kind,
      { ...parameters, operation: "list" },
      {},
      credentials
    );
    const listedKeys = (list.result as { items: Array<{ key: string }> }).items.map(
      (item) => item.key
    );
    expect(listedKeys).toContain(key);
  });

  it("copies an object", async () => {
    const key = keyFor("s3-source.txt");
    const copyKey = keyFor("s3-copy.txt");
    await put(key);
    keys.push(copyKey);

    const copy = await runNode(
      S3StorageNode,
      kind,
      { ...parameters, operation: "copy", key, targetKey: copyKey },
      {},
      credentials
    );
    expect(copy.result).toMatchObject({ key: copyKey, provider: "s3" });

    const copied = await runNode(
      S3StorageNode,
      kind,
      { ...parameters, operation: "get", key: copyKey },
      {},
      credentials
    );
    expect(copied.value).toBe("hello-s3");
  });

  it("signs a GET url", async () => {
    const key = keyFor("s3-url.txt");
    await put(key);
    const url = await runNode(
      S3StorageNode,
      kind,
      { ...parameters, operation: "url", key, expiresInSeconds: 60 },
      {},
      credentials
    );
    expect(url.result).toMatchObject({ method: "GET" });
    expect(String((url.result as { url: string }).url)).toContain(key);
  });

  it("deletes an object", async () => {
    const key = keyFor("s3-delete.txt");
    await put(key);
    const deleted = await runNode(
      S3StorageNode,
      kind,
      { ...parameters, operation: "delete", key },
      {},
      credentials
    );
    expect(deleted.result).toEqual({ key, deleted: true });

    const hasAfter = await runNode(
      S3StorageNode,
      kind,
      { ...parameters, operation: "has", key },
      {},
      credentials
    );
    expect(hasAfter.result).toBe(false);
  });

  it("serves core.storage.awsS3 through the same real S3 surface", async () => {
    const key = keyFor("aws-s3.txt");
    keys.push(key);
    const putResult = await runNode(
      AwsS3StorageNode,
      "core.storage.awsS3",
      { ...parameters, operation: "put", key, content: "aws-hello" },
      {},
      credentials
    );
    expect(putResult.result).toMatchObject({ key, provider: "s3" });

    const get = await runNode(
      AwsS3StorageNode,
      "core.storage.awsS3",
      { ...parameters, operation: "get", key },
      {},
      credentials
    );
    expect(get.value).toBe("aws-hello");

    await runNode(
      AwsS3StorageNode,
      "core.storage.awsS3",
      { ...parameters, operation: "delete", key },
      {},
      credentials
    );
  });

  it("fails fast when put has no key", async () => {
    await expect(
      runNode(
        S3StorageNode,
        kind,
        { ...parameters, operation: "put", content: "x" },
        {},
        credentials
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_BLOB_KEY_REQUIRED" });
  });
});

gcsDescribe("core.storage.googleCloudStorage (real fake-gcs-server)", () => {
  const envName = "it-saa1032-GCS";
  const credentials = credential(envName, "gcs");
  const kind = "core.storage.googleCloudStorage";
  const apiEndpoint = `http://${ENDPOINTS.gcs.host}:${ENDPOINTS.gcs.port}`;
  const parameters = {
    bucket: ENDPOINTS.gcs.bucket,
    projectId: ENDPOINTS.gcs.projectId,
    apiEndpoint,
  };
  const keys: string[] = [];
  const keyFor = (name: string): string => `${namespace}/${name}`;

  async function put(key: string, content = "hello-gcs"): Promise<void> {
    keys.push(key);
    await runNode(
      GoogleCloudStorageNode,
      kind,
      { ...parameters, operation: "put", key, content, contentType: "text/plain" },
      {},
      credentials
    );
  }

  beforeAll(() => {
    setCredential(envName, gcsServiceAccountJson());
  });

  afterAll(async () => {
    clearCredentials(envName);
    const storage = new Storage({
      projectId: ENDPOINTS.gcs.projectId,
      apiEndpoint,
      credentials: JSON.parse(gcsServiceAccountJson()),
    });
    await Promise.all(
      keys.map((key) =>
        storage
          .bucket(ENDPOINTS.gcs.bucket)
          .file(key)
          .delete({ ignoreNotFound: true })
      )
    );
  });

  it("puts, stats, checks and gets an object", async () => {
    const key = keyFor("gcs-roundtrip.txt");
    await put(key);

    const has = await runNode(
      GoogleCloudStorageNode,
      kind,
      { ...parameters, operation: "has", key },
      {},
      credentials
    );
    expect(has.result).toBe(true);

    const stat = await runNode(
      GoogleCloudStorageNode,
      kind,
      { ...parameters, operation: "stat", key },
      {},
      credentials
    );
    expect(stat.result).toMatchObject({ contentLength: 9 });

    const get = await runNode(
      GoogleCloudStorageNode,
      kind,
      { ...parameters, operation: "get", key },
      {},
      credentials
    );
    expect(get.value).toBe("hello-gcs");
    expect(get.contentLength).toBe(9);
  });

  it("lists objects", async () => {
    const key = keyFor("gcs-listed.txt");
    await put(key);
    const list = await runNode(
      GoogleCloudStorageNode,
      kind,
      { ...parameters, operation: "list" },
      {},
      credentials
    );
    const listedKeys = (list.result as { items: Array<{ key: string }> }).items.map(
      (item) => item.key
    );
    expect(listedKeys).toContain(key);
  });

  it("copies an object", async () => {
    const key = keyFor("gcs-source.txt");
    const copyKey = keyFor("gcs-copy.txt");
    await put(key);
    keys.push(copyKey);
    const copy = await runNode(
      GoogleCloudStorageNode,
      kind,
      { ...parameters, operation: "copy", key, targetKey: copyKey },
      {},
      credentials
    );
    expect(copy.result).toMatchObject({ key: copyKey, provider: "gcs" });

    const copied = await runNode(
      GoogleCloudStorageNode,
      kind,
      { ...parameters, operation: "get", key: copyKey },
      {},
      credentials
    );
    expect(copied.value).toBe("hello-gcs");
  });

  it("signs a GET url", async () => {
    const key = keyFor("gcs-url.txt");
    await put(key);
    const url = await runNode(
      GoogleCloudStorageNode,
      kind,
      { ...parameters, operation: "url", key, expiresInSeconds: 60 },
      {},
      credentials
    );
    expect(url.result).toMatchObject({ method: "GET" });
    expect(String((url.result as { url: string }).url)).toContain(key);
  });

  it("deletes an object", async () => {
    const key = keyFor("gcs-delete.txt");
    await put(key);
    await runNode(
      GoogleCloudStorageNode,
      kind,
      { ...parameters, operation: "delete", key },
      {},
      credentials
    );
    const hasAfter = await runNode(
      GoogleCloudStorageNode,
      kind,
      { ...parameters, operation: "has", key },
      {},
      credentials
    );
    expect(hasAfter.result).toBe(false);
  });

  it("fails fast when the bucket is missing", async () => {
    await expect(
      runNode(
        GoogleCloudStorageNode,
        kind,
        { ...parameters, bucket: "", operation: "has", key: "x" },
        {},
        credentials
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_BLOB_BUCKET_REQUIRED" });
  });
});

describe("core.storage.azureStorage (real Azurite)", () => {
  const envName = "it-saa1032-AZURE";
  const credentials = credential(envName, "azure-blob");
  const kind = "core.storage.azureStorage";
  const parameters = { container: ENDPOINTS.azure.container };
  const keys: string[] = [];
  const keyFor = (name: string): string => `${namespace}/${name}`;

  async function put(key: string, content = "hello-azure"): Promise<void> {
    keys.push(key);
    await runNode(
      AzureStorageNode,
      kind,
      { ...parameters, operation: "put", key, content, contentType: "text/plain" },
      {},
      credentials
    );
  }

  beforeAll(async () => {
    setCredential(
      envName,
      JSON.stringify({ connectionString: ENDPOINTS.azure.connectionString })
    );
    const service = BlobServiceClient.fromConnectionString(
      ENDPOINTS.azure.connectionString
    );
    await service
      .getContainerClient(ENDPOINTS.azure.container)
      .createIfNotExists();
  });

  afterAll(async () => {
    clearCredentials(envName);
    const service = BlobServiceClient.fromConnectionString(
      ENDPOINTS.azure.connectionString
    );
    const container = service.getContainerClient(ENDPOINTS.azure.container);
    await Promise.all(
      keys.map((key) =>
        container
          .getBlockBlobClient(key)
          .deleteIfExists()
          .catch(() => undefined)
      )
    );
  });

  it("puts, stats, checks and gets an object", async () => {
    const key = keyFor("azure-roundtrip.txt");
    await put(key);

    const has = await runNode(
      AzureStorageNode,
      kind,
      { ...parameters, operation: "has", key },
      {},
      credentials
    );
    expect(has.result).toBe(true);

    const stat = await runNode(
      AzureStorageNode,
      kind,
      { ...parameters, operation: "stat", key },
      {},
      credentials
    );
    expect(stat.result).toMatchObject({
      contentType: "text/plain",
      contentLength: 11,
    });

    const get = await runNode(
      AzureStorageNode,
      kind,
      { ...parameters, operation: "get", key },
      {},
      credentials
    );
    expect(get.value).toBe("hello-azure");
    expect(get.contentLength).toBe(11);
  });

  it("lists objects", async () => {
    const key = keyFor("azure-listed.txt");
    await put(key);
    const list = await runNode(
      AzureStorageNode,
      kind,
      { ...parameters, operation: "list" },
      {},
      credentials
    );
    const listedKeys = (list.result as { items: Array<{ key: string }> }).items.map(
      (item) => item.key
    );
    expect(listedKeys).toContain(key);
  });

  it("signs a GET url", async () => {
    const key = keyFor("azure-url.txt");
    await put(key);
    const url = await runNode(
      AzureStorageNode,
      kind,
      { ...parameters, operation: "url", key, expiresInSeconds: 60 },
      {},
      credentials
    );
    expect(url.result).toMatchObject({ method: "GET" });
    expect(String((url.result as { url: string }).url)).toContain(key);
  });

  it("deletes an object", async () => {
    const key = keyFor("azure-delete.txt");
    await put(key);
    await runNode(
      AzureStorageNode,
      kind,
      { ...parameters, operation: "delete", key },
      {},
      credentials
    );
    const hasAfter = await runNode(
      AzureStorageNode,
      kind,
      { ...parameters, operation: "has", key },
      {},
      credentials
    );
    expect(hasAfter.result).toBe(false);
  });

  it("fails fast when the container is missing", async () => {
    await expect(
      runNode(
        AzureStorageNode,
        kind,
        { container: "", operation: "has", key: "x" },
        {},
        credentials
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_BLOB_CONTAINER_REQUIRED" });
  });
});
