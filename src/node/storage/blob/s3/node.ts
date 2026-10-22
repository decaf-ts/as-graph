/**
 * @module as-graph/nodes/storage/blob/s3
 * @summary S3 blob storage node declarations (Stage 3a; `core.storage.s3` and `core.storage.awsS3`).
 * @description S3 and AWS S3 — blob operations against an S3-compatible
 * bucket (AWS or any endpoint-based S3 API). Both node kinds share the same
 * `S3Node` implementation and differ only in palette presentation; operations,
 * encoding, and teardown behaviour come from `BlobNode`. The credential must
 * be a JSON object carrying `accessKeyId`, optional `secretAccessKey` and
 * `sessionToken` (a missing `secretAccessKey` becomes the empty string); it
 * resolves through the ctx-bound node credential resolver and stays
 * optional only in the sense that the service may still initialize without
 * explicit credentials (e.g. instance roles) — a configured bucket is always
 * required.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node } from "../../../../shared/graph";
import { BlobNode } from "../base";
import { S3BlobStoreService } from "@decaf-ts/integrations/blob/s3";
import type { S3BlobStoreServiceConfig } from "@decaf-ts/integrations/blob";
import { GraphExecutionError } from "../../../../engine/errors/GraphExecutionError";
import { asNonEmptyString, parseCredentialJson } from "../../support";

/** Assembles the S3 service configuration: credential JSON is parsed for the access keys, everything else comes from node config. */
function s3Config(
  secret: string | Record<string, unknown> | undefined,
  options: {
    bucket: string;
    sourceId: string;
    region?: string;
    endpoint?: string;
    prefix?: string;
    forcePathStyle: boolean;
  }
): S3BlobStoreServiceConfig {
  const credentials = secret
    ? parseCredentialJson(secret, "S3")
    : undefined;
  return {
    provider: "s3",
    bucket: options.bucket,
    sourceId: options.sourceId,
    region: options.region,
    endpoint: options.endpoint,
    prefix: options.prefix,
    forcePathStyle: options.forcePathStyle,
    credentials:
      credentials && typeof credentials["accessKeyId"] === "string"
        ? {
            accessKeyId: credentials["accessKeyId"] as string,
            secretAccessKey: String(credentials["secretAccessKey"] ?? ""),
            sessionToken: asNonEmptyString(credentials["sessionToken"]),
          }
        : undefined,
  };
}

/**
 * Shared S3 implementation behind the `core.storage.s3` and `core.storage.awsS3` node kinds.
 *
 * Builds an `S3BlobStoreService` from the bucket, endpoint/region/path-style
 * config, and the parsed credential JSON.
 */
export class S3Node extends BlobNode {
  protected readonly credentialType = "s3";

  /**
   * Builds the S3 blob store service from node config and the resolved credential.
   *
   * @param credential - Resolved credential secret: a JSON object with `accessKeyId` and optional `secretAccessKey`/`sessionToken`.
   * @returns The initialized S3 blob store service.
   * @throws {GraphExecutionError} with code `GRAPH_BLOB_BUCKET_REQUIRED` when no `bucket` is configured and `GRAPH_CREDENTIAL_INVALID_FORMAT` when the credential is not a JSON object.
   */
  protected async createService(
    credential: string | Record<string, unknown> | undefined
  ): Promise<S3BlobStoreService> {
    const bucket = asNonEmptyString(this.bucket);
    if (!bucket) {
      throw new GraphExecutionError(
        "S3 node requires a bucket",
        "GRAPH_BLOB_BUCKET_REQUIRED"
      );
    }
    const service = new S3BlobStoreService();
    await service.boot(
      s3Config(credential, {
        bucket,
        sourceId: asNonEmptyString(this.sourceId) ?? "graph",
        region: asNonEmptyString(this.region),
        endpoint: asNonEmptyString(this.endpoint),
        prefix: asNonEmptyString(this.prefix),
        forcePathStyle: this.forcePathStyle,
      })
    );
    return service;
  }

  /** S3-compatible bucket to operate on. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.bucket.label",
    type: "string",
  })
  @input({ handle: "bucket", userControlled: true })
  bucket!: string;

  /** Optional logical source identifier used in result descriptors (default `graph`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.sourceId.label",
    type: "string",
  })
  @input({ handle: "sourceId", userControlled: true })
  sourceId?: string;

  /** Optional AWS region. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.region.label",
    type: "string",
  })
  @input({ handle: "region", userControlled: true })
  region?: string;

  /** Optional custom S3 API endpoint for non-AWS providers. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.endpoint.label",
    type: "string",
  })
  @input({ handle: "endpoint", userControlled: true })
  endpoint?: string;

  /** Whether to use path-style addressing (typically required for MinIO and similar). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.forcePathStyle.label",
    type: "boolean",
  })
  @input({ handle: "forcePathStyle", userControlled: true })
  forcePathStyle: boolean = false;
}

/**
 * S3 blob storage node (`core.storage.s3`): generic S3-compatible object storage.
 */
@node("core.storage.s3", {
  kind: "core.storage.s3",
  category: "Storage",
  color: "#e25444",
  icon: "ti-bucket",
  width: 96,
  height: 96,
  labels: ["storage", "s3", "blob", "aws"],
  metadata: {
    title: "graph.node.storage.s3.name",
    description: "graph.node.storage.s3.description",
  },
})
@model()
export class S3StorageNode extends S3Node {}

/**
 * AWS S3 blob storage node (`core.storage.awsS3`): AWS-branded palette variant of {@link S3StorageNode}.
 */
@node("core.storage.awsS3", {
  kind: "core.storage.awsS3",
  category: "Storage",
  color: "#ff9900",
  icon: "ti-brand-aws",
  width: 96,
  height: 96,
  labels: ["storage", "s3", "blob", "aws"],
  metadata: {
    title: "graph.node.storage.aws_s3.name",
    description: "graph.node.storage.aws_s3.description",
  },
})
@model()
export class AwsS3StorageNode extends S3Node {}
