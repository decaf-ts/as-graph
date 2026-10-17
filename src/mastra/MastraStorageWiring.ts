/**
 * @module as-graph/mastra/MastraStorageWiring
 * @summary Explicit Mastra storage wiring with fail-closed durability checks
 * (SAA-926 §6.2).
 * @description `MastraBackendConfig.storage` is applied to the wired Mastra
 * runtime through its `setStorage` surface and then verified back through
 * `getStorage()`: the wiring fails closed with
 * {@link GRAPH_MASTRA_STORAGE_UNWIRED} when the wired runtime is not a Mastra
 * instance or exposes no `setStorage` surface, and with
 * {@link GRAPH_MASTRA_STORAGE_DOMAIN_INMEMORY} when the resolved workflows
 * domain is absent or silently in-memory — unless the host explicitly declared
 * an `InMemoryStore`. The resolved outcome is exposed to hosts through
 * `MastraGraphExecutionBackend#storageStatus` as the acceptance seam for the
 * "storage configured and durable" check.
 */
import { InMemoryStore, WorkflowsInMemory } from "@mastra/core/storage";

import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import {
  GRAPH_MASTRA_STORAGE_DOMAIN_INMEMORY,
  GRAPH_MASTRA_STORAGE_UNWIRED,
} from "./types";

/**
 * Narrows an unknown value to a plain object record (arrays excluded). The
 * structural probe shared by the mastra storage-wiring and run-recovery
 * internals, which must work against untyped `@mastra/core` runtimes.
 *
 * @returns {boolean} `true` when the value is a non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function callMethod(
  owner: Record<string, unknown>,
  key: string,
  ...args: unknown[]
): unknown {
  const fn = owner[key];
  if (typeof fn !== "function") return undefined;
  return fn.apply(owner, args);
}

function isInMemoryWorkflowsStore(store: unknown): boolean {
  return (
    store instanceof WorkflowsInMemory ||
    (isRecord(store) && store.constructor?.name === "WorkflowsInMemory")
  );
}

function isExplicitInMemoryStorage(storage: unknown): boolean {
  return (
    storage instanceof InMemoryStore ||
    (isRecord(storage) && storage.constructor?.name === "InMemoryStore")
  );
}

/** Durability classification of the storage domains resolved on a Mastra runtime. */
export interface MastraStorageDomainStatus {
  /**
   * The workflows domain that backs suspend/resume snapshots: `durable` when
   * the resolved domain store is not an in-memory implementation, `in-memory`
   * when core silently filled a missing domain with `WorkflowsInMemory`, and
   * `absent` when no storage or no workflows domain store resolves.
   */
  workflows: "durable" | "in-memory" | "absent";
}

/** Outcome of a successful {@link wireMastraStorage} call. */
export interface MastraStorageWiringStatus {
  /** Always `true` on a returned status; wiring failures throw instead. */
  wired: boolean;
  /**
   * Whether the host explicitly declared an `InMemoryStore`, which is the only
   * accepted path to an in-memory workflows domain.
   */
  explicitInMemory: boolean;
  /** Durability classification of the resolved storage domains. */
  domains: MastraStorageDomainStatus;
}

async function resolvedStorageOf(
  runtime: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const resolved = await callMethod(runtime, "getStorage");
  return isRecord(resolved) ? resolved : undefined;
}

/**
 * Resolves the durability classification of the storage domains currently
 * wired on a Mastra runtime.
 *
 * @param runtime - The wired `Mastra` runtime (probed structurally, since the
 *   type is untyped across mastra versions).
 * @returns The {@link MastraStorageDomainStatus} for the resolved storage;
 *   `workflows: "absent"` when the runtime exposes no `getStorage` surface,
 *   resolves no storage, or the storage yields no workflows domain store.
 */
export async function resolveMastraStorageDomainStatus(
  runtime: Record<string, unknown>
): Promise<MastraStorageDomainStatus> {
  const storage = await resolvedStorageOf(runtime);
  if (!storage) return { workflows: "absent" };
  const workflows = await callMethod(storage, "getStore", "workflows");
  if (workflows === undefined || workflows === null) {
    return { workflows: "absent" };
  }
  return { workflows: isInMemoryWorkflowsStore(workflows) ? "in-memory" : "durable" };
}

