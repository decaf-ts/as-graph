/**
 * @module as-graph/tests/integration/graph/nodes/real-service-support
 * @summary Shared helpers for the SAA-1027 Stage 3a real-service node suites.
 * @description Drives the production node instantiation/execution contract
 * (`executeNode` → `nodeClass.instantiate` → `instance.execute`) against the
 * local Docker service matrix supplied with SAA-1032. Credentials are injected
 * through `process.env[GRAPH_CREDENTIAL_*]` exactly as the runtime resolves
 * them, and every suite removes the variables it set.
 */
import { generateKeyPairSync } from "node:crypto";
import type { GraphNodeClass } from "../../../../src/node/base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
  GraphResolvedCredentials,
} from "../../../../src/engine/types";
import {
  executeNode,
  nodeExecutionRequest,
} from "../../../unit/graph/engine-fixtures";
import { buildNodeContext } from "../../../unit/graph/nodes/node-test-utils";

/** Bridge address of the Docker host from inside the agent container. */
const HOST = process.env["SAA1032_SERVICE_HOST"] ?? "172.17.0.1";

/** Endpoints for the SAA-1032 real services. */
export const ENDPOINTS = {
  postgres: {
    host: process.env["SAA1032_PG_HOST"] ?? HOST,
    port: Number(process.env["SAA1032_PG_PORT"] ?? 55440),
    username: "postgres",
    password: "postgres",
    database: "test",
  },
  mysql: {
    host: process.env["SAA1032_MYSQL_HOST"] ?? HOST,
    port: Number(process.env["SAA1032_MYSQL_PORT"] ?? 53306),
    username: "root",
    password: "mysql",
    database: "test",
  },
  mssql: {
    host: process.env["SAA1032_MSSQL_HOST"] ?? HOST,
    port: Number(process.env["SAA1032_MSSQL_PORT"] ?? 51433),
    username: "sa",
    password: process.env["SAA1032_MSSQL_PASSWORD"] ?? "Str0ng!Passw0rd",
    database: "master",
  },
  redis: {
    host: process.env["SAA1032_REDIS_HOST"] ?? HOST,
    port: Number(process.env["SAA1032_REDIS_PORT"] ?? 56379),
  },
  s3: {
    host: process.env["SAA1032_S3_HOST"] ?? HOST,
    port: Number(process.env["SAA1032_S3_PORT"] ?? 59000),
    bucket: "test-bucket",
    region: "us-east-1",
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
  },
  azure: {
    connectionString:
      process.env["SAA1032_AZURE_CONNECTION_STRING"] ??
      "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
        "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
        `BlobEndpoint=http://${HOST}:10010/devstoreaccount1;`,
    container: "test-container",
  },
  gcs: {
    host: process.env["SAA1032_GCS_HOST"] ?? HOST,
    port: Number(process.env["SAA1032_GCS_PORT"] ?? 54444),
    bucket: "test-bucket",
    projectId: "test",
  },
  ftp: {
    host: process.env["SAA1032_SFTP_HOST"] ?? HOST,
    port: Number(process.env["SAA1032_SFTP_PORT"] ?? 52222),
    username: "testuser",
    password: "testpass",
    root: "/upload",
  },
} as const;

/** A unique key/table namespace for this test process. */
export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Builds the executor credential record for a single `credentialRef`. */
export function credential(
  credentialId: string,
  credentialType: string
): GraphResolvedCredentials {
  return { credentialRef: { credentialId, credentialType } };
}

/** Sets a `GRAPH_CREDENTIAL_*` variable and returns its name. */
export function setCredential(name: string, value: string): string {
  process.env[name] = value;
  return name;
}

/** Removes every environment variable a suite registered. */
export function clearCredentials(...names: string[]): void {
  for (const name of names) delete process.env[name];
}

/** Generates the fake-GCS service-account JSON accepted by fake-gcs-server. */
export function gcsServiceAccountJson(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return JSON.stringify({
    type: "service_account",
    project_id: ENDPOINTS.gcs.projectId,
    client_email: "saa1032@test.iam.gserviceaccount.com",
    private_key: privateKey,
  });
}

/** Builds the S3 credential JSON understood by the S3 node. */
export function s3CredentialJson(): string {
  return JSON.stringify({
    accessKeyId: ENDPOINTS.s3.accessKeyId,
    secretAccessKey: ENDPOINTS.s3.secretAccessKey,
  });
}

/**
 * Executes one node through the production instantiation contract.
 *
 * @param nodeClass - The built-in node class under test.
 * @param kind - The node kind (used by the execution context).
 * @param parameters - Hydrated instance configuration.
 * @param inputs - Upstream execution values.
 * @param credentials - Resolved credential references.
 */
export async function runNode(
  nodeClass: GraphNodeClass,
  kind: string,
  parameters: Record<string, unknown>,
  inputs: Record<string, unknown> = {},
  credentials: GraphResolvedCredentials = {}
): Promise<GraphExecutionValues> {
  const context = buildNodeContext(kind, { parameters });
  const request: GraphNodeExecutionRequest = nodeExecutionRequest(inputs, {
    kind,
    credentials,
  });
  return await executeNode(nodeClass, request, context);
}

/** Asserts a GraphExecutionError code without depending on jest globals. */
export function errorCodeOf(error: unknown): string | undefined {
  return (error as { graphCode?: string } | undefined)?.graphCode;
}
