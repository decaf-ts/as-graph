/**
 * @module as-graph/tests/unit/graph/credentials/GraphNodeCredentials
 * @summary SAA-1143 regression for the ctx-bound node credential resolver
 * (SAA-1141 Phase B.1).
 * @description Pins the credential contract migrated nodes rely on:
 *
 * - `GraphNodeCredentialResolver` short-circuits an optional missing reference
 *   without touching any service, fails closed for a required missing reference,
 *   and maps type/disabled/expired/not-found/provider faults to their documented
 *   `GRAPH_CREDENTIAL_*` codes;
 * - the `model` and `filesystem` providers route to the matching secret service,
 *   normalize string/record/binary/null payloads, and record usage;
 * - `resolveNodeCredential` only ever resolves through the engine's
 *   `nodeCredentials` resolver on the execution context (never `process.env`),
 *   awaits it, and fails closed with `GRAPH_CREDENTIAL_SERVICE_UNAVAILABLE` when
 *   the engine exposes no resolver;
 * - a migrated node (`core.devops.jwt`) awaits that ctx-bound resolver before
 *   signing and ignores a plaintext environment secret.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { Context } from "@decaf-ts/core";
import { verify } from "@decaf-ts/crypto/jwt";
import {
  GraphNodeCredentialResolver,
  resolveNodeCredential,
  type GraphCredentialRecord,
  type GraphNodeCredentialServices,
} from "../../../../src/engine/credentials/GraphNodeCredentials";
import type { GraphExecutionEngine } from "../../../../src/engine/execution/GraphExecutionEngine";
import type { GraphCredentialReference } from "../../../../src/shared/graph";
import { JwtNode } from "../../../../src/node";
import { buildNodeContext } from "../nodes/node-test-utils";
import { executeNode, nodeExecutionRequest } from "../engine-fixtures";

/** Stored credential id used across the resolver cases. */
const CREDENTIAL_ID = "cred-1143";

/** A `github` credential reference as a resolved node would carry it. */
const GITHUB_REFERENCE: GraphCredentialReference = {
  credentialId: CREDENTIAL_ID,
  credentialType: "github",
};

/** Environment secret a migrated node must never fall back to. */
const ENV_SECRET = "env-plaintext-secret-must-not-be-used";

/** Canonical stored credential record (model provider, enabled, no expiry). */
function credentialRecord(
  overrides: Partial<GraphCredentialRecord> = {}
): GraphCredentialRecord {
  return {
    id: CREDENTIAL_ID,
    name: "GitHub token",
    credentialType: "github",
    secretName: "github/token",
    provider: "model",
    enabled: true,
    ...overrides,
  };
}

type RecordSource =
  | GraphCredentialRecord
  | (() => GraphCredentialRecord | Promise<GraphCredentialRecord>);

interface HarnessOptions {
  record?: RecordSource;
  modelPayload?: unknown;
  fsPayload?: unknown;
  includeFs?: boolean;
  includeMarkUsed?: boolean;
}

/** Builds a credential-services double with observable spies. */
function harness(options: HarnessOptions = {}) {
  const getCredential = jest.fn(async () => {
    const source = options.record;
    return typeof source === "function"
      ? await source()
      : source ?? credentialRecord();
  });
  const markCredentialUsed = jest.fn(async () => undefined);
  const modelRetrieve = jest.fn(async () =>
    "modelPayload" in options ? options.modelPayload : "model-secret"
  );
  const fsRetrieve = jest.fn(async () =>
    "fsPayload" in options ? options.fsPayload : "fs-secret"
  );

  const services: GraphNodeCredentialServices = {
    credentialService: {
      getCredential,
      ...(options.includeMarkUsed === false ? {} : { markCredentialUsed }),
    },
    modelSecretService: { provider: "model", retrieve: modelRetrieve },
    ...(options.includeFs === false
      ? {}
      : { fsSecretService: { provider: "filesystem", retrieve: fsRetrieve } }),
  };

  return {
    services,
    getCredential,
    markCredentialUsed,
    modelRetrieve,
    fsRetrieve,
  };
}

