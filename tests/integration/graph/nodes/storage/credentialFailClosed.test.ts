/**
 * @module as-graph/tests/integration/graph/nodes/storage/credentialFailClosed
 * @summary SAA-1032: credential fail-closed coverage for the storage/devops
 * node kinds.
 * @description Proves the executor never proceeds with a credential it cannot
 * resolve: a missing environment variable, a non-`GRAPH_CREDENTIAL_*`
 * reference, a type mismatch, and malformed credential JSON each fail with the
 * documented `GRAPH_CREDENTIAL_*` code before any service call. Also asserts a
 * resolved secret never appears in a node result.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { PostgresNode } from "../../../../../src/node/storage/database/postgres/node";
import { S3StorageNode } from "../../../../../src/node/storage/blob/s3/node";
import { GoogleCloudStorageNode } from "../../../../../src/node/storage/blob/gcs/node";
import { FtpNode } from "../../../../../src/node/devops/ftp/node";
import {
  ENDPOINTS,
  clearCredentials,
  credential,
  runNode,
  s3CredentialJson,
  setCredential,
} from "../real-service-support";

jest.setTimeout(60000);

const pgParameters = {
  host: ENDPOINTS.postgres.host,
  port: ENDPOINTS.postgres.port,
  database: ENDPOINTS.postgres.database,
  username: ENDPOINTS.postgres.username,
  sql: "SELECT 1 AS n",
};

describe("credential fail-closed paths", () => {
  beforeAll(() => {
    setCredential("GRAPH_CREDENTIAL_SAA1032_S3", s3CredentialJson());
    setCredential("GRAPH_CREDENTIAL_SAA1032_S3_BADJSON", "this-is-not-json");
    setCredential("GRAPH_CREDENTIAL_SAA1032_GCS_BADJSON", "{not valid json");
    setCredential("GRAPH_CREDENTIAL_SAA1032_SFTP_BADJSON", "{not valid json");
  });

  afterAll(() => {
    clearCredentials(
      "GRAPH_CREDENTIAL_SAA1032_S3",
      "GRAPH_CREDENTIAL_SAA1032_S3_BADJSON",
      "GRAPH_CREDENTIAL_SAA1032_GCS_BADJSON",
      "GRAPH_CREDENTIAL_SAA1032_SFTP_BADJSON"
    );
  });

  it("fails when the referenced variable is not set in the environment", async () => {
    await expect(
      runNode(
        PostgresNode,
        "core.storage.postgres",
        pgParameters,
        {},
        credential("GRAPH_CREDENTIAL_SAA1032_UNSET", "postgres")
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_CREDENTIAL_NOT_CONFIGURED" });
  });

  it("fails when the reference does not name a GRAPH_CREDENTIAL_* variable", async () => {
    await expect(
      runNode(
        PostgresNode,
        "core.storage.postgres",
        pgParameters,
        {},
        credential("DATABASE_URL", "postgres")
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_CREDENTIAL_INVALID_REFERENCE" });
  });

  it("fails when the credential type does not match the node", async () => {
    await expect(
      runNode(
        PostgresNode,
        "core.storage.postgres",
        pgParameters,
        {},
        credential("GRAPH_CREDENTIAL_SAA1032_S3", "mysql")
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_CREDENTIAL_TYPE_MISMATCH" });
  });

  it("fails on malformed credential JSON for object credentials", async () => {
    const s3 = await runNode(
      S3StorageNode,
      "core.storage.s3",
      {
        bucket: ENDPOINTS.s3.bucket,
        operation: "has",
        key: "saa1032/missing.txt",
      },
      {},
      credential("GRAPH_CREDENTIAL_SAA1032_S3_BADJSON", "s3")
    ).catch((error) => error);
    expect(s3.graphCode).toBe("GRAPH_CREDENTIAL_INVALID_FORMAT");

    const gcs = await runNode(
      GoogleCloudStorageNode,
      "core.storage.googleCloudStorage",
      {
        bucket: ENDPOINTS.gcs.bucket,
        operation: "has",
        key: "saa1032/missing.txt",
      },
      {},
      credential("GRAPH_CREDENTIAL_SAA1032_GCS_BADJSON", "gcs")
    ).catch((error) => error);
    expect(gcs.graphCode).toBe("GRAPH_CREDENTIAL_INVALID_FORMAT");

    const ftp = await runNode(
      FtpNode,
      "core.devops.ftp",
      {
        host: ENDPOINTS.ftp.host,
        port: ENDPOINTS.ftp.port,
        username: ENDPOINTS.ftp.username,
        operation: "list",
      },
      {},
      credential("GRAPH_CREDENTIAL_SAA1032_SFTP_BADJSON", "sftp")
    ).catch((error) => error);
    expect(ftp.graphCode).toBe("GRAPH_CREDENTIAL_INVALID_FORMAT");
  });

  it("never echoes the resolved secret into the node result", async () => {
    const secret = "minioadmin";
    const result = await runNode(
      S3StorageNode,
      "core.storage.s3",
      {
        bucket: ENDPOINTS.s3.bucket,
        region: ENDPOINTS.s3.region,
        endpoint: `http://${ENDPOINTS.s3.host}:${ENDPOINTS.s3.port}`,
        forcePathStyle: true,
        operation: "has",
        key: `saa1032/not-present-${Date.now()}.txt`,
      },
      {},
      credential("GRAPH_CREDENTIAL_SAA1032_S3", "s3")
    );
    expect(result.result).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
