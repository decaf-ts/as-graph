/**
 * @module as-graph/tests/unit/graph/mastra/MastraMcpDeliveryGuard
 * @summary Unit tests for the SAA-747 Stage 2 MCP C6 delivery guard.
 * @description Pins the MCP trigger auth config projection
 * (`mastraMcpAuthConfigOf`), the token/HMAC delivery authentication, the
 * `MASTRA_*`-only credential resolution (with the in-test environment value),
 * the pending-delivery cap/pruning/release contract, and the secret-exposure
 * boundary: the exposed run server id is not the document `serverId`, and
 * serializing the guard never leaks the delivery secret.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MASTRA_MCP_DEFAULT_PENDING_CAP,
  MASTRA_MCP_DEFAULT_PENDING_TIMEOUT_MS,
  MastraMcpDeliveryGuard,
  mastraMcpAuthConfigOf,
} from "../../../../src/mastra/MastraMcpTrigger";
import { GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE } from "../../../../src/mastra/MastraEnvironment";
import { GRAPH_MASTRA_MCP_UNAVAILABLE } from "../../../../src/mastra/types";
import { McpServerTriggerNode } from "../../../../src/mastra/nodes/triggers/mcp-server/node";
import { graphNodeManifest } from "../../../../src/shared/graph";
import type { GraphNodeInstance } from "../../../../src/shared/graph/document/GraphNodeInstance";

/** The environment variable the in-test credential is published under. */
const CREDENTIAL_ENV = "MASTRA_MCP_TEST_DELIVERY_SECRET";
/** The environment variable deliberately left unset. */
const MISSING_ENV = "MASTRA_MCP_TEST_MISSING_SECRET";
/** The secret value resolved through the in-test environment. */
const SECRET = "test-delivery-secret-value";

/** Returns the graph code of a synchronously thrown `GraphExecutionError`. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { graphCode?: string }).graphCode;
  }
}

/** A minimal canonical node instance. */
function nodeInstance(
  parameters: Record<string, unknown> = {}
): GraphNodeInstance {
  return { id: "mcp", kind: "core.agent.trigger.mcp", parameters } as unknown as GraphNodeInstance;
}

/** Reads a config with a `credentialRef` object shape. */
describe("MCP C6 node surface (SAA-747 Stage 2)", () => {
  it("declares the delivery fields on the node and its i18n labels", () => {
    const manifest = graphNodeManifest(McpServerTriggerNode);

    expect(manifest.inputs.map((port) => port.id)).toEqual(
      expect.arrayContaining([
        "serverId",
        "title",
        "instructions",
        "transport",
        "authMode",
        "authCredentialRef",
        "pendingCap",
        "pendingTimeoutMs",
      ])
    );

    const i18n = JSON.parse(
      readFileSync(
        resolve(__dirname, "../../../../assets/i18n/en.json"),
        "utf8"
      )
    ) as {
      graph: {
        node: {
          agent: { mcp_trigger: { fields: Record<string, unknown> } };
        };
      };
    };
    expect(i18n.graph.node.agent.mcp_trigger.fields).toMatchObject({
      authMode: { label: "Delivery auth mode" },
      authCredentialRef: { label: "Delivery credential reference" },
      pendingCap: { label: "Pending delivery cap" },
      pendingTimeoutMs: { label: "Pending delivery timeout (ms)" },
    });
  });
});

describe("mastraMcpAuthConfigOf (SAA-747 Stage 2)", () => {
  it("defaults to token mode, the default caps and no credential reference", () => {
    expect(mastraMcpAuthConfigOf(nodeInstance())).toEqual({
      mode: "token",
      pendingCap: MASTRA_MCP_DEFAULT_PENDING_CAP,
      pendingTimeoutMs: MASTRA_MCP_DEFAULT_PENDING_TIMEOUT_MS,
    });
    expect(MASTRA_MCP_DEFAULT_PENDING_CAP).toBe(256);
    expect(MASTRA_MCP_DEFAULT_PENDING_TIMEOUT_MS).toBe(60_000);
  });

  it("reads hmac mode, a string credential reference and explicit caps", () => {
    expect(
      mastraMcpAuthConfigOf(
        nodeInstance({
          authMode: "hmac",
          authCredentialRef: " MASTRA_MCP_TEST_DELIVERY_SECRET ",
          pendingCap: 3,
          pendingTimeoutMs: 1_500,
        })
      )
    ).toEqual({
      mode: "hmac",
      credentialEnv: CREDENTIAL_ENV,
      pendingCap: 3,
      pendingTimeoutMs: 1_500,
    });
  });

  it("reads the object credential reference and ignores malformed values", () => {
    expect(
      mastraMcpAuthConfigOf(
        nodeInstance({
          authCredentialRef: { credentialId: " MASTRA_MCP_TEST_DELIVERY_SECRET " },
        })
      ).credentialEnv
    ).toBe(CREDENTIAL_ENV);

    for (const reference of [
      undefined,
      "",
      "   ",
      { credentialId: "" },
      { credentialId: "   " },
      { other: "MASTRA_MCP_TEST_DELIVERY_SECRET" },
      42,
    ]) {
      expect(
        mastraMcpAuthConfigOf(nodeInstance({ authCredentialRef: reference }))
          .credentialEnv
      ).toBeUndefined();
    }

    expect(
      mastraMcpAuthConfigOf(
        nodeInstance({ authMode: "bearer", pendingCap: 1.5, pendingTimeoutMs: -1 })
      )
    ).toMatchObject({
      mode: "token",
      pendingCap: MASTRA_MCP_DEFAULT_PENDING_CAP,
      pendingTimeoutMs: MASTRA_MCP_DEFAULT_PENDING_TIMEOUT_MS,
    });
  });
});