/** Resolves the graph code of a rejected promise, failing when it resolves. */
async function graphCodeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { graphCode?: string }).graphCode ?? "<missing-code>";
  }
  throw new Error("expected the credential resolution to fail closed");
}

describe("GraphNodeCredentialResolver — fail-closed contract (SAA-1143)", () => {
  it("returns undefined for an optional missing reference without touching services", async () => {
    const { services, getCredential, modelRetrieve, fsRetrieve } = harness();
    const resolver = new GraphNodeCredentialResolver(services);

    await expect(
      resolver.resolve(undefined, "github", false, "GitHub")
    ).resolves.toBeUndefined();
    expect(getCredential).not.toHaveBeenCalled();
    expect(modelRetrieve).not.toHaveBeenCalled();
    expect(fsRetrieve).not.toHaveBeenCalled();
  });

  it("fails GRAPH_CREDENTIAL_MISSING for a required missing reference", async () => {
    const { services, getCredential } = harness();
    const resolver = new GraphNodeCredentialResolver(services);

    await expect(
      resolver.resolve(undefined, "github", true, "GitHub")
    ).rejects.toMatchObject({
      graphCode: "GRAPH_CREDENTIAL_MISSING",
      details: { credentialType: "github" },
    });
    expect(getCredential).not.toHaveBeenCalled();
  });

  it("fails GRAPH_CREDENTIAL_TYPE_MISMATCH when the reference type differs", async () => {
    const { services, getCredential } = harness();
    const resolver = new GraphNodeCredentialResolver(services);

    await expect(
      resolver.resolve(
        { credentialId: CREDENTIAL_ID, credentialType: "slack" },
        "github",
        false,
        "GitHub"
      )
    ).rejects.toMatchObject({
      graphCode: "GRAPH_CREDENTIAL_TYPE_MISMATCH",
      details: { credentialId: CREDENTIAL_ID, credentialType: "slack" },
    });
    expect(getCredential).not.toHaveBeenCalled();
  });

  it("fails GRAPH_CREDENTIAL_TYPE_MISMATCH when the stored record type differs", async () => {
    const { services, getCredential, modelRetrieve } = harness({
      record: credentialRecord({ credentialType: "slack" }),
    });
    const resolver = new GraphNodeCredentialResolver(services);

    await expect(
      resolver.resolve(GITHUB_REFERENCE, "github", true, "GitHub")
    ).rejects.toMatchObject({
      graphCode: "GRAPH_CREDENTIAL_TYPE_MISMATCH",
      details: { credentialId: CREDENTIAL_ID, credentialType: "slack" },
    });
    expect(getCredential).toHaveBeenCalledTimes(1);
    expect(modelRetrieve).not.toHaveBeenCalled();
  });

  it("fails GRAPH_CREDENTIAL_NOT_FOUND when the credential service rejects", async () => {
    const { services } = harness({
      record: () => {
        throw new Error("credential store offline");
      },
    });
    const resolver = new GraphNodeCredentialResolver(services);

    await expect(
      resolver.resolve(GITHUB_REFERENCE, "github", true, "GitHub")
    ).rejects.toMatchObject({
      graphCode: "GRAPH_CREDENTIAL_NOT_FOUND",
      details: {
        credentialId: CREDENTIAL_ID,
        cause: "credential store offline",
      },
    });
  });

  it("fails GRAPH_CREDENTIAL_DISABLED before reading the secret", async () => {
    const { services, modelRetrieve } = harness({
      record: credentialRecord({ enabled: false }),
    });
    const resolver = new GraphNodeCredentialResolver(services);

    await expect(
      resolver.resolve(GITHUB_REFERENCE, "github", true, "GitHub")
    ).rejects.toMatchObject({
      graphCode: "GRAPH_CREDENTIAL_DISABLED",
      details: { credentialId: CREDENTIAL_ID },
    });
    expect(modelRetrieve).not.toHaveBeenCalled();
  });

  it.each<[string, Date | string]>([
    ["a Date in the past", new Date(Date.now() - 60_000)],
    ["an ISO string in the past", "2000-01-01T00:00:00.000Z"],
  ])(
    "fails GRAPH_CREDENTIAL_EXPIRED for %s before reading the secret",
    async (_label, expiresAt) => {
      const { services, modelRetrieve } = harness({
        record: credentialRecord({ expiresAt }),
      });
      const resolver = new GraphNodeCredentialResolver(services);

      await expect(
        resolver.resolve(GITHUB_REFERENCE, "github", true, "GitHub")
      ).rejects.toMatchObject({
        graphCode: "GRAPH_CREDENTIAL_EXPIRED",
        details: { credentialId: CREDENTIAL_ID },
      });
      expect(modelRetrieve).not.toHaveBeenCalled();
    }
  );

  it("resolves a record whose expiry is still in the future", async () => {
    const { services, modelRetrieve } = harness({
      record: credentialRecord({
        expiresAt: new Date(Date.now() + 60_000),
      }),
    });
    const resolver = new GraphNodeCredentialResolver(services);

    await expect(
      resolver.resolve(GITHUB_REFERENCE, "github", true, "GitHub")
    ).resolves.toBe("model-secret");
    expect(modelRetrieve).toHaveBeenCalledTimes(1);
  });

  it("fails GRAPH_CREDENTIAL_PROVIDER_UNSUPPORTED for an unknown provider", async () => {
    const { services, modelRetrieve, fsRetrieve } = harness({
      record: credentialRecord({ provider: "vault" }),
    });
    const resolver = new GraphNodeCredentialResolver(services);

    await expect(
      resolver.resolve(GITHUB_REFERENCE, "github", true, "GitHub")
    ).rejects.toMatchObject({
      graphCode: "GRAPH_CREDENTIAL_PROVIDER_UNSUPPORTED",
      details: { provider: "vault" },
    });
    expect(modelRetrieve).not.toHaveBeenCalled();
    expect(fsRetrieve).not.toHaveBeenCalled();
  });

  it("fails GRAPH_CREDENTIAL_SERVICE_UNAVAILABLE for a filesystem provider without its service", async () => {
    const { services } = harness({
      record: credentialRecord({ provider: "filesystem" }),
      includeFs: false,
    });
    const resolver = new GraphNodeCredentialResolver(services);

    await expect(
      resolver.resolve(GITHUB_REFERENCE, "github", true, "GitHub")
    ).rejects.toMatchObject({
      graphCode: "GRAPH_CREDENTIAL_SERVICE_UNAVAILABLE",
      details: { provider: "filesystem" },
    });
  });
});

