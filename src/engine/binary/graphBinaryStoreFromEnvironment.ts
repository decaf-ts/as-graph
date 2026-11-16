/**
 * @module as-graph/engine/binary/graphBinaryStoreFromEnvironment
 * @summary Selects and boots the backend's binary store from configuration.
 * @description The standalone backend keeps workflow binaries in an
 * integrations blob store through {@link BlobGraphBinaryStore}. The provider
 * is `GRAPH_BINARY_STORE` — `s3` (default), `minio`, `r2`, `azure-blob`,
 * `gcs`, `local` or `memory` — and each provider reads its own integrations
 * environment slice (`BLOBS__S3__BUCKET`, `BLOBS__S3__ENDPOINT`,
 * `BLOBS__S3__CREDENTIALS__ACCESS_KEY_ID`, …; `BLOBS__LOCAL__ROOT_PATH`;
 * `BLOBS__MEMORY__SOURCE_ID`), or an explicit config passed by the host. A
 * provider without a resolvable configuration fails the boot with
 * `GRAPH_BINARY_STORE_NOT_CONFIGURED` instead of silently keeping files in
 * process memory.
 *
 * Provider modules load lazily, so selecting S3 never loads the Azure or GCS
 * SDKs.
 */
import type {
  BlobProvider,
  BlobStoreService,
  BlobStoreServiceConfig,
} from "@decaf-ts/integrations/blob";
import { GraphExecutionError } from "../errors/GraphExecutionError";
import {
  BlobGraphBinaryStore,
  type BlobGraphBinaryStoreOptions,
} from "./BlobGraphBinaryStore";

/** Environment variable selecting the binary store provider. */
export const GRAPH_BINARY_STORE_ENV = "GRAPH_BINARY_STORE";

/** Environment variable: grace period (ms) before an unheld file is deleted. */
export const GRAPH_BINARY_DELETE_GRACE_ENV = "GRAPH_BINARY_DELETE_GRACE_MS";

/** Provider used when `GRAPH_BINARY_STORE` is unset. */
export const DEFAULT_GRAPH_BINARY_STORE_PROVIDER: BlobProvider = "s3";

/** Providers the backend can keep binaries in. */
export const GRAPH_BINARY_STORE_PROVIDERS: readonly BlobProvider[] = [
  "s3",
  "minio",
  "r2",
  "azure-blob",
  "gcs",
  "local",
  "memory",
];

/** Integrations environment variables each provider reads its config from. */
const PROVIDER_ENV_HINTS: Record<BlobProvider, string> = {
  s3: "BLOBS__S3__BUCKET (plus BLOBS__S3__ENDPOINT/REGION/CREDENTIALS__ACCESS_KEY_ID/CREDENTIALS__SECRET_ACCESS_KEY as needed)",
  minio: "BLOBS__MINIO__BUCKET and BLOBS__MINIO__ENDPOINT",
  r2: "BLOBS__R2__BUCKET and BLOBS__R2__ENDPOINT",
  "azure-blob": "BLOBS__AZURE__CONTAINER and BLOBS__AZURE__CONNECTION_STRING",
  gcs: "BLOBS__GCS__BUCKET",
  local: "BLOBS__LOCAL__ROOT_PATH",
  memory: "BLOBS__MEMORY__SOURCE_ID",
};

