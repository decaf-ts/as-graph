/**
 * @module as-graph/tests/integration/graph/nodes/devops/cryptoNode
 * @summary SAA-1032: real-service integration coverage for
 * `core.devops.crypto`.
 * @description Exercises the real `@decaf-ts/crypto` `CryptoService` (no
 * mocks) for hashing, HMAC, AES-GCM encryption/decryption, RSA signing and key
 * generation, plus the credential fail-closed paths.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { createHash, createHmac } from "node:crypto";
import { CryptoNode } from "../../../../../src/node/devops/crypto/node";
import {
  clearCredentials,
  credential,
  runNode,
  setCredential,
} from "../real-service-support";

jest.setTimeout(60000);

const kind = "core.devops.crypto";
const envName = "GRAPH_CREDENTIAL_SAA1032_CRYPTO";
const secret = "saa1032-crypto-secret";
const credentials = credential(envName, "crypto");

beforeAll(() => {
  setCredential(envName, secret);
});

afterAll(() => {
  clearCredentials(envName);
});

describe("core.devops.crypto (real CryptoService)", () => {
  it("hashes a payload with the requested algorithm and encoding", async () => {
    const result = await runNode(CryptoNode, kind, {
      operation: "hash",
      algorithm: "SHA256",
      payload: "hello",
    });
    expect(result.result).toBe(
      createHash("sha256").update("hello").digest("hex")
    );
  });

  it("returns base64 digests when requested", async () => {
    const result = await runNode(CryptoNode, kind, {
      operation: "hash",
      algorithm: "SHA512",
      encoding: "base64",
      payload: "hello",
    });
    expect(result.result).toBe(
      createHash("sha512").update("hello").digest("base64")
    );
  });

  it("computes an HMAC with the credential secret", async () => {
    const result = await runNode(
      CryptoNode,
      kind,
      { operation: "hmac", algorithm: "SHA256", payload: "payload" },
      {},
      credentials
    );
    expect(result.result).toBe(
      createHmac("sha256", secret).update("payload").digest("hex")
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("encrypts and decrypts a payload through the CryptoService", async () => {
    const encrypted = await runNode(
      CryptoNode,
      kind,
      { operation: "encrypt", payload: "top-secret-message" },
      {},
      credentials
    );
    const envelope = encrypted.result as {
      encryptedData: string;
      salt: string;
      iv: string;
    };
    expect(typeof envelope.encryptedData).toBe("string");
    expect(typeof envelope.salt).toBe("string");
    expect(JSON.stringify(encrypted)).not.toContain("top-secret-message");

    const decrypted = await runNode(
      CryptoNode,
      kind,
      {
        operation: "decrypt",
        encryptedData: envelope.encryptedData,
        salt: envelope.salt,
      },
      {},
      credentials
    );
    expect(decrypted.result).toBe("top-secret-message");
  });

  it("generates a real RSA key pair, signs and verifies", async () => {
    const generated = await runNode(CryptoNode, kind, {
      operation: "generate",
      keyType: "rsa",
      modulusLength: 2048,
    });
    const pair = generated.result as { publicKey: string; privateKey: string };
    expect(pair.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(pair.publicKey).toContain("BEGIN PUBLIC KEY");

    const signed = await runNode(CryptoNode, kind, {
      operation: "sign",
      algorithm: "SHA256",
      payload: "signed-payload",
      privateKey: pair.privateKey,
    });
    expect(typeof signed.result).toBe("string");

    const verified = await runNode(CryptoNode, kind, {
      operation: "verify",
      algorithm: "SHA256",
      payload: "signed-payload",
      publicKey: pair.publicKey,
      signature: signed.result,
    });
    expect(verified.result).toBe(true);

    const tampered = await runNode(CryptoNode, kind, {
      operation: "verify",
      algorithm: "SHA256",
      payload: "tampered-payload",
      publicKey: pair.publicKey,
      signature: signed.result,
    });
    expect(tampered.result).toBe(false);
  });

  it("fails closed when a required credential reference is absent", async () => {
    await expect(
      runNode(CryptoNode, kind, { operation: "hmac", payload: "payload" })
    ).rejects.toMatchObject({ graphCode: "GRAPH_CREDENTIAL_MISSING" });
  });

  it("fails closed on a type mismatch", async () => {
    await expect(
      runNode(
        CryptoNode,
        kind,
        { operation: "hmac", payload: "payload" },
        {},
        credential(envName, "jwt")
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_CREDENTIAL_TYPE_MISMATCH" });
  });

  it("fails closed on a non GRAPH_CREDENTIAL_* reference", async () => {
    await expect(
      runNode(
        CryptoNode,
        kind,
        { operation: "hmac", payload: "payload" },
        {},
        credential("NOT_A_CREDENTIAL_VARIABLE", "crypto")
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_CREDENTIAL_INVALID_REFERENCE" });
  });

  it("fails closed when the referenced variable is not configured", async () => {
    await expect(
      runNode(
        CryptoNode,
        kind,
        { operation: "hmac", payload: "payload" },
        {},
        credential("GRAPH_CREDENTIAL_SAA1032_NOT_SET", "crypto")
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_CREDENTIAL_NOT_CONFIGURED" });
  });

  it("requires decrypt data and the encryption salt", async () => {
    await expect(
      runNode(
        CryptoNode,
        kind,
        { operation: "decrypt" },
        {},
        credentials
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_CRYPTO_ENCRYPTED_DATA_REQUIRED" });
  });
});