describe("GraphNodeCredentialResolver — provider routing and normalization (SAA-1143)", () => {
  it("routes a model provider through the model secret service", async () => {
    const context = new Context();
    const { services, modelRetrieve, fsRetrieve } = harness({
      modelPayload: "model-secret",
    });
    const resolver = new GraphNodeCredentialResolver(services);

    await expect(
      resolver.resolve(GITHUB_REFERENCE, "github", true, "GitHub", context)
    ).resolves.toBe("model-secret");
    expect(modelRetrieve).toHaveBeenCalledWith(
      "github/token",
      {},
      context
    );
    expect(fsRetrieve).not.toHaveBeenCalled();
  });

  it("routes a filesystem provider through the filesystem secret service", async () => {
    const context = new Context();
    const { services, modelRetrieve, fsRetrieve } = harness({
      record: credentialRecord({ provider: "filesystem" }),
      fsPayload: "fs-secret",
    });
    const resolver = new GraphNodeCredentialResolver(services);

    await expect(
      resolver.resolve(GITHUB_REFERENCE, "github", true, "GitHub", context)
    ).resolves.toBe("fs-secret");
    expect(fsRetrieve).toHaveBeenCalledWith("github/token", {}, context);
    expect(modelRetrieve).not.toHaveBeenCalled();
  });

  it.each<[string, unknown, unknown]>([
    ["a string payload", "plain-secret", "plain-secret"],
    [
      "a record payload",
      { token: "abc", region: "eu" },
      { token: "abc", region: "eu" },
    ],
    [
      "a binary payload",
      new TextEncoder().encode("binary-secret"),
      "binary-secret",
    ],
    ["a numeric payload", 42, "42"],
    ["a null payload", null, undefined],
    ["an undefined payload", undefined, undefined],
  ])("normalizes %s", async (_label, payload, expected) => {
    const { services } = harness({ modelPayload: payload });
    const resolver = new GraphNodeCredentialResolver(services);

    await expect(
      resolver.resolve(GITHUB_REFERENCE, "github", true, "GitHub")
    ).resolves.toEqual(expected);
  });

  it("awaits the secret service before resolving", async () => {
    let settled = false;
    const { services } = harness();
    services.modelSecretService.retrieve = jest.fn(
      () =>
        new Promise<unknown>((resolve) => {
          setTimeout(() => {
            settled = true;
            resolve("late-secret");
          }, 5);
        })
    );
    const resolver = new GraphNodeCredentialResolver(services);

    const result = await resolver.resolve(
      GITHUB_REFERENCE,
      "github",
      true,
      "GitHub"
    );
    expect(settled).toBe(true);
    expect(result).toBe("late-secret");
  });

  it("records credential usage with the credential id and context", async () => {
    const context = new Context();
    const { services, markCredentialUsed } = harness();
    const resolver = new GraphNodeCredentialResolver(services);

    await resolver.resolve(GITHUB_REFERENCE, "github", true, "GitHub", context);
    expect(markCredentialUsed).toHaveBeenCalledWith(CREDENTIAL_ID, context);
  });

  it("still resolves the secret when recording usage fails", async () => {
    const { services, markCredentialUsed } = harness();
    markCredentialUsed.mockRejectedValueOnce(new Error("audit store offline"));
    const resolver = new GraphNodeCredentialResolver(services);

    await expect(
      resolver.resolve(GITHUB_REFERENCE, "github", true, "GitHub")
    ).resolves.toBe("model-secret");
  });

  it("permits a services double without the optional usage hook", async () => {
    const { services } = harness({ includeMarkUsed: false });
    const resolver = new GraphNodeCredentialResolver(services);

    await expect(
      resolver.resolve(GITHUB_REFERENCE, "github", true, "GitHub")
    ).resolves.toBe("model-secret");
  });
});

