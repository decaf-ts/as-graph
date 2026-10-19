/**
 * @module as-graph/nodes/devops/jwt
 * @summary JWT DevOps node declaration (Stage 3a; `core.devops.jwt`).
 * @description JWT — sign, verify, or decode a JSON Web Token. `sign`
 * requires the `jwt` credential (resolved through a `GRAPH_CREDENTIAL_*`
 * environment variable) plus `claims` (a JSON object, or the `value` input);
 * the token expires after `expiry` (default `1h`). `verify` uses the
 * `jwt` credential when present, or a `verifyUrl` for remote JWKS-style
 * verification — at least one must be configured; `clockToleranceSeconds`
 * relaxes timestamp checks. `decode` never verifies, it only parses the
 * payload. `verify` and `decode` require a token from `token` config or the
 * `value` input. An unknown `operation` silently falls back to `decode`.
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
import {
  decodeJwtPayload,
  sign,
  verify,
  type JwtOptions,
} from "@decaf-ts/crypto/jwt";
import {
  asNonEmptyString,
  asNumber,
  asRecord,
  resolveCredentialSecret,
} from "../../storage/support";

/** Operation the node performs. */
export type JwtOperation = "sign" | "verify" | "decode";

/** Inputs accepted by the JWT node. */
export type JwtNodeInput = Record<string, unknown>;

/** Outputs produced by the JWT node. */
export interface JwtNodeOutput {
  /** Operation result: the signed token (`sign`) or the decoded payload (`verify`/`decode`). */
  result: unknown;
  /** Signed token (present for `sign`). */
  token?: string;
  /** Decoded token payload (present for `verify`/`decode`). */
  payload?: unknown;
}

/** Supported operations; unknown configured values fall back to `decode`. */
const OPERATIONS: JwtOperation[] = ["sign", "verify", "decode"];

/** Normalizes the sign claims: a JSON-object string is parsed, any other non-record input throws. */
function claimsOf(value: unknown): Record<string, unknown> {
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      return asRecord(JSON.parse(value)) ?? {};
    } catch {
      throw new GraphExecutionError(
        "JWT node claims must be a JSON object",
        "GRAPH_JWT_INVALID_CLAIMS"
      );
    }
  }
  const record = asRecord(value);
  if (!record) {
    throw new GraphExecutionError(
      "JWT node sign operation requires claims",
      "GRAPH_JWT_CLAIMS_REQUIRED"
    );
  }
  return record;
}

/**
 * JWT node (`core.devops.jwt`): signs, verifies, or decodes JWTs.
 *
 * The signing secret always comes from the `jwt` credential reference — never
 * from node config — so tokens are not embedded in workflow documents.
 */
@node("core.devops.jwt", {
  kind: "core.devops.jwt",
  category: "DevOps",
  color: "#0f766e",
  icon: "ti-key",
  width: 96,
  height: 96,
  labels: ["devops", "jwt", "token", "auth"],
  metadata: {
    title: "graph.node.devops.jwt.name",
    description: "graph.node.devops.jwt.description",
  },
})
@model()
export class JwtNode extends GraphNode<JwtNodeInput, JwtNodeOutput> {
  /**
   * Executes the configured JWT operation.
   *
   * @param request - Execution request carrying the credential secrets; the `jwt` credential is resolved via `resolveCredentialSecret` (`sign` requires it, `verify` uses it or `verifyUrl`).
   * @returns Execution values: `sign` resolves to the signed token (also on `token`); `verify`/`decode` to the payload (also on `payload`).
   * @throws {GraphExecutionError} with codes `GRAPH_JWT_TOKEN_REQUIRED` (missing token), `GRAPH_JWT_CLAIMS_REQUIRED`/`GRAPH_JWT_INVALID_CLAIMS` (sign claims problems), `GRAPH_JWT_VERIFICATION_NOT_CONFIGURED` (verify without secret or `verifyUrl`), or `GRAPH_JWT_OPERATION_FAILED` when the crypto call fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<JwtNodeInput>
  ): Promise<GraphExecutionValues> {
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "decode";
    const token =
      asNonEmptyString(this.token) ??
      asNonEmptyString(request.inputs["value"]);
    if (operation !== "sign" && !token) {
      throw new GraphExecutionError(
        `JWT node operation '${operation}' requires a token`,
        "GRAPH_JWT_TOKEN_REQUIRED",
        { operation }
      );
    }
    try {
      if (operation === "sign") {
        const secret = resolveCredentialSecret(
          request.credentials,
          "jwt",
          true,
          "JWT"
        );
        const claims = claimsOf(this.claims ?? request.inputs["value"]);
        const options: JwtOptions = {
          secret: secret as string,
          expiry: asNonEmptyString(this.expiry) ?? "1h",
        };
        const signed = await sign(claims, options);
        return { result: signed, token: signed };
      }
      if (operation === "verify") {
        const secret = resolveCredentialSecret(
          request.credentials,
          "jwt",
          false,
          "JWT"
        );
        const verifyUrl = asNonEmptyString(this.verifyUrl);
        if (!secret && !verifyUrl) {
          throw new GraphExecutionError(
            "JWT node verify requires a secret credential or verifyUrl",
            "GRAPH_JWT_VERIFICATION_NOT_CONFIGURED"
          );
        }
        const payload = await verify(token as string, {
          secret,
          verifyUrl,
          clockToleranceSeconds: asNumber(this.clockToleranceSeconds),
        });
        return { result: payload, payload };
      }
      const payload = decodeJwtPayload(token as string);
      return { result: payload ?? null, payload: payload ?? null };
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `JWT node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_JWT_OPERATION_FAILED",
        { operation }
      );
    }
  }

  /** JWT operation to perform (defaults to `decode`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.jwt.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: JwtOperation = "decode";

  /** Fallback token (verify/decode) or claims (sign) input. */
  @input({ handle: "value" })
  value?: unknown;

  /** Token to verify or decode (required for non-sign operations unless `value` is set). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.jwt.fields.token.label",
    type: "textarea",
  })
  @input({ handle: "token", userControlled: true })
  token?: string;

  /** Claims object to sign (`sign` only; falls back to the `value` input). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.jwt.fields.claims.label",
    type: "object",
  })
  @input({ handle: "claims", userControlled: true })
  claims?: Record<string, unknown>;

  /** Token lifetime for `sign` (default `1h`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.jwt.fields.expiry.label",
    type: "string",
  })
  @input({ handle: "expiry", userControlled: true })
  expiry?: string;

  /** Remote verification endpoint used for `verify` when no secret credential is configured. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.jwt.fields.verifyUrl.label",
    type: "string",
  })
  @input({ handle: "verifyUrl", userControlled: true })
  verifyUrl?: string;

  /** Allowed clock skew for timestamp checks during `verify`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.devops.jwt.fields.clockToleranceSeconds.label",
    type: "number",
  })
  @input({ handle: "clockToleranceSeconds", userControlled: true })
  clockToleranceSeconds?: number;

  /** Signed token (`sign`) or decoded payload (`verify`/`decode`). */
  @required()
  @output({ handle: "result" })
  result!: unknown;

  /** Signed token (`sign` only). */
  @output({ handle: "token" })
  tokenOutput?: string;

  /** Decoded token payload (`verify`/`decode` only). */
  @output({ handle: "payload" })
  payload?: unknown;
}
