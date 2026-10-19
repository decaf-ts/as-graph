/**
 * @module as-graph/nodes/storage/blob/base
 * @summary Shared behaviour for the blob storage node kinds (s3, googleCloudStorage, azureStorage).
 * @description `BlobNode` is the single implementation behind the three Stage
 * 3a blob storage node kinds: each leaf fixes which blob store service is
 * built from the resolved credential, and this base class owns the rest. Eight
 * operations are supported (`put`, `get`, `delete`, `list`, `stat`, `has`,
 * `url`, `copy`) against a shared `key`/`destination`/`prefix` vocabulary;
 * object contents flow through the `data` config or the `value` input and are
 * encoded either as UTF-8 text or Base64 (`BlobEncoding`). Credentials are
 * mandatory and resolve through `GRAPH_CREDENTIAL_*` environment variables;
 * leaves parse them into their provider-specific service configuration. The
 * built service is always shut down in `finally` so no store state survives
 * the run, and every failure is surfaced as a
 * `GraphExecutionError` carrying the operation and error code.
 */
import { required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import type { BlobStoreService } from "@decaf-ts/integrations/blob";
import { collectToBuffer } from "@decaf-ts/integrations/blob";
import { input, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import {
  asNonEmptyString,
  asNumber,
  asRecord,
  resolveCredentialSecret,
} from "../support";

/** Blob operations the node can run. */
export type BlobOperation =
  | "put"
  | "get"
  | "delete"
  | "list"
  | "stat"
  | "has"
  | "url"
  | "copy";

/** How object contents are encoded when put or emitted when read. */
export type BlobEncoding = "utf8" | "base64";

/** Inputs accepted by the blob storage nodes (the optional `value` input supplies the written content). */
export type BlobNodeInput = Record<string, unknown>;

/** Outputs produced by the blob storage nodes: the operation result plus, for `get`, the decoded contents. */
export interface BlobNodeOutput {
  result: unknown;
  value?: string;
  contentLength?: number;
  contentType?: string;
}

/** All supported blob operations, used to validate the configured operation. */
const OPERATIONS: BlobOperation[] = [
  "put",
  "get",
  "delete",
  "list",
  "stat",
  "has",
  "url",
  "copy",
];

/** Encodes the payload to bytes: strings honor the encoding, binary views pass through, null/undefined become empty, anything else is JSON-encoded. */
function encodeBlobValue(
  value: unknown,
  encoding: BlobEncoding,
  nodeName: string
): Uint8Array {
  if (typeof value === "string") {
    return encoding === "base64"
      ? Buffer.from(value, "base64")
      : Buffer.from(value, "utf8");
  }
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength
    );
  }
  if (value === undefined || value === null) {
    return Buffer.alloc(0);
  }
  try {
    return Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    throw new GraphExecutionError(
      `${nodeName} node cannot encode the blob payload`,
      "GRAPH_BLOB_INVALID_PAYLOAD"
    );
  }
}

/**
 * Base class for the blob storage node kinds (s3, googleCloudStorage, azureStorage).
 *
 * Leaf subclasses fix {@link BlobNode.credentialType} and implement
 * {@link BlobNode.createService}; operation dispatch, encoding, and teardown
 * live here.
 */
export abstract class BlobNode extends GraphNode<
  BlobNodeInput,
  BlobNodeOutput