describe("resolveNodeCredential — engine-bound resolution (SAA-1143)", () => {
  it("returns undefined for an optional missing reference without any engine", async () => {
    await expect(
      resolveNodeCredential(undefined, {}, "github", false, "GitHub")
    ).resolves.toBeUndefined();
  });

  it("fails GRAPH_CREDENTIAL_MISSING for a required missing reference", async () => {
    await expect(
      resolveNodeCredential(undefined, {}, "github", true, "GitHub")
    ).rejects.toMatchObject({
      graphCode: "GRAPH_CREDENTIAL_MISSING",
      details: { credentialType: "github" },
    });
  });

  it.each<[string, Context | undefined]>([
    ["no context", undefined],
    ["a context without an engine", new Context()],
    [
      "an engine without credential services",
      { engine: {} } as unknown as Context,
    ],
  ])(
    "fails GRAPH_CREDENTIAL_SERVICE_UNAVAILABLE for %s",
    async (_label, context) => {
      await expect(
        resolveNodeCredential(
          context,
          { credentialRef: GITHUB_REFERENCE },
          "github",
          true,
          "GitHub"
        )
      ).rejects.toMatchObject({
        graphCode: "GRAPH_CREDENTIAL_SERVICE_UNAVAILABLE",
        details: { node: "GitHub", credentialType: "github" },
      });
    }
  );

  it("awaits the engine resolver and passes the reference contract through", async () => {
    let settled = false;
    const resolve = jest.fn(
      () =>
        new Promise<unknown>((done) => {
          setTimeout(() => {
            settled = true;
            done("engine-secret");
          }, 5);
        })
    );
    const engine = {
      nodeCredentials: { resolve },
    } as unknown as GraphExecutionEngine;
    const context = { engine } as unknown as Context;

    const secret = await resolveNodeCredential(
      context,
      { credentialRef: GITHUB_REFERENCE },
      "github",
      true,
      "GitHub"
    );

    expect(settled).toBe(true);
    expect(secret).toBe("engine-secret");
    expect(resolve).toHaveBeenCalledWith(
      GITHUB_REFERENCE,
      "github",
      true,
      "GitHub",
      context
    );
  });

  it("reads the reference under the requested id", async () => {
    const resolve = jest.fn(async () => "engine-secret");
    const engine = {
      nodeCredentials: { resolve },
    } as unknown as GraphExecutionEngine;
    const context = { engine } as unknown as Context;

    await resolveNodeCredential(
      context,
      { other: GITHUB_REFERENCE },
      "github",
      true,
      "GitHub",
      "other"
    );

    expect(resolve).toHaveBeenCalledWith(
      GITHUB_REFERENCE,
      "github",
      true,
      "GitHub",
      context
    );
  });
});

