/**
 * @module as-graph/tests/integration/graph/nodes/real-service-support
 * @summary Shared helpers for the live node integration suites.
 * @description Drives the production node instantiation/execution contract
 * (`executeNode` → `nodeClass.instantiate` → `instance.execute`) against the
 * local Docker service matrix supplied with SAA-1032/SAA-1142.
 *
 * Credentials follow the Phase B.1 runtime contract (SAA-1141): a node resolves
 * its `credentialRef` through the **ctx-bound** `GraphNodeCredentialResolver`
 * exposed by the engine, which calls the credential service and then the
 * provider-specific secret service. The suites therefore register their test
 * credentials in an explicit in-memory services double keyed by `credentialId`
 * and never write `GRAPH_CREDENTIAL_*` variables into `process.env`; nothing
 * here reads a credential from the environment implicitly.
 */
import { generateKeyPairSync } from "node:crypto";
import type { GraphNodeClass } from "../../../../src/node/base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
  GraphResolvedCredentials,
} from "../../../../src/engine/types";
import type { GraphExecutionEngine } from "../../../../src/engine/execution/GraphExecutionEngine";
import {
  GraphNodeCredentialResolver,
  type GraphCredentialRecord,
  type GraphNodeCredentialServices,
  type GraphNodeCredentialSecret,
  type GraphSecretServicePort,
} from "../../../../src/engine/credentials/GraphNodeCredentials";
import {
  executeNode,
  nodeExecutionRequest,
} from "../../../unit/graph/engine-fixtures";
import { buildNodeContext } from "../../../unit/graph/nodes/node-test-utils";

/** Bridge address of the Docker host from inside the agent container. */
const HOST = process.env["SAA1032_SERVICE_HOST"] ?? "172.17.0.1";

