/**
 * @module as-graph/tests/integration/graph/nodes/devops/cryptoNode
 * @summary SAA-1032: real-service integration coverage for
 * `core.devops.crypto`.
 * @description Exercises the real `@decaf-ts/crypto` `CryptoService` (no
 * mocks) for hashing, HMAC, AES-GCM encryption/decryption, RSA signing and key
 * generation, plus the credential fail-closed paths. SAA-1062 adds SAA-1044 F4
 * coverage: signing always uses the `crypto` credential key material, an inline
 * `privateKey` parameter cannot override it, and signing fails closed without a
 * credential.
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
const envName = "it-saa1032-CRYPTO";
const secret = "saa1032-crypto-secret";
const credentials = credential(envName, "crypto");
const signEnvName = "it-saa1032-CRYPTO_SIGN";
const signCredentials = credential(signEnvName, "crypto");

beforeAll(() => {
  setCredential(envName, secret);
});

afterAll(() => {
  clearCredentials(envName, signEnvName);
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

    setCredential(signEnvName, pair.privateKey);
    const signed = await runNode(
      CryptoNode,
      kind,
      {
        operation: "sign",
        algorithm: "SHA256",
        payload: "signed-payload",
      },
      {},
      signCredentials
    );
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

  it("signs with the credential key and cannot be overridden by an inline privateKey", async () => {
    const credentialPair = (
      await runNode(CryptoNode, kind, {
        operation: "generate",
        keyType: "rsa",
        modulusLength: 2048,
      })
    ).result as { publicKey: string; privateKey: string };
    const inlinePair = (
      await runNode(CryptoNode, kind, {
        operation: "generate",
        keyType: "rsa",
        modulusLength: 2048,
      })
    ).result as { publicKey: string; privateKey: string };

    setCredential(signEnvName, credentialPair.privateKey);
    const signed = await runNode(
      CryptoNode,
      kind,
      {
        operation: "sign",
        algorithm: "SHA256",
        payload: "credential-only-payload",
        privateKey: inlinePair.privateKey,
      },
      {},
      signCredentials
    );

    const withCredentialKey = await runNode(CryptoNode, kind, {
      operation: "verify",
      algorithm: "SHA256",
      payload: "credential-only-payload",
      publicKey: credentialPair.publicKey,
      signature: signed.result,
    });
    expect(withCredentialKey.result).toBe(true);

    const withInlineKey = await runNode(CryptoNode, kind, {
      operation: "verify",
      algorithm: "SHA256",
      payload: "credential-only-payload",
      publicKey: inlinePair.publicKey,
      signature: signed.result,
    });
    expect(withInlineKey.result).toBe(false);
  });

  it("fails closed when signing without a credential, even with an inline privateKey", async () => {
    const pair = (
      await runNode(CryptoNode, kind, {
        operation: "generate",
        keyType: "ed25519",
      })
    ).result as { publicKey: string; privateKey: string };

    await expect(
      runNode(CryptoNode, kind, {
        operation: "sign",
        algorithm: "SHA256",
        payload: "no-credential",
        privateKey: pair.privateKey,
      })
    ).rejects.toMatchObject({ graphCode: "GRAPH_CREDENTIAL_MISSING" });
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

  it("fails closed when the credential reference is not registered", async () => {
    await expect(
      runNode(
        CryptoNode,
        kind,
        { operation: "hmac", payload: "payload" },
        {},
        credential("it-saa1032-not-registered", "crypto")
      )
    ).rejects.toMatchObject({ graphCode: "GRAPH_CREDENTIAL_NOT_FOUND" });
  });

  it("fails closed when the referenced credential is disabled", async () => {
    const disabled = "it-saa1032-crypto-disabled";
    setCredential(disabled, secret, { enabled: false });
    try {
      await expect(
        runNode(
          CryptoNode,
          kind,
          { operation: "hmac", payload: "payload" },
          {},
          credential(disabled, "crypto")
        )
      ).rejects.toMatchObject({ graphCode: "GRAPH_CREDENTIAL_DISABLED" });
    } finally {
      clearCredentials(disabled);
    }
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
