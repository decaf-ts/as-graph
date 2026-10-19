/**
 * @module as-graph/nodes/devops/crypto
 * @summary Crypto DevOps node declaration (Stage 3a; `core.devops.crypto`).
 * @description Crypto — hashing, HMAC, symmetric encryption/decryption,
 * digital signing/verification, and key-pair generation through the Decaf
 * `CryptoService`. The payload comes from `payload` (or the `value` input) and
 * non-string payloads are JSON-encoded; a missing or unserializable payload
 * throws. Digest/signature output is `hex` or `base64` (default `hex`). The
 * `hmac`, `encrypt`, `decrypt`, `sign`, and `verify` operations resolve the
 * `crypto` credential (required) through a `GRAPH_CREDENTIAL_*` environment
 * variable — except that `sign`/`verify` prefer explicit `privateKey` /
 * `publicKey` config when present. `decrypt` additionally requires
 * `encryptedData` and the encryption `salt`. `generate` produces PEM key pairs
 * (`rsa` with `modulusLength` floored to ≥2048, `ec` with `namedCurve`
 * defaulting to `prime256v1`, or `ed25519`). An unknown `operation` silently
 * falls back to `hash`; the service is booted per execution and shut down in a
 * `finally` block.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { CryptoService } from "@decaf-ts/crypto/integration/services/crypto";
import {
  asNonEmptyString,
  resolveCredentialSecret,
} from "../../storage/support";

/** Operation the node performs. */
export type CryptoOperation =
  | "hash"
  | "hmac"
  | "encrypt"
  | "decrypt"
  | "sign"
  | "verify"
  | "generate";

/** Hash algorithms supported by the node (mapped onto Node crypto names by {@link ALGORITHMS}). */
export type CryptoAlgorithm =
  | "MD5"
  | "SHA1"
  | "SHA256"
  | "SHA384"
  | "SHA512"
  | "SHA3-256"
  | "SHA3-384"
  | "SHA3-512";

/** Encoding used for digest and signature output. */
export type CryptoEncoding = "hex" | "base64";

/** Inputs accepted by the Crypto node. */
export type CryptoNodeInput = Record<string, unknown>;

/** Outputs produced by the Crypto node. */
export interface CryptoNodeOutput {
  /** Operation result (digest, ciphertext, key pair, or verification outcome). */
  result: unknown;
  /** Encodings of the emitted result (present for `encrypt`). */
  encodings?: string[];
}

/** Maps configured algorithm names onto Node.js crypto algorithm identifiers. */
const ALGORITHMS: Record<CryptoAlgorithm, string> = {
  MD5: "md5",
  SHA1: "sha1",
  SHA256: "sha256",
  SHA384: "sha384",
  SHA512: "sha512",
  "SHA3-256": "sha3-256",
  "SHA3-384": "sha3-384",
  "SHA3-512": "sha3-512",
};

/** Supported operations; unknown configured values fall back to `hash`. */
const OPERATIONS: CryptoOperation[] = [
  "hash",
  "hmac",
  "encrypt",
  "decrypt",
  "sign",
  "verify",
  "generate",
];

/** Serializes the operation payload: strings pass through, others are JSON-encoded, nil/unserializable values throw. */
function payloadString(value: unknown, nodeName: string): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) {
    throw new GraphExecutionError(
      `${nodeName} node requires a payload`,
      "GRAPH_CRYPTO_PAYLOAD_REQUIRED"
    );
  }
  try {
    return JSON.stringify(value);
  } catch {
    throw new GraphExecutionError(
      `${nodeName} node cannot serialize the payload`,
      "GRAPH_CRYPTO_INVALID_PAYLOAD"
    );
  }
}

/**
 * Crypto node (`core.devops.crypto`): hash, HMAC, encrypt/decrypt, sign/verify,
 * and key-pair generation through the Decaf `CryptoService`.
 *
 * Credentials and key material are always resolved from the `crypto`
 * credential reference or explicit key fields — never embedded in workflow
 * documents.
 */