/** Endpoints for the live integration service matrix. */
export const ENDPOINTS = {
  postgres: {
    host: process.env["SAA1032_PG_HOST"] ?? HOST,
    port: Number(process.env["SAA1032_PG_PORT"] ?? 55440),
    username: "postgres",
    password: "postgres",
    database: "test",
  },
  pgvector: {
    host: process.env["GRAPH_IT_PGVECTOR_HOST"] ?? HOST,
    port: Number(process.env["GRAPH_IT_PGVECTOR_PORT"] ?? 55441),
    username: process.env["GRAPH_IT_PGVECTOR_USER"] ?? "postgres",
    password: process.env["GRAPH_IT_PGVECTOR_PASSWORD"] ?? "postgres",
    database: process.env["GRAPH_IT_PGVECTOR_DATABASE"] ?? "test",
  },
  age: {
    host: process.env["GRAPH_IT_AGE_HOST"] ?? HOST,
    port: Number(process.env["GRAPH_IT_AGE_PORT"] ?? 55442),
    username: process.env["GRAPH_IT_AGE_USER"] ?? "postgres",
    password: process.env["GRAPH_IT_AGE_PASSWORD"] ?? "postgres",
    database: process.env["GRAPH_IT_AGE_DATABASE"] ?? "test",
  },
  dagster: {
    graphqlUrl:
      process.env["DAGSTER_GRAPHQL_URL"] ?? "http://127.0.0.1:3000/graphql",
  },
  mailpit: {
    host: process.env["AS_GRAPH_IT_SMTP_HOST"] ?? HOST,
    port: Number(process.env["AS_GRAPH_IT_SMTP_PORT"] ?? 1025),
    httpUrl: process.env["AS_GRAPH_IT_MAILPIT_HTTP"] ?? `http://${HOST}:8025`,
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
  rabbitmq: {
    host: process.env["SAA1032_RABBITMQ_HOST"] ?? HOST,
    port: Number(process.env["SAA1032_RABBITMQ_PORT"] ?? 55672),
    username: process.env["SAA1032_RABBITMQ_USER"] ?? "asgraph",
    password: process.env["SAA1032_RABBITMQ_PASSWORD"] ?? "asgraph",
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

/** Options accepted when registering an integration-test credential. */
export interface TestCredentialOptions {
  /** Secret provider (`model` or `filesystem`); defaults to `filesystem`. */
  provider?: string;
  /** Stored credential type; defaults to unset (no stored-type check). */
  credentialType?: string;
  /** Whether the credential is enabled; defaults to `true`. */
  enabled?: boolean;
  /** Absolute or relative expiry; defaults to no expiry. */
  expiresAt?: Date | string | null;
}

interface RegisteredCredential {
  record: GraphCredentialRecord;
  secret: GraphNodeCredentialSecret;
}

/**
 * The in-memory credential/secret registry the suites populate. It is the
 * explicit ctx-bound double for `GraphNodeCredentialServices`: no `@service()`,
 * no `Environment` binding and no process-environment fallback.
 */
const CREDENTIALS = new Map<string, RegisteredCredential>();

/**
 * Registers a credential secret under its `credentialRef.credentialId`.
 *
 * @param name - The credential id a node's `credentialRef` carries.
 * @param value - The secret payload the resolver returns.
 * @param options - Optional provider/type/status metadata.
 * @returns The credential id, for use with {@link clearCredentials}.
 */
export function setCredential(
  name: string,
  value: GraphNodeCredentialSecret,
  options: TestCredentialOptions = {}
): string {
  CREDENTIALS.set(name, {
    record: {
      id: name,
      name,
      credentialType: options.credentialType ?? "",
      secretName: name,
      provider: options.provider ?? "filesystem",
      enabled: options.enabled ?? true,
      expiresAt: options.expiresAt ?? null,
    },
    secret: value,
  });
  return name;
}

/**
 * Removes every named credential from the in-memory registry.
 *
 * @param names - The credential ids to remove.
 */
export function clearCredentials(...names: string[]): void {
  for (const name of names) CREDENTIALS.delete(name);
}

/** Builds a provider-bound secret-service port over the registry. */
function secretService(provider: string): GraphSecretServicePort {
  return {
    provider,
    retrieve: async (nameOrRef: string) => {
      const entry = CREDENTIALS.get(nameOrRef);
      if (!entry) {
        throw new Error(`secret '${nameOrRef}' is not registered`);
      }
      return entry.secret;
    },
  };
}

/** The credential services double the resolver is constructed with. */
export const TEST_CREDENTIAL_SERVICES: GraphNodeCredentialServices = {
  credentialService: {
    getCredential: async (credentialId: string) => {
      const entry = CREDENTIALS.get(credentialId);
      if (!entry) {
        throw new Error(`credential '${credentialId}' is not registered`);
      }
      return entry.record;
    },
    markCredentialUsed: async () => undefined,
  },
  modelSecretService: secretService("model"),
  fsSecretService: secretService("filesystem"),
};

/** The ctx-bound resolver every node runs with. */
export function testCredentialResolver(): GraphNodeCredentialResolver {
  return new GraphNodeCredentialResolver(TEST_CREDENTIAL_SERVICES);
}

/**
 * Wraps an engine so `context.engine.nodeCredentials` resolves the test
 * credentials. Existing engine behaviour is preserved through the prototype.
 *
 * @param engine - An optional engine facade the node needs for nested work.
 * @returns The engine (or a facade) carrying the test resolver.
 */
function withTestCredentials(
  engine?: GraphExecutionEngine
): GraphExecutionEngine {
  const base = engine ?? ({} as GraphExecutionEngine);
  Object.defineProperty(base, "nodeCredentials", {
    value: testCredentialResolver(),
    configurable: true,
    enumerable: false,
  });
  return base;
}

/** Builds the executor credential record for a single `credentialRef`. */
export function credential(
  credentialId: string,
  credentialType: string
): GraphResolvedCredentials {
  return { credentialRef: { credentialId, credentialType } };
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
 * Executes one node through the production instantiation contract with the
 * ctx-bound test credential resolver installed on the execution context.
 *
 * @param nodeClass - The built-in node class under test.
 * @param kind - The node kind (used by the execution context).
 * @param parameters - Hydrated instance configuration.
 * @param inputs - Upstream execution values.
 * @param credentials - Resolved credential references.
 * @param engine - Optional engine facade (nested workflow/webhook/etc. work).
 */
export async function runNode(
  nodeClass: GraphNodeClass,
  kind: string,
  parameters: Record<string, unknown>,
  inputs: Record<string, unknown> = {},
  credentials: GraphResolvedCredentials = {},
  engine?: GraphExecutionEngine
): Promise<GraphExecutionValues> {
  const context = buildNodeContext(kind, {
    parameters,
    engine: withTestCredentials(engine),
  });
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