/** Constructs the (undecorated) integrations service of a provider. */
async function serviceOf(provider: BlobProvider): Promise<BlobStoreService> {
  switch (provider) {
    case "s3": {
      const { S3BlobStoreService } = await import("@decaf-ts/integrations/blob/s3");
      return new S3BlobStoreService() as unknown as BlobStoreService;
    }
    case "minio": {
      const { MinioBlobStoreService } = await import("@decaf-ts/integrations/blob/s3");
      return new MinioBlobStoreService() as unknown as BlobStoreService;
    }
    case "r2": {
      const { R2BlobStoreService } = await import("@decaf-ts/integrations/blob/s3");
      return new R2BlobStoreService() as unknown as BlobStoreService;
    }
    case "azure-blob": {
      const { AzureBlobStoreService } = await import("@decaf-ts/integrations/blob/azure");
      return new AzureBlobStoreService() as unknown as BlobStoreService;
    }
    case "gcs": {
      const { GcsBlobStoreService } = await import("@decaf-ts/integrations/blob/gcp");
      return new GcsBlobStoreService() as unknown as BlobStoreService;
    }
    case "local": {
      const { LocalBlobStoreService } = await import("@decaf-ts/integrations/blob/local");
      return new LocalBlobStoreService() as unknown as BlobStoreService;
    }
    case "memory": {
      const { MemoryBlobStoreService } = await import("@decaf-ts/integrations/blob/memory");
      return new MemoryBlobStoreService() as unknown as BlobStoreService;
    }
    default:
      throw new GraphExecutionError(
        `Unknown binary store provider '${String(provider)}'; expected one of ${GRAPH_BINARY_STORE_PROVIDERS.join(", ")}`,
        "GRAPH_BINARY_STORE_UNKNOWN_PROVIDER",
        { provider }
      );
  }
}

/**
 * Resolves the provider from `GRAPH_BINARY_STORE`.
 *
 * @param env - The environment to read (defaults to `process.env`).
 * @returns The provider, `s3` when unset.
 * @throws {GraphExecutionError} `GRAPH_BINARY_STORE_UNKNOWN_PROVIDER` for an
 * unsupported value.
 */
export function graphBinaryStoreProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): BlobProvider {
  const raw = env[GRAPH_BINARY_STORE_ENV]?.trim();
  const provider = (raw || DEFAULT_GRAPH_BINARY_STORE_PROVIDER) as BlobProvider;
  if (!GRAPH_BINARY_STORE_PROVIDERS.includes(provider)) {
    throw new GraphExecutionError(
      `Unknown binary store provider '${provider}' in ${GRAPH_BINARY_STORE_ENV}; expected one of ${GRAPH_BINARY_STORE_PROVIDERS.join(", ")}`,
      "GRAPH_BINARY_STORE_UNKNOWN_PROVIDER",
      { provider }
    );
  }
  return provider;
}

/**
 * Boots the integrations blob store of a provider and wraps it as the
 * engine's binary store.
 *
 * @param options - The provider (default: from `GRAPH_BINARY_STORE`, else
 * `s3`) and an optional explicit blob config; without one the provider reads
 * its integrations environment slice.
 * @returns The binary store.
 * @throws {GraphExecutionError} `GRAPH_BINARY_STORE_NOT_CONFIGURED` when the
 * provider has no resolvable configuration.
 */
export async function createGraphBinaryStore(
  options: {
    provider?: BlobProvider;
    config?: BlobStoreServiceConfig;
  } & BlobGraphBinaryStoreOptions = {}
): Promise<BlobGraphBinaryStore> {
  const provider = options.provider ?? graphBinaryStoreProviderFromEnv();
  const service = await serviceOf(provider);
  try {
    if (options.config) await service.boot({ ...options.config, provider });
    else await service.boot();
    void service.client;
  } catch (error) {
    throw new GraphExecutionError(
      `The '${provider}' binary store is not configured: set ${PROVIDER_ENV_HINTS[provider]}, or choose another provider with ${GRAPH_BINARY_STORE_ENV} (${GRAPH_BINARY_STORE_PROVIDERS.join(", ")}). Cause: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "GRAPH_BINARY_STORE_NOT_CONFIGURED",
      { provider }
    );
  }
  const grace = process.env[GRAPH_BINARY_DELETE_GRACE_ENV]?.trim();
  return new BlobGraphBinaryStore(service, {
    ...(options.adapter ? { adapter: options.adapter } : {}),
    deleteGraceMs:
      options.deleteGraceMs ??
      (grace && Number.isFinite(Number(grace)) ? Number(grace) : undefined),
    ...(options.downloadUrlSeconds !== undefined
      ? { downloadUrlSeconds: options.downloadUrlSeconds }
      : {}),
  });
}