describe("MastraMcpDeliveryGuard (SAA-747 Stage 2)", () => {
  const originalValue = process.env[CREDENTIAL_ENV];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[CREDENTIAL_ENV];
    } else {
      process.env[CREDENTIAL_ENV] = originalValue;
    }
    delete process.env[MISSING_ENV];
  });

  function guarded(config: ConstructorParameters<typeof MastraMcpDeliveryGuard>[0] = {
    mode: "token",
  }): MastraMcpDeliveryGuard {
    process.env[CREDENTIAL_ENV] = SECRET;
    return new MastraMcpDeliveryGuard(config);
  }

  it("authenticates a token in constant time and refuses wrong/empty values", () => {
    const guard = guarded({ mode: "token", credentialEnv: CREDENTIAL_ENV });

    expect(guard.deliverySecret).toBe(SECRET);
    expect(guard.mode).toBe("token");
    expect(guard.authenticate(SECRET)).toBe(true);
    expect(guard.authenticate("wrong-secret")).toBe(false);
    expect(guard.authenticate("")).toBe(false);
    expect(guard.authenticate(undefined)).toBe(false);
    expect(guard.authenticate(42)).toBe(false);
  });

  it("builds the guard from a node authCredentialRef naming a MASTRA_* variable", () => {
    process.env[CREDENTIAL_ENV] = SECRET;
    const guard = new MastraMcpDeliveryGuard(
      mastraMcpAuthConfigOf(
        nodeInstance({
          authMode: "hmac",
          authCredentialRef: CREDENTIAL_ENV,
        })
      )
    );

    expect(guard.mode).toBe("hmac");
    expect(guard.deliverySecret).toBe(SECRET);
    expect(guard.authenticate(SECRET)).toBe(true);
    expect(guard.verify("payload", guard.sign("payload"))).toBe(true);
  });

  it("signs and verifies HMAC delivery payloads", () => {
    const guard = guarded({ mode: "hmac", credentialEnv: CREDENTIAL_ENV });
    const signature = guard.sign("delivery-payload");

    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(guard.verify("delivery-payload", signature)).toBe(true);
    expect(guard.verify("tampered-payload", signature)).toBe(false);
    expect(guard.verify("delivery-payload", "00".repeat(32))).toBe(false);
    expect(guard.verify("delivery-payload", "")).toBe(false);
    expect(guard.verify("delivery-payload", 42)).toBe(false);
    expect(guard.sign(Buffer.from("delivery-payload"))).toBe(signature);
  });

  it("resolves the credential environment name and fails closed when it is missing", () => {
    delete process.env[MISSING_ENV];

    expect(
      codeOf(
        () =>
          new MastraMcpDeliveryGuard({
            mode: "token",
            credentialEnv: MISSING_ENV,
          })
      )
    ).toBe(GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE);

    expect(
      codeOf(
        () =>
          new MastraMcpDeliveryGuard({
            mode: "token",
            credentialEnv: "PGVECTOR_PASSWORD",
          })
      )
    ).toBe(GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE);
  });

  it("refuses deliveries above the pending cap with GRAPH_MASTRA_MCP_UNAVAILABLE", () => {
    const guard = guarded({ mode: "token", pendingCap: 1 });
    const first = guard.begin();

    expect(guard.pendingCount).toBe(1);
    let error: { graphCode?: string } | undefined;
    try {
      guard.begin();
    } catch (caught) {
      error = caught as { graphCode?: string };
    }
    expect(error?.graphCode).toBe(GRAPH_MASTRA_MCP_UNAVAILABLE);

    first.release();
    expect(guard.pendingCount).toBe(0);
    const second = guard.begin();
    expect(guard.pendingCount).toBe(1);
    second.release();
  });

  it("releases a slot exactly once", () => {
    const guard = guarded();
    const pending = guard.begin();

    expect(guard.pendingCount).toBe(1);
    pending.release();
    pending.release();
    expect(guard.pendingCount).toBe(0);
  });

  it("prunes pending deliveries that exceed the timeout", async () => {
    const guard = guarded({ mode: "token", pendingTimeoutMs: 5 });
    guard.begin();
    expect(guard.pendingCount).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(guard.pendingCount).toBe(0);
    const fresh = guard.begin();
    expect(guard.pendingCount).toBe(1);
    fresh.release();
  });

  it("mints an exposed server id unrelated to the document serverId", () => {
    const first = guarded();
    const second = guarded();

    expect(first.exposedServerId).toMatch(/^mcp-[0-9a-f-]{36}$/);
    expect(first.exposedServerId).not.toBe("as-graph-gateway");
    expect(first.exposedServerId).not.toBe(second.exposedServerId);
  });

  it("never serializes the delivery secret or the exposed server id", () => {
    const guard = guarded({ mode: "hmac", credentialEnv: CREDENTIAL_ENV });
    const serialized = JSON.stringify(guard);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(guard.exposedServerId);
    expect(JSON.parse(serialized)).toEqual({
      mode: "hmac",
      pendingCap: MASTRA_MCP_DEFAULT_PENDING_CAP,
      pendingTimeoutMs: MASTRA_MCP_DEFAULT_PENDING_TIMEOUT_MS,
    });
  });
});
