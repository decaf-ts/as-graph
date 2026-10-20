/**
 * @module as-graph/nodes/storage/blob/azure
 * @summary Azure Blob Storage node declaration (Stage 3a; `core.storage.azureStorage`).
 * @description Azure Storage — blob operations against an Azure Blob Storage
 * container. Operations, encoding, and teardown behaviour come from
 * `BlobNode`. The credential is an Azure storage connection string, given
 * either as the bare string or inside a JSON object under `connectionString`;
 * it resolves through the ctx-bound node credential resolver. The
 * container name is prefixed to object keys, so a configured container is
 * always required.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node } from "../../../../shared/graph";
import { BlobNode } from "../base";
import { AzureNodeService } from "@decaf-ts/integrations/blob/azure";
import type { AzureBlobStoreServiceConfig } from "@decaf-ts/integrations/blob";
import { GraphExecutionError } from "../../../../engine/errors/GraphExecutionError";
import {
  asNonEmptyString,
  parseCredentialJson,
} from "../../support";

/** Extracts the Azure connection string from the credential: a bare string passes through, JSON must carry `connectionString`. */
function azureConnectionString(secret: string | Record<string, unknown> | undefined): string | undefined {
  if (!secret) return undefined;
  if (typeof secret !== "string") {
    return asNonEmptyString(secret["connectionString"]);
  }
  const trimmed = secret.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  const parsed = parseCredentialJson(trimmed, "Azure Storage");
  return asNonEmptyString(parsed["connectionString"]);
}

/**
 * Azure Blob Storage node: object storage in an Azure container through `AzureNodeService`.
 */
/**
 * Azure Storage node; builds `AzureNodeService` from the container name and connection-string credential.
 */
@node("core.storage.azureStorage", {
  kind: "core.storage.azureStorage",
  category: "Storage",
  color: "#0078d4",
  icon: "ti-brand-azure",
  width: 96,
  height: 96,
  labels: ["storage", "azure", "blob"],
  metadata: {
    title: "graph.node.storage.azure_storage.name",
    description: "graph.node.storage.azure_storage.description",
  },
})
@model()
export class AzureStorageNode extends BlobNode {
  protected readonly credentialType = "azure-blob";

/**
   * Builds the Azure blob store service from node config and the resolved credential.
   *
   * @param credential - Resolved credential secret: a bare connection string or a JSON object with `connectionString`.
   * @returns The initialized Azure blob store service.
   * @throws {GraphExecutionError} with code `GRAPH_BLOB_CONTAINER_REQUIRED` when no `container` is configured and `GRAPH_CREDENTIAL_INVALID_FORMAT` when a JSON credential lacks `connectionString`.
   */
  protected async createService(
    credential: string | Record<string, unknown> | undefined
  ): Promise<AzureNodeService> {
    const container = asNonEmptyString(this.container);
    if (!container) {
      throw new GraphExecutionError(
        "Azure Storage node requires a container",
        "GRAPH_BLOB_CONTAINER_REQUIRED"
      );
    }
    const config: AzureBlobStoreServiceConfig = {
      provider: "azure-blob",
      container,
      sourceId: asNonEmptyString(this.sourceId) ?? "graph",
      accountName: asNonEmptyString(this.accountName),
      endpoint: asNonEmptyString(this.endpoint),
      prefix: asNonEmptyString(this.prefix),
      connectionString: azureConnectionString(credential),
    };
    const service = new AzureNodeService();
    await service.boot(config);
    return service;
  }

  /** Azure Blob Storage container to operate on (prefixed to keys). */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.container.label",
    type: "string",
  })
  @input({ handle: "container", userControlled: true })
  container!: string;

  /** Optional logical source identifier used in result descriptors (default `graph`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.sourceId.label",
    type: "string",
  })
  @input({ handle: "sourceId", userControlled: true })
  sourceId?: string;

  /** Optional storage account name. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.accountName.label",
    type: "string",
  })
  @input({ handle: "accountName", userControlled: true })
  accountName?: string;

  /** Optional custom Blob service endpoint. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.storage.common.fields.endpoint.label",
    type: "string",
  })
  @input({ handle: "endpoint", userControlled: true })
  endpoint?: string;
}