@node("core.devops.crypto", {
  kind: "core.devops.crypto",
  category: "DevOps",
  color: "#7c3aed",
  icon: "ti-lock",
  width: 96,
  height: 96,
  labels: ["devops", "crypto", "hash", "encrypt", "sign"],
  metadata: {
    title: "graph.node.devops.crypto.name",
    description: "graph.node.devops.crypto.description",
  },
})
@model()
export class CryptoNode extends GraphNode<CryptoNodeInput, CryptoNodeOutput> {
  /**
   * Executes the configured crypto operation.
   *
   * @param request - Execution request carrying the credential secrets; the `crypto` credential is resolved via `resolveCredentialSecret` where the operation requires it.
   * @returns Execution values with the operation `result` and, for `encrypt`, the `encodings` output (`base64`).
   * @throws {GraphExecutionError} with codes `GRAPH_CRYPTO_PAYLOAD_REQUIRED`/`GRAPH_CRYPTO_INVALID_PAYLOAD` (payload problems), `GRAPH_CREDENTIAL_MISSING` (missing secret), `GRAPH_CRYPTO_ENCRYPTED_DATA_REQUIRED`, `GRAPH_CRYPTO_SALT_REQUIRED`, `GRAPH_CRYPTO_SIGNATURE_REQUIRED` (missing per-operation inputs), or `GRAPH_CRYPTO_OPERATION_FAILED` when the service call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<CryptoNodeInput>
  ): Promise<GraphExecutionValues> {
    const nodeName = "Crypto";
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "hash";
    const algorithm = ALGORITHMS[this.algorithm] ?? ALGORITHMS.SHA256;
    const encoding = this.encoding === "base64" ? "base64" : "hex";
    const payloadOf = (): string =>
      payloadString(this.payload ?? request.inputs["value"], nodeName);
    const service = new CryptoService();
    await service.boot();
    const crypto = service.client;
    try {
      switch (operation) {
        case "hash":
          return {
            result: crypto
              .createHash(algorithm)
              .update(payloadOf())
              .digest(encoding),
          };
        case "hmac": {
          const secret = resolveCredentialSecret(
            request.credentials,
            "crypto",
            true,
            nodeName
          );
          return {
            result: crypto
              .createHmac(algorithm, secret as string)
              .update(payloadOf())
              .digest(encoding),
          };
        }
        case "encrypt": {
          const secret = resolveCredentialSecret(
            request.credentials,
            "crypto",
            true,
            nodeName
          );
          const result = await service.encrypt(payloadOf(), secret as string);
          return { result, encodings: ["base64"] };
        }
        case "decrypt": {
          const secret = resolveCredentialSecret(
            request.credentials,
            "crypto",
            true,
            nodeName
          );
          const encryptedData = asNonEmptyString(this.encryptedData);
          if (!encryptedData) {
            throw new GraphExecutionError(
              "Crypto node decrypt requires encryptedData",
              "GRAPH_CRYPTO_ENCRYPTED_DATA_REQUIRED"
            );
          }
          const salt = asNonEmptyString(this.salt);
          if (!salt) {
            throw new GraphExecutionError(
              "Crypto node decrypt requires the encryption salt",
              "GRAPH_CRYPTO_SALT_REQUIRED"
            );
          }
          return {
            result: await service.decrypt(
              encryptedData,
              secret as string,
              salt
            ),
          };
        }
        case "sign": {
          const key =
            asNonEmptyString(this.privateKey) ??
            resolveCredentialSecret(
              request.credentials,
              "crypto",
              true,
              nodeName
            );
          return {
            result: crypto
              .createSign(algorithm)
              .update(payloadOf())
              .sign(key as string, encoding),
          };
        }
        case "verify": {
          const key =
            asNonEmptyString(this.publicKey) ??
            resolveCredentialSecret(
              request.credentials,
              "crypto",
              true,
              nodeName
            );
          const signature = asNonEmptyString(this.signature);
          if (!signature) {
            throw new GraphExecutionError(
              "Crypto node verify requires a signature",
              "GRAPH_CRYPTO_SIGNATURE_REQUIRED"
            );
          }
          return {
            result: crypto
              .createVerify(algorithm)
              .update(payloadOf())
              .verify(key as string, signature, encoding),
          };
        }
        case "generate": {
          const keyType = this.keyType ?? "rsa";
          if (keyType === "ed25519") {
            const pair = crypto.generateKeyPairSync("ed25519", {
              publicKeyEncoding: { type: "spki", format: "pem" },
              privateKeyEncoding: { type: "pkcs8", format: "pem" },
            });
            return { result: pair };
          }
          if (keyType === "ec") {
            const pair = crypto.generateKeyPairSync("ec", {
              namedCurve: asNonEmptyString(this.namedCurve) ?? "prime256v1",
              publicKeyEncoding: { type: "spki", format: "pem" },
              privateKeyEncoding: { type: "pkcs8", format: "pem" },
            });
            return { result: pair };
          }
          const pair = crypto.generateKeyPairSync("rsa", {
            modulusLength: Math.max(2048, Math.floor(this.modulusLength ?? 2048)),
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
          });
          return { result: pair };
        }
        default:
          throw new GraphExecutionError(
            `Crypto node operation '${operation}' is not supported`,
            "GRAPH_CRYPTO_OPERATION_NOT_SUPPORTED",
            { operation }
          );
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `Crypto node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_CRYPTO_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Crypto operation to perform (defaults to `hash`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.crypto.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: CryptoOperation = "hash";

  /** Hash/signature algorithm (default `SHA256`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.crypto.fields.algorithm.label",
    type: "select",
  })
  @input({ handle: "algorithm", userControlled: true })
  algorithm: CryptoAlgorithm = "SHA256";

  /** Digest/signature encoding (default `hex`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.crypto.fields.encoding.label",
    type: "select",
  })
  @input({ handle: "encoding", userControlled: true })
  encoding: CryptoEncoding = "hex";

  /** Fallback payload when `payload` is unset (JSON-encoded unless a string). */
  @input({ handle: "value" })
  value?: unknown;

