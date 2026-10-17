/**
 * @module as-graph/tests/unit/graph/mastra/MastraVectorCredentialGate
 * @summary SAA-911 F4 unit evidence: the RAG vector-store credential gate.
 * @description Pins the gate-C contract for mastra-native vector-store
 * bindings: plaintext credential material in a config's `connection` options
 * is refused (never stripped), a `pgvector` binding requires a `credentialRef`
 * naming the environment variable that carries the password, a `redis`
 * binding resolves its password only when a reference is configured, and the
 * resolved value flows only into the binding's own constructor options — it
 * is never echoed into an error or a descriptor. All failures use the
 * fail-closed mastra error codes; no real backend package is needed.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import {
  resolveMastraVectorStore,
  type MastraVectorConstructor,
} from "../../../../src/mastra/MastraVectorStore";
import type { MastraVectorStoreConfig } from "../../../../src/mastra/MastraVectorStore";
import {
  GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE,
  GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED,
} from "../../../../src/mastra/MastraEnvironment";
import { graphCodeOf } from "./helpers";

/** A recording fake binding capturing its constructor options. */
class RecordingBinding {
  readonly options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    this.options = options;
  }
}

/** The recording fake binding typed as a host-provided mastra binding. */
const recordingBinding = RecordingBinding as unknown as MastraVectorConstructor;

const ENV_OVERRIDE = "MASTRA_TEST_VECTOR_PASSWORD";
let envOriginal: string | undefined;

afterEach(() => {
  if (envOriginal === undefined) {
    delete process.env[ENV_OVERRIDE];
  } else {
    process.env[ENV_OVERRIDE] = envOriginal;
  }
});

describe("mastra vector-store credential gate (SAA-911 F4)", () => {
  it("refuses plaintext credential material in the connection options", () => {
    for (const key of ["password", "connectionString", "apiKey", "token"]) {
      const config = {
        provider: "pgvector",
        id: "vs",
        connection: { host: "localhost", [key]: "plaintext" },
        credentialRef: { credentialId: ENV_OVERRIDE, credentialType: "pg" },
      } as unknown as MastraVectorStoreConfig;
      expect(
        graphCodeOf(() =>
          resolveMastraVectorStore(config, {
            bindings: { pgvector: recordingBinding },
          })
        )
      ).toBe(GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED);
    }
  });

  it("requires a credentialRef for the pgvector binding", () => {
    const config = {
      provider: "pgvector",
      id: "vs",
      connection: { host: "localhost", port: 5432 },
    } as unknown as MastraVectorStoreConfig;
    expect(
      graphCodeOf(() =>
        resolveMastraVectorStore(config, {
          bindings: { pgvector: recordingBinding },
        })
      )
    ).toBe(GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE);
  });

  it("fails closed when the referenced pgvector credential is unset", () => {
    const config = {
      provider: "pgvector",
      id: "vs",
      connection: { host: "localhost", port: 5432, database: "db", user: "u" },
      credentialRef: { credentialId: ENV_OVERRIDE, credentialType: "pg" },
    } as unknown as MastraVectorStoreConfig;
    expect(
      graphCodeOf(() =>
        resolveMastraVectorStore(config, {
          bindings: { pgvector: recordingBinding },
        })
      )
    ).toBe(GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE);
  });

  it("resolves the pgvector credential by name into the binding options only", () => {
    process.env[ENV_OVERRIDE] = "resolved-secret";
    const config = {
      provider: "pgvector",
      id: "vs",
      connection: { host: "localhost", port: 5432, database: "db", user: "u" },
      credentialRef: { credentialId: ENV_OVERRIDE, credentialType: "pg" },
    } as unknown as MastraVectorStoreConfig;
    const { store, descriptor } = resolveMastraVectorStore(config, {
      bindings: { pgvector: recordingBinding },
    });
    expect(store).toBeInstanceOf(RecordingBinding);
    expect((store as unknown as RecordingBinding).options).toMatchObject({
      id: "vs",
      host: "localhost",
      password: "resolved-secret",
    });
    expect(JSON.stringify(descriptor)).not.toContain("resolved-secret");
    expect(JSON.stringify(descriptor)).toContain(ENV_OVERRIDE);
  });

  it("keeps a passwordless redis binding usable and injects the password only through a credentialRef", () => {
    const passwordless = {
      provider: "redis",
      id: "vs",
      connection: { host: "localhost", port: 6379 },
    } as unknown as MastraVectorStoreConfig;
    const resolved = resolveMastraVectorStore(passwordless, {
      bindings: { redis: recordingBinding },
    });
    expect((resolved.store as unknown as RecordingBinding).options).toEqual({
      host: "localhost",
      port: 6379,
      id: "vs",
    });

    const credentialed = {
      provider: "redis",
      id: "vs",
      connection: { host: "localhost", port: 6379 },
      credentialRef: { credentialId: ENV_OVERRIDE, credentialType: "redis" },
    } as unknown as MastraVectorStoreConfig;
    expect(
      graphCodeOf(() =>
        resolveMastraVectorStore(credentialed, {
          bindings: { redis: recordingBinding },
        })
      )
    ).toBe(GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE);

    process.env[ENV_OVERRIDE] = "redis-secret";
    const withSecret = resolveMastraVectorStore(credentialed, {
      bindings: { redis: recordingBinding },
    });
    expect((withSecret.store as unknown as RecordingBinding).options).toMatchObject(
      { password: "redis-secret" }
    );
    expect(
      (withSecret.descriptor as unknown as Record<string, unknown>)[
        "credentialRef"
      ]
    ).toEqual({ credentialId: ENV_OVERRIDE, credentialType: "redis" });
  });

  it("never fabricates a store when the host binding is absent", () => {
    const config = {
      provider: "pgvector",
      id: "vs",
      credentialRef: { credentialId: ENV_OVERRIDE, credentialType: "pg" },
    } as unknown as MastraVectorStoreConfig;
    expect(graphCodeOf(() => resolveMastraVectorStore(config, {}))).toBe(
      "GRAPH_MASTRA_VECTOR_UNAVAILABLE"
    );
  });
});