/**
 * Wires the host-declared `MastraBackendConfig.storage` onto a Mastra runtime
 * and verifies it took effect durably (SAA-926 §6.2).
 *
 * The storage is applied through the runtime's `setStorage` surface, then read
 * back through `getStorage()` and classified per domain. Wiring fails closed —
 * it never falls back to implicit in-memory persistence — in three cases:
 *
 * - the wired runtime is not a Mastra instance or exposes no `setStorage`
 *   surface ({@link GRAPH_MASTRA_STORAGE_UNWIRED}): the declared storage would
 *   be silently ignored;
 * - the declared storage did not take effect, i.e. `getStorage()` resolves
 *   nothing after wiring ({@link GRAPH_MASTRA_STORAGE_UNWIRED});
 * - the resolved workflows domain is silently in-memory (a composite storage
 *   that misses the workflows domain loses suspend/resume snapshots on
 *   restart) or absent entirely ({@link GRAPH_MASTRA_STORAGE_DOMAIN_INMEMORY})
 *   — unless the host explicitly declared an `InMemoryStore`.
 *
 * @param runtime - The wired `Mastra` runtime the storage is applied to.
 * @param storage - The host-declared storage (typically a composite
 *   `@mastra/core` storage, or an explicit `InMemoryStore` for development).
 * @returns The {@link MastraStorageWiringStatus} describing what was wired;
 *   surfaced by `MastraGraphExecutionBackend#storageStatus`.
 * @throws {GraphExecutionError} with {@link GRAPH_MASTRA_STORAGE_UNWIRED} when
 *   the runtime cannot accept the declared storage or the storage did not take
 *   effect, and with {@link GRAPH_MASTRA_STORAGE_DOMAIN_INMEMORY} when the
 *   resolved workflows domain is in-memory (without an explicit
 *   `InMemoryStore`) or absent.
 */
export async function wireMastraStorage(
  runtime: unknown,
  storage: unknown
): Promise<MastraStorageWiringStatus> {
  if (!isRecord(runtime)) {
    throw new GraphExecutionError(
      "MastraBackendConfig.storage was declared but the wired runtime is not a Mastra instance: the declared storage cannot be applied",
      GRAPH_MASTRA_STORAGE_UNWIRED
    );
  }
  const setStorage = runtime["setStorage"];
  if (typeof setStorage !== "function") {
    throw new GraphExecutionError(
      "MastraBackendConfig.storage was declared but the wired runtime exposes no setStorage surface: the declared storage cannot be applied and the run would silently fall back to in-memory persistence",
      GRAPH_MASTRA_STORAGE_UNWIRED
    );
  }
  await (setStorage as (storage: unknown) => void).call(runtime, storage);
  const resolved = await resolvedStorageOf(runtime);
  if (!resolved) {
    throw new GraphExecutionError(
      "MastraBackendConfig.storage was declared but mastra.getStorage() resolved nothing after wiring: the declared storage did not take effect",
      GRAPH_MASTRA_STORAGE_UNWIRED
    );
  }
  const domains = await resolveMastraStorageDomainStatus(runtime);
  const explicitInMemory = isExplicitInMemoryStorage(storage);
  if (domains.workflows === "in-memory" && !explicitInMemory) {
    throw new GraphExecutionError(
      "The wired Mastra storage resolves an in-memory workflows domain: a composite storage that misses the workflows domain silently falls back to InMemoryDB and loses suspend/resume snapshots on restart",
      GRAPH_MASTRA_STORAGE_DOMAIN_INMEMORY
    );
  }
  if (domains.workflows === "absent") {
    throw new GraphExecutionError(
      "The wired Mastra storage resolves no workflows domain: workflow persistence would be silently skipped",
      GRAPH_MASTRA_STORAGE_DOMAIN_INMEMORY
    );
  }
  return { wired: true, explicitInMemory, domains };
}
