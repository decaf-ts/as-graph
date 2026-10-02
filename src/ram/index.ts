/**
 * @module as-graph/ram
 * @summary Adapter-backed persistence implementations for as-graph.
 * @description Dedicated named export for the in-memory/adaptor-backed run and
 * run-event persistence implementations. These stores MUST be constructed with a
 * provided Decaf adapter (a `RamAdapter` in tests, a durable adapter such as
 * TypeORM in production); they never create an adapter implicitly.
 *
 * Stored objects:
 * - Cached/pinned graph values are persisted as {@link GraphValueModel} rows
 *   through {@link GraphValueRepository} (cache must survive restarts for pinning).
 * - Run lifecycle records are persisted as {@link GraphRunModel} rows through
 *   {@link GraphRunRepository} (durable run history).
 * - Run event envelopes are persisted as {@link GraphRunEventModel} rows through
 *   {@link GraphRunEventRepository} (SSE replay/audit); live subscribers stay
 *   in-process.
 * - Per-execution runtime values (workflow inputs, node outputs) are NOT persisted
 *   in production and remain in-process on {@link GraphValueRepository}.
 */
import { RamAdapter } from "@decaf-ts/core/ram";

export * from "../engine/store/GraphValueModel";
export * from "../engine/store/GraphValueRepository";
export * from "../engine/runs/GraphRunConverters";
export * from "./GraphRunEventModel";
export * from "./GraphRunStore";
export * from "./GraphRunEventStore";

/**
 * Creates and initializes a {@link RamAdapter} for use with the ram-backed
 * stores. Tests use this; production passes a durable adapter instead.
 *
 * @param alias - Optional adapter alias.
 * @returns The initialized {@link RamAdapter}.
 */
export async function createRamGraphAdapter(
  alias = "as-graph-ram"
): Promise<RamAdapter> {
  const adapter = new RamAdapter(undefined, alias);
  await adapter.initialize();
  return adapter;
}
