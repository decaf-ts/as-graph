/**
 * @module as-graph/nodes/storage/blob/gcs
 * @summary Google Cloud Storage blob node declaration (Stage 3a; `core.storage.googleCloudStorage`).
 * @description Google Cloud Storage — blob operations against a GCS bucket.
 * Operations, encoding, and teardown behaviour come from `BlobNode`. The
 * credential must be a Google service-account JSON object; it resolves through
 * the ctx-bound node credential resolver and is optional only when the
 * environment already provides default credentials — a configured bucket is
 * always required.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node } from "../../../../shared/graph";
import { BlobNode } from "../base";
import { GcsNodeService } from "@decaf-ts/integrations/blob/gcp";
import type { GcsBlobStoreServiceConfig } from "@decaf-ts/integrations/blob";
import { GraphExecutionError } from "../../../../engine/errors/GraphExecutionError";
import { asNonEmptyString, parseCredentialJson } from "../../support";

/**
 * Google Cloud Storage blob node: object storage in a GCS bucket through `GcsNodeService`.
 */
/**
 * Google Cloud Storage node; builds `GcsNodeService` from the bucket, project, and service-account credential.
 */
@node("core.storage.googleCloudStorage", {
  kind: "core.storage.googleCloudStorage",
  category: "Storage",
  color: "#4285f4",
  icon: "ti-brand-google-cloud",
  width: 96,
  height: 96,
  labels: ["storage", "gcs", "blob", "google"],
  metadata: {
    title: "graph.node.storage.google_cloud_storage.name",
    description: "graph.node.storage.google_cloud_storage.description",
  },
})
@model()
export class GoogleCloudStorageNode extends BlobNode {
  protected readonly credentialType = "gcs";

  /**
   * Builds the GCS blob store service from node config and the resolved credential.
   *
   * @param credential - Resolved credential secret: a Google service-account JSON object.
   * @returns The initialized GCS blob store service.
   * @throws {GraphExecutionError} with code `GRAPH_BLOB_BUCKET_REQUIRED` when no `bucket` is configured and `GRAPH_CREDENTIAL_INVALID_FORMAT` when the credential is not a JSON object.
   */
  protected async createService(
    credential: string | Record<string, unknown> | undefined
  ): Promise<GcsNodeService> {
    const bucket = asNonEmptyString(this.bucket);
    if (!bucket) {
      throw new GraphExecutionError(
        "Google Cloud Storage node requires a bucket",
        "GRAPH_BLOB_BUCKET_REQUIRED"
      );
    }
    const config: GcsBlobStoreServiceConfig = {
      provider: "gcs",
      bucket,
      sourceId: asNonEmptyString(this.sourceId) ?? "graph",
      projectId: asNonEmptyString(this.projectId),
      apiEndpoint: asNonEmptyString(this.apiEndpoint),
      prefix: asNonEmptyString(this.prefix),
      credentials: credential
        ? parseCredentialJson(credential, "Google Cloud Storage")
        : undefined,
    };
    const service = new GcsNodeService();
    await service.boot(config);
    return service;
  }

  /** GCS bucket to operate on. */
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

  /** Optional Google Cloud project ID. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.projectId.label",
    type: "string",
  })
  @input({ handle: "projectId", userControlled: true })
  projectId?: string;

  /** Optional custom API endpoint (e.g. the fake-gcs-server test endpoint). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.apiEndpoint.label",
    type: "string",
  })
  @input({ handle: "apiEndpoint", userControlled: true })
  apiEndpoint?: string;
}
