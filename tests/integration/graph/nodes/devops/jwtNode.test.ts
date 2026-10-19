/**
 * @module as-graph/tests/integration/graph/nodes/devops/jwtNode
 * @summary SAA-1032: real-service integration coverage for `core.devops.jwt`.
 * @description Signs, decodes and verifies real JWTs through
 * `@decaf-ts/crypto/jwt`, including the wrong-secret rejection and the
 * credential fail-closed paths. No JWT implementation is mocked.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { JwtNode } from "../../../../../src/node/devops/jwt/node";
import {
  clearCredentials,
  credential,
  runNode,
  setCredential,
} from "../real-service-support";

jest.setTimeout(60000);

const kind = "core.devops.jwt";
const envName = "GRAPH_CREDENTIAL_SAA1032_JWT";
const secret = "saa1032-jwt-secret";
const credentials = credential(envName, "jwt");
const claims = { sub: "user-1", role: "admin" };

beforeAll(() => {
  setCredential(envName, secret);
});

afterAll(() => {
  clearCredentials(envName);
});

describe("core.devops.jwt (real JWT sign/verify/decode)", () => {
  it("signs claims and decodes the payload without the secret", async () => {
    const signed = await runNode(
      JwtNode,
      kind,
      { operation: "sign", claims, expiry: "1h" },
      {},
      credentials
    );
    expect(typeof signed.token).toBe("string");
    expect(signed.result).toBe(signed.token);
    expect(String(signed.token).split(".")).toHaveLength(3);
    expect(String(signed.token)).not.toContain(secret);
    expect(JSON.stringify(signed)).not.toContain(secret);

    const decoded = await runNode(JwtNode, kind, {
      operation: "decode",
      token: signed.token,
    });
    expect(decoded.payload).toMatchObject(claims);
  });

  it("verifies a token signed with the credential secret", async () => {
    const signed = await runNode(
      JwtNode,
      kind,
      { operation: "sign", claims, expiry: "1h" },
      {},
      credentials
    );
    const verified = await runNode(
      JwtNode,
      kind,
      { operation: "verify", token: signed.token },
      {},
      credentials
    );
    expect(verified.payload).toMatchObject(claims);
    expect((verified.payload as { exp: number }).exp).toBeGreaterThan(
      Math.floor(Date.now() / 1000)
    );
  });

  it("rejects a token verified with a different secret", async () => {
    const signed = await runNode(
      JwtNode,
      kind,
      { operation: "sign", claims, expiry: "1h" },
      {},
      credentials
    );
    setCredential("GRAPH_CREDENTIAL_SAA1032_JWT_WRONG", "not-the-secret");
    try {
      await expect(
        runNode(
          JwtNode,
          kind,
          { operation: "verify", token: signed.token },
          {},
          credential("GRAPH_CREDENTIAL_SAA1032_JWT_WRONG", "jwt")
        )
      ).rejects.toMatchObject({ graphCode: "GRAPH_JWT_OPERATION_FAILED" });
    } finally {
      clearCredentials("GRAPH_CREDENTIAL_SAA1032_JWT_WRONG");
    }
  });

  it("signs claims supplied through the upstream value input", async () => {
    const signed = await runNode(
      JwtNode,
      kind,
      { operation: "sign", expiry: "15m" },
      { value: { sub: "input-user" } },
      credentials
    );
    const decoded = await runNode(JwtNode, kind, {
      operation: "decode",
      token: signed.token,
    });
    expect(decoded.payload).toMatchObject({ sub: "input-user" });
  });

  it("fails closed when signing without a credential", async () => {
    await expect(
      runNode(JwtNode, kind, { operation: "sign", claims })
    ).rejects.toMatchObject({ graphCode: "GRAPH_CREDENTIAL_MISSING" });
  });

  it("fails closed when the credential type does not match", async () => {
    await expect(
      runNode(
        JwtNode,
        kind,
        { operation: "sign", claims },
        {},
        credential(envName, "crypto")
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_CREDENTIAL_TYPE_MISMATCH" });
  });

  it("requires a verification secret or verifyUrl", async () => {
    const signed = await runNode(
      JwtNode,
      kind,
      { operation: "sign", claims, expiry: "1h" },
      {},
      credentials
    );
    await expect(
      runNode(JwtNode, kind, { operation: "verify", token: signed.token })
    ).rejects.toMatchObject({ graphCode: "GRAPH_JWT_VERIFICATION_NOT_CONFIGURED" });
  });

  it("requires a token for decode", async () => {
    await expect(
      runNode(JwtNode, kind, { operation: "decode" })
    ).rejects.toMatchObject({ graphCode: "GRAPH_JWT_TOKEN_REQUIRED" });
  });
});
