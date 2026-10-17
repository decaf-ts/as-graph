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
 * SAA-922 regression coverage pins the MASTRA_ credential-variable naming
 * convention (a `credentialRef` can never name an arbitrary host secret) and
 * the recursive plaintext scan of the `connection` options.
 */
import { describe, it, expect, afterEach, beforeEach } from "@jest/globals";
import type { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";
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

/**
 * The error a resolver call throws, for assertions on its graph code and
 * details; fails the test when the call resolves instead of refusing.
 */
function refusalOf(fn: () => unknown): GraphExecutionError {
  try {
    fn();
  } catch (error) {
    return error as GraphExecutionError;
  }
  throw new Error("expected the resolver to refuse the configuration");
}

describe("mastra vector-store MASTRA_ credential-name gate (SAA-922 regression)", () => {
  /** Host variables the hostile configs reference, saved for restoration. */
  const HOST_VARS = [
    "LANGFUSE_SECRET_KEY",
    "MY_TOKEN",
    "langfuse_secret_key",
    "MASTRA_PG\nPASSWORD",
  ] as const;
  const hostOriginals: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of HOST_VARS) {
      hostOriginals[name] = process.env[name];
      process.env[name] = "host-secret";
    }
  });

  afterEach(() => {
    for (const name of HOST_VARS) {
      if (hostOriginals[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = hostOriginals[name];
      }
    }
  });

  it("refuses a pgvector credentialRef naming a non-MASTRA_ host variable", () => {
    // Pre-fix (SAA-911 staged baseline) this resolved the host secret
    // LANGFUSE_SECRET_KEY into the binding's password options.
    const config = {
      provider: "pgvector",
      id: "vs",
      connection: { host: "localhost", port: 5432, database: "db", user: "u" },
      credentialRef: { credentialId: "LANGFUSE_SECRET_KEY", credentialType: "pg" },
    } as unknown as MastraVectorStoreConfig;
    const refusal = refusalOf(() =>
      resolveMastraVectorStore(config, {
        bindings: { pgvector: recordingBinding },
      })
    );
    expect(refusal.graphCode).toBe(GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE);
    expect(JSON.stringify(refusal)).not.toContain("host-secret");
  });

  it("refuses a credentialed redis store referencing a non-MASTRA_ host variable", () => {
    const config = {
      provider: "redis",
      id: "vs",
      connection: { host: "localhost", port: 6379 },
      credentialRef: { credentialId: "LANGFUSE_SECRET_KEY", credentialType: "redis" },
    } as unknown as MastraVectorStoreConfig;
    const refusal = refusalOf(() =>
      resolveMastraVectorStore(config, {
        bindings: { redis: recordingBinding },
      })
    );
    expect(refusal.graphCode).toBe(GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE);
  });

  it("refuses non-conforming credential names even when the host variable exists", () => {
    // A lowercase name, a foreign prefix, and a valid-looking name carrying
    // embedded junk must all fail closed — pre-fix each resolved when the
    // host variable was set.
    for (const name of ["langfuse_secret_key", "MY_TOKEN", "MASTRA_PG\nPASSWORD"]) {
      const config = {
        provider: "pgvector",
        id: "vs",
        connection: { host: "localhost", port: 5432, database: "db", user: "u" },
        credentialRef: { credentialId: name, credentialType: "pg" },
      } as unknown as MastraVectorStoreConfig;
      const refusal = refusalOf(() =>
        resolveMastraVectorStore(config, {
          bindings: { pgvector: recordingBinding },
        })
      );
      expect(refusal.graphCode).toBe(GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE);
      expect(refusal.details).toMatchObject({ credentialId: name });
    }
  });

  it("refuses plaintext credential material nested inside the connection options", () => {
    // Pre-fix only the connection's top-level keys were scanned; nested
    // members (plain objects, array elements, deep connectionString) slipped
    // through into the binding options.
    const nested: Array<[Record<string, unknown>, string]> = [
      [{ nested: { password: "plaintext-secret" } }, "nested.password"],
      [
        { tables: [{ name: "docs", password: "plaintext-secret" }] },
        "tables.password",
      ],
      [
        {
          pool: { tunables: { connectionString: "postgres://u:p@h/db" } },
        },
        "pool.tunables.connectionString",
      ],
    ];
    for (const [members, path] of nested) {
      const config = {
        provider: "pgvector",
        id: "vs",
        connection: { host: "localhost", ...members },
        credentialRef: { credentialId: ENV_OVERRIDE, credentialType: "pg" },
      } as unknown as MastraVectorStoreConfig;
      process.env[ENV_OVERRIDE] = "resolved-secret";
      const refusal = refusalOf(() =>
        resolveMastraVectorStore(config, {
          bindings: { pgvector: recordingBinding },
        })
      );
      expect(refusal.graphCode).toBe(GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED);
      expect(refusal.details).toMatchObject({
        key: path.split(".").pop(),
        path,
      });
      expect(JSON.stringify(refusal)).not.toContain("plaintext-secret");
      delete process.env[ENV_OVERRIDE];
    }
  });
});