  /** Payload to hash/HMAC/encrypt/sign/verify; strings pass through, others are JSON-encoded. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.crypto.fields.payload.label",
    type: "textarea",
  })
  @input({ handle: "payload", userControlled: true })
  payload?: unknown;

  /** Ciphertext to decrypt (required for `decrypt`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.crypto.fields.encryptedData.label",
    type: "textarea",
  })
  @input({ handle: "encryptedData", userControlled: true })
  encryptedData?: string;

  /** Salt used when the payload was encrypted (required for `decrypt`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.crypto.fields.salt.label",
    type: "string",
  })
  @input({ handle: "salt", userControlled: true })
  salt?: string;

  /** Explicit PEM private key; preferred over the `crypto` credential for `sign`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.crypto.fields.privateKey.label",
    type: "textarea",
  })
  @input({ handle: "privateKey", userControlled: true })
  privateKey?: string;

  /** Explicit PEM public key; preferred over the `crypto` credential for `verify`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.crypto.fields.publicKey.label",
    type: "textarea",
  })
  @input({ handle: "publicKey", userControlled: true })
  publicKey?: string;

  /** Signature to check (required for `verify`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.crypto.fields.signature.label",
    type: "textarea",
  })
  @input({ handle: "signature", userControlled: true })
  signature?: string;

  /** Key type for `generate` (default `rsa`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.crypto.fields.keyType.label",
    type: "select",
  })
  @input({ handle: "keyType", userControlled: true })
  keyType: "rsa" | "ec" | "ed25519" = "rsa";

  /** RSA modulus length, floored to ≥2048. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.crypto.fields.modulusLength.label",
    type: "number",
  })
  @input({ handle: "modulusLength", userControlled: true })
  modulusLength?: number;

  /** EC named curve (default `prime256v1`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.crypto.fields.namedCurve.label",
    type: "string",
  })
  @input({ handle: "namedCurve", userControlled: true })
  namedCurve?: string;

  /** Operation result (digest, ciphertext, decrypted payload, signature, key pair, or boolean verification outcome). */
  @required()
  @output({ handle: "result" })
  result!: unknown;

  /** Encodings of the emitted result (present for `encrypt`). */
  @output({ handle: "encodings", type: "array" })
  encodings?: string[];
}