> {
  /** Credential type accepted by this node's credential reference. */
  protected abstract readonly credentialType: string;

/**
   * Builds the provider-specific blob store service from the resolved credential secret.
   *
   * @param credential - The resolved credential secret (connection string, JSON config, or service-account JSON), or `undefined` when no credential reference resolved.
   * @returns The configured blob store service.
   * @throws {GraphExecutionError} with code `GRAPH_CREDENTIAL_INVALID_FORMAT` when the credential is required but missing or unparseable.
   */
  protected abstract createService(
    credential: string | undefined
  ): Promise<BlobStoreService>;

/**
   * Validates the operation and key, builds the service, dispatches the operation, and always shuts the service down.
   *
   * The `put` payload comes from `content` or the `value` input; `get` emits the decoded `value`, `contentLength`,
   * and `contentType` alongside the object descriptor. `list` supports `prefix`/`limit`/`cursor`; `url` supports
   * `urlOperation` and `expiresInSeconds`. The service is shut down in `finally`, so no store state survives a failed run.
   *
   * @param request - The execution request carrying resolved credentials and the optional `value` input.
   * @returns The operation result under `result` (plus `value`, `contentLength`, `contentType` for `get`).
   * @throws {GraphExecutionError} with code `GRAPH_BLOB_KEY_REQUIRED` when the operation needs a key and none is configured, `GRAPH_BLOB_TARGET_KEY_REQUIRED` when `copy` lacks `targetKey`, `GRAPH_BLOB_INVALID_PAYLOAD` when the payload cannot be encoded, `GRAPH_BLOB_OPERATION_NOT_SUPPORTED` for unknown operations, `GRAPH_CREDENTIAL_*` codes from credential resolution, and `GRAPH_BLOB_OPERATION_FAILED` when the provider operation fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<BlobNodeInput>
  ): Promise<GraphExecutionValues> {
    const nodeName = this.constructor.name;
    const operation = OPERATIONS.includes(this.operation)
      ? this.operation
      : "get";
    const key = asNonEmptyString(this.key);
    if (operation !== "list" && !key) {
      throw new GraphExecutionError(
        `${nodeName} node operation '${operation}' requires a key`,
        "GRAPH_BLOB_KEY_REQUIRED",
        { operation }
      );
    }
    const credential = resolveCredentialSecret(
      request.credentials,
      this.credentialType,
      false,
      nodeName
    );
    const service = await this.createService(credential);
    try {
      switch (operation) {
        case "put": {
          const payload =
            this.content ?? request.inputs["value"];
          const metadata = asRecord(this.metadataValues);
          const result = await service.put(
            key as string,
            encodeBlobValue(payload, this.encoding, nodeName),
            {
              contentType: asNonEmptyString(this.contentType),
              metadata: metadata
                ? Object.fromEntries(
                    Object.entries(metadata).map(([name, entry]) => [
                      name,
                      String(entry),
                    ])
                  )
                : undefined,
            }
          );
          return { result };
        }
        case "get": {
          const result = await service.get(key as string);
          const buffer = await collectToBuffer(result.value);
          const value =
            this.encoding === "base64"
              ? buffer.toString("base64")
              : buffer.toString("utf8");
          return {
            result: {
              key: result.key,
              uri: result.uri,
              provider: result.provider,
              sourceId: result.sourceId,
              metadata: result.metadata,
            },
            value,
            contentLength: buffer.length,
            contentType: result.metadata.contentType,
          };
        }
        case "delete":
          await service.delete(key as string);
          return { result: { key, deleted: true } };
        case "list": {
          const limit = asNumber(this.limit);
          const result = await service.list({
            prefix: asNonEmptyString(this.prefix),
            limit: limit === undefined ? undefined : Math.max(0, Math.floor(limit)),
            cursor: asNonEmptyString(this.cursor),
          });
          return { result };
        }
        case "stat":
          return { result: await service.stat(key as string) };
        case "has":
          return { result: await service.has(key as string) };
        case "url": {
          const expires = asNumber(this.expiresInSeconds);
          return {
            result: await service.url(key as string, {
              operation: this.urlOperation,
              expiresInSeconds:
                expires === undefined ? undefined : Math.max(0, Math.floor(expires)),
              contentType: asNonEmptyString(this.contentType),
            }),
          };
        }
        case "copy": {
          const target = asNonEmptyString(this.targetKey);
          if (!target) {
            throw new GraphExecutionError(
              `${nodeName} node copy operation requires a targetKey`,
              "GRAPH_BLOB_TARGET_KEY_REQUIRED"
            );
          }
          return {
            result: await service.copy(key as string, target, {
              contentType: asNonEmptyString(this.contentType),
            }),
          };
        }
        default:
          throw new GraphExecutionError(
            `${nodeName} node operation '${operation}' is not supported`,
            "GRAPH_BLOB_OPERATION_NOT_SUPPORTED",
            { operation }
          );
      }
    } catch (error) {
      if (error instanceof GraphExecutionError) throw error;
      throw new GraphExecutionError(
        `${nodeName} node operation '${operation}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_BLOB_OPERATION_FAILED",
        { operation }
      );
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  }

  /** Operation to run (defaults to `get`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: BlobOperation = "get";

  /** Object key the operation targets. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.key.label",
    type: "string",
  })
  @input({ handle: "key", userControlled: true })
  key?: string;

  /** Destination key for the `copy` operation. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.targetKey.label",
    type: "string",
  })
  @input({ handle: "targetKey", userControlled: true })
  targetKey?: string;

  /** Payload written by `put` (falls back to the `value` input). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.content.label",
    type: "textarea",
  })
  @input({ handle: "content", userControlled: true })
  content?: unknown;

  /** Optional content type for `put`, `url`, and `copy`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.contentType.label",
    type: "string",
  })
  @input({ handle: "contentType", userControlled: true })
  contentType?: string;

  /** How string payloads are decoded on write and object contents are emitted on read (defaults to `utf8`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.encoding.label",
    type: "select",
  })
  @input({ handle: "encoding", userControlled: true })
  encoding: BlobEncoding = "utf8";

  /** Optional object metadata applied by `put` (entries are stringified). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.metadataValues.label",
    type: "object",
  })
  @input({ handle: "metadataValues", userControlled: true })
  metadataValues?: Record<string, string>;

  /** Optional key prefix filtering `list`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.prefix.label",
    type: "string",
  })
  @input({ handle: "prefix", userControlled: true })
  prefix?: string;

  /** Optional continuation cursor for `list`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.cursor.label",
    type: "string",
  })
  @input({ handle: "cursor", userControlled: true })
  cursor?: string;

  /** Optional maximum number of entries returned by `list` (floored, negatives clamp to 0). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.limit.label",
    type: "number",
  })
  @input({ handle: "limit", userControlled: true })
  limit?: number;

  /** Signed-URL operation for the `url` operation (defaults to `get`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.urlOperation.label",
    type: "select",
  })
  @input({ handle: "urlOperation", userControlled: true })
  urlOperation: "get" | "put" = "get";

  /** Optional signed-URL expiry for the `url` operation (floored, negatives clamp to 0). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.expiresInSeconds.label",
    type: "number",
  })
  @input({ handle: "expiresInSeconds", userControlled: true })
  expiresInSeconds?: number;

  /** Optional `value` input rows used as the `put` payload when `content` is unset. */
  @input({ handle: "value" })
  value?: unknown;

  /** Operation result (provider-dependent descriptor, listing, stat, boolean, or URL). */
  @required()
  @output({ handle: "result" })
  result!: unknown;

  /** Decoded object contents emitted by `get` under the `value` handle. */
  @output({ handle: "value" })
  valueOutput?: string;

  /** Byte length of the fetched contents emitted by `get`. */
  @output({ handle: "contentLength", type: "number" })
  contentLength?: number;

  /** Content type from the object metadata emitted by `get`. */
  @output({ handle: "contentType" })
  contentTypeOutput?: string;
}