describe("migrated node credential smoke coverage (SAA-1143)", () => {
  const reference: GraphCredentialReference = {
    credentialId: "cred-jwt",
    credentialType: "jwt",
  };

  afterEach(() => {
    delete process.env["JWT_SECRET"];
  });

  it("awaits the engine resolver before signing and ignores a plaintext env secret", async () => {
    process.env["JWT_SECRET"] = ENV_SECRET;
    let settled = false;
    const resolve = jest.fn(
      () =>
        new Promise<unknown>((done) => {
          setTimeout(() => {
            settled = true;
            done("resolver-jwt-secret");
          }, 5);
        })
    );
    const engine = {
      nodeCredentials: { resolve },
    } as unknown as GraphExecutionEngine;
    const context = buildNodeContext("core.devops.jwt", {
      engine,
      parameters: {
        operation: "sign",
        claims: { sub: "saa-1143" },
      },
    });
    const request = nodeExecutionRequest(
      {},
      { credentials: { credentialRef: reference } }
    );

    const output = (await executeNode(JwtNode, request, context)) as {
      token?: string;
    };

    expect(settled).toBe(true);
    expect(typeof output.token).toBe("string");
    await expect(
      verify(output.token as string, { secret: "resolver-jwt-secret" })
    ).resolves.toMatchObject({ sub: "saa-1143" });
    await expect(
      Promise.resolve().then(() =>
        verify(output.token as string, { secret: ENV_SECRET })
      )
    ).rejects.toBeDefined();
    expect(resolve).toHaveBeenCalledWith(
      reference,
      "jwt",
      true,
      "JWT",
      context
    );
  });

  it("fails closed instead of reading the env secret when the engine has no resolver", async () => {
    process.env["JWT_SECRET"] = ENV_SECRET;
    const context = buildNodeContext("core.devops.jwt", {
      parameters: {
        operation: "sign",
        claims: { sub: "saa-1143" },
      },
    });
    const request = nodeExecutionRequest(
      {},
      { credentials: { credentialRef: reference } }
    );

    expect(
      await graphCodeOf(
        Promise.resolve(executeNode(JwtNode, request, context))
      )
    ).toBe("GRAPH_CREDENTIAL_SERVICE_UNAVAILABLE");
  });
});
