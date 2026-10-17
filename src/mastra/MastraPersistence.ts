/**
 * @module as-graph/mastra/MastraPersistence
 * @summary The approved per-layer mastra persistence routing (SAA-836 O1,
 * gate A approved 2026-10-17).
 * @description Maps each mastra-layer object kind to its best-fit storage
 * adapter, Environment-driven through `MASTRA__PERSISTENCE__*` (non-secret,
 * `.env`), with different kinds routed to different adapters by default:
 *
 * - **replays** (versioned run replay snapshots backing restore; mastra's own
 *   time-travel mechanism stays the replay engine) → `fs` adapter by default —
 *   restart-safe local snapshots with no database driver;
 * - **cache** (compiled-workflow cache ledger keyed by document id +
 *   fingerprint; invalidated atomically on fingerprint change so
 *   recompilation happens only when the document changes, never per run) →
 *   `ram` adapter by default — process-lifetime, fully rebuildable;
 * - **pins** (durable user-owned pinned node states) → `fs` adapter by
 *   default. The mastra lane itself declares pinning `NOT-SUPPORTED`
 *   (capability table), so the routed adapter is exposed for host value-store
 *   wiring only;
 * - **workflows** are NOT routed here — they persist via the as-graph adapter
 *   only (binding rule), versioned with restore.
 *
 * The built-in decaf `RamAdapter` and `FilesystemAdapter` back the defaults,
 * so no new database driver is ever required (R8): a host may override any
 * layer with its own adapter (a driver-backed PG/CouchDB adapter activates
 * only when the host configures it). Replay/cache recording is auxiliary:
 * a recording failure never fails a run (logged and skipped), while a
 * restore of a missing snapshot fails closed explicitly (nil rows never,
 * R7). No secret value is ever persisted: payloads are JSON-safe projections.
 */
import { Adapter, Repository, repository } from "@decaf-ts/core";
import { RamAdapter } from "@decaf-ts/core/ram";
import { FilesystemAdapter } from "@decaf-ts/core/fs";
import { DefaultFlavour } from "@decaf-ts/decoration";
import { Logging } from "@decaf-ts/logging";
import { model } from "@decaf-ts/decorator-validation";
import { BaseModel, column, index, pk, table } from "@decaf-ts/core";
import { NotFoundError } from "@decaf-ts/db-decorators";
import type { Logger } from "@decaf-ts/logging";

/**
 * Repairs the `Adapter.setCurrent("fs")` import side effect that the
 * `@decaf-ts/core` `./fs` subpath module runs with no adapter registered
 * (core 0.32.x): hands the current flavour back to a registered adapter, or
 * clears it entirely when none exists, so importing the mastra lane never
 * poisons the process-global current flavour.
 */
export function repairCoreFsCurrentFlavourSideEffect(): void {
  let current: string;
  try {
    current = Adapter.currentFlavour;
  } catch {
    return;
  }
  try {
    Adapter.get(current);
    return;
  } catch {
    // no adapter registered under the current flavour: the import poisoned it
  }
  for (const candidate of ["ram", "fs"]) {
    try {
      Adapter.get(candidate);
      Adapter.setCurrent(candidate);
      return;
    } catch {
      // candidate has no registered adapter
    }
  }
  const internals = Adapter as unknown as { _currentFlavour?: string };
  if ("_currentFlavour" in internals) internals._currentFlavour = undefined;
}
repairCoreFsCurrentFlavourSideEffect();
import {
  MASTRA_DEFAULT_PERSISTENCE_FS_ROOT,
  MastraEnvironment,
  type MastraPersistenceAdapterKind,
} from "./MastraEnvironment";

/**
 * Projects a run value into a JSON-safe form for persistence (no secret or
 * live instance value ever reaches a stored payload): serialisable values
 * round-trip through JSON, cycles and non-serialisable values (functions,
 * class instances that cannot survive the round-trip) degrade to a typed
 * placeholder string, matching the JSON-safe descriptor precedent of the
 * memory layer (R9).
 *
 * @param value - The runtime value to project.
 * @param depth - The current recursion depth; values nested deeper than 8
 *   levels degrade to the `[non-serializable:depth]` placeholder (callers
 *   omit it — it is threaded by the recursion).
 * @returns The JSON-safe projection.
 */
export function jsonSafeProjection(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "bigint") {
      return `[non-serializable:${typeof value}]`;
    }
    return value;
  }
  if (depth > 8) return "[non-serializable:depth]";
  const seen = jsonSafeProjectionSeen.get(value);
  if (seen !== undefined) return `[non-serializable:cycle:${seen}]`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    jsonSafeProjectionSeen.set(value, "array");
    try {
      return value.map((entry) => jsonSafeProjection(entry, depth + 1));
    } finally {
      jsonSafeProjectionSeen.delete(value);
    }
  }
  jsonSafeProjectionSeen.set(value, "object");
  try {
    const projected: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      projected[key] = jsonSafeProjection(entry, depth + 1);
    }
    return projected;
  } finally {
    jsonSafeProjectionSeen.delete(value);
  }
}
const jsonSafeProjectionSeen = new WeakMap<object, string>();

/** The mastra-layer persistence kinds the router routes. */
export type MastraPersistenceLayer = "replays" | "cache" | "pins";

/** Resolved per-layer persistence configuration (gate A approved defaults). */
export interface MastraPersistenceConfig {
  /** Adapter kind for the replay-snapshot layer. */
  replaysAdapter: MastraPersistenceAdapterKind;
  /** Adapter kind for the compiled-workflow cache layer. */
  cacheAdapter: MastraPersistenceAdapterKind;
  /** Adapter kind for the pinned-values layer. */
  pinsAdapter: MastraPersistenceAdapterKind;
  /** Base directory for the filesystem adapters' persisted data. */
  fsRoot: string;
}

/**
 * Reads the per-layer persistence routing from the accumulated mastra
 * environment (the `MASTRA__PERSISTENCE__*` overrides are already applied by
 * {@link MastraEnvironment}).
 *
 * @returns The resolved persistence configuration.
 */
export function resolveMastraPersistenceConfig(): MastraPersistenceConfig {
  const source = MastraEnvironment.mastra.persistence;
  return {
    replaysAdapter: source.replaysAdapter || "fs",
    cacheAdapter: source.cacheAdapter || "ram",
    pinsAdapter: source.pinsAdapter || "fs",
    fsRoot: source.fsRoot || MASTRA_DEFAULT_PERSISTENCE_FS_ROOT,
  };
}

/**
 * Persistable replay snapshot of a mastra run (SAA-836 O1, replays layer).
 * The `id` is `${runId}::v${version}`, so a run's snapshots are versioned and
 * restorable; the payload is a JSON-safe projection of the run outcome (the
 * live mastra run objects are never persisted).
 */
@table("mastra_replay_snapshot")
@model()
export class MastraReplaySnapshotModel extends BaseModel {
  /** Stable `${runId}::v${version}` snapshot key. */
  @pk({ type: String, generated: false })
  id!: string;

  /** The graph run the snapshot belongs to. */
  @column()
  @index()
  runId!: string;

  /** The workflow the run executed. */
  @column()
  @index()
  workflowId!: string;

  /** The document fingerprint the run executed against. */
  @column()
  documentFingerprint!: string;

  /** Monotonic per-run snapshot version (1-based). */
  @column()
  version!: number;

  /** The run's terminal status at snapshot time. */
  @column()
  status!: string;

  /** JSON-safe projection of the run outcome. */
  @column()
  payload!: Record<string, unknown>;

  /** Snapshot creation timestamp. */
  @column()
  override createdAt!: Date;

  /** Snapshot last-update timestamp. */
  @column()
  override updatedAt!: Date;

  constructor(arg?: Partial<MastraReplaySnapshotModel>) {
    super(arg);
  }
}

/**
 * Persistable compiled-workflow cache ledger entry (SAA-836 O1, cache layer).
 * Keyed `${workflowId}::${fingerprint}`; the compiled mastra artifacts
 * themselves (functions, schemas) stay in-process — the ledger makes the
 * cache layer's state inspectable and atomically invalidatable.
 */
@table("mastra_cache_entry")
@model()
export class MastraCacheEntryModel extends BaseModel {
  /** Stable `${workflowId}::${fingerprint}` cache key. */
  @pk({ type: String, generated: false })
  id!: string;

  /** The canonical workflow document id. */
  @column()
  @index()
  workflowId!: string;

  /** The document fingerprint the entry was compiled from. */
  @column()
  fingerprint!: string;

  /** When the entry was compiled. */
  @column()
  compiledAt!: Date;

  /** Entry creation timestamp. */
  @column()
  override createdAt!: Date;

  /** Entry last-update timestamp. */
  @column()
  override updatedAt!: Date;

  constructor(arg?: Partial<MastraCacheEntryModel>) {
    super(arg);
  }
}

/** Adapter-backed repository for versioned replay snapshots. */
@repository(MastraReplaySnapshotModel, DefaultFlavour)
export class MastraReplayRepository extends Repository<
  MastraReplaySnapshotModel,
  Adapter<any, any, any, any>
> {
  /**
   * Builds the replay-snapshot repository over an adapter (or the
   * flavour-registered default).
   *
   * @param adapter - The Decaf adapter backing the layer, when not resolved
   *   from the registry.
   */
  constructor(adapter?: Adapter<any, any, any, any>) {
    super(adapter, MastraReplaySnapshotModel, true);
  }

  /**
   * Records a new versioned snapshot for a run (1-based monotonic per-run
   * version).
   *
   * @param entry - The snapshot content (without id/version).
   * @returns The recorded version.
   */
  async record(entry: {
    runId: string;
    workflowId: string;
    documentFingerprint: string;
    status: string;
    payload: Record<string, unknown>;
  }): Promise<number> {
    const existing = await this.versions(entry.runId);
    const version = (existing.length > 0 ? Math.max(...existing) : 0) + 1;
    const now = new Date();
    await this.create(
      new MastraReplaySnapshotModel({
        id: `${entry.runId}::v${version}`,
        runId: entry.runId,
        workflowId: entry.workflowId,
        documentFingerprint: entry.documentFingerprint,
        version,
        status: entry.status,
        payload: entry.payload,
        createdAt: now,
        updatedAt: now,
      })
    );
    return version;
  }

  /**
   * Lists the snapshot versions recorded for a run, ascending.
   *
   * @param runId - The run to list.
   * @returns The recorded versions.
   */
  async versions(runId: string): Promise<number[]> {
    const models = (await this.select().execute()) as MastraReplaySnapshotModel[];
    return models
      .filter((candidate) => candidate.runId === runId)
      .map((candidate) => candidate.version)
      .sort((a, b) => a - b);
  }

  /**
   * Restores a run's replay snapshot: the requested version, or the latest
   * recorded version when none is given. Fails closed when the run has no
   * snapshot (nil rows never, R7).
   *
   * @param runId - The run to restore.
   * @param version - The specific version, when given.
   * @returns The restored snapshot.
   * @throws {NotFoundError} when no snapshot exists for the run/version.
   */
  async restore(runId: string, version?: number): Promise<MastraReplaySnapshotModel> {
    const models = (await this.select().execute()) as MastraReplaySnapshotModel[];
    const matches = models
      .filter((candidate) => candidate.runId === runId)
      .sort((a, b) => a.version - b.version);
    const restored =
      version === undefined
        ? matches[matches.length - 1]
        : matches.find((candidate) => candidate.version === version);
    if (!restored) {
      throw new NotFoundError(
        version === undefined
          ? `No replay snapshot is recorded for run '${runId}'`
          : `No replay snapshot v${version} is recorded for run '${runId}'`
      );
    }
    return restored;
  }
}

/**
 * Creates a fresh {@link MastraReplayRepository} bound to the provided
 * adapter, resolving the `@repository`-registered constructor (the
 * decoration replaces the constructor with an injectable factory, so a direct
 * `new` would drop the adapter — same pattern as the graph value store).
 *
 * @param adapter - The Decaf adapter backing the replay layer.
 * @returns A repository instance bound to the adapter.
 */
export function createMastraReplayRepository(
  adapter: Adapter<any, any, any, any>
): MastraReplayRepository {
  const Registered = Repository.forModel(
    MastraReplaySnapshotModel,
    adapter.alias
  ).constructor as new (
    adapter: Adapter<any, any, any, any>
  ) => MastraReplayRepository;
  return new Registered(adapter);
}

/** Adapter-backed repository for the compiled-workflow cache ledger. */
@repository(MastraCacheEntryModel, DefaultFlavour)
export class MastraCacheRepository extends Repository<
  MastraCacheEntryModel,
  Adapter<any, any, any, any>
> {
  /**
   * Builds the cache-ledger repository over an adapter (or the
   * flavour-registered default).
   *
   * @param adapter - The Decaf adapter backing the layer, when not resolved
   *   from the registry.
   */
  constructor(adapter?: Adapter<any, any, any, any>) {
    super(adapter, MastraCacheEntryModel, true);
  }

  /**
   * Records (or refreshes) the cache ledger entry for a compilation.
   *
   * @param workflowId - The canonical workflow document id.
   * @param fingerprint - The document fingerprint it was compiled from.
   */
  async record(workflowId: string, fingerprint: string): Promise<void> {
    const id = `${workflowId}::${fingerprint}`;
    const now = new Date();
    let existing: MastraCacheEntryModel | undefined;
    try {
      existing = (await this.read(id)) as MastraCacheEntryModel;
    } catch {
      existing = undefined;
    }
    if (existing) {
      existing.compiledAt = now;
      existing.updatedAt = now;
      await this.update(existing);
      return;
    }
    await this.create(
      new MastraCacheEntryModel({
        id,
        workflowId,
        fingerprint,
        compiledAt: now,
        createdAt: now,
        updatedAt: now,
      })
    );
  }

  /**
   * Invalidates every cache ledger entry for a workflow compiled from a
   * different fingerprint than the one given — the atomic counterpart of a
   * recompilation on document change.
   *
   * @param workflowId - The canonical workflow document id.
   * @param keepFingerprint - The fingerprint to keep.
   */
  async invalidate(workflowId: string, keepFingerprint: string): Promise<void> {
    const models = (await this.select().execute()) as MastraCacheEntryModel[];
    for (const candidate of models) {
      if (
        candidate.workflowId === workflowId &&
        candidate.fingerprint !== keepFingerprint
      ) {
        try {
          await this.delete(candidate.id);
        } catch {
          // deleting an already-gone entry is a no-op
        }
      }
    }
  }
}

/**
 * Creates a fresh {@link MastraCacheRepository} bound to the provided
 * adapter (same pattern as {@link createMastraReplayRepository}).
 *
 * @param adapter - The Decaf adapter backing the cache layer.
 * @returns A repository instance bound to the adapter.
 */
export function createMastraCacheRepository(
  adapter: Adapter<any, any, any, any>
): MastraCacheRepository {
  const Registered = Repository.forModel(
    MastraCacheEntryModel,
    adapter.alias
  ).constructor as new (
    adapter: Adapter<any, any, any, any>
  ) => MastraCacheRepository;
  return new Registered(adapter);
}

/** Host-supplied adapter overrides for individual layers (R8 on-demand). */
export type MastraPersistenceAdapterOverrides = Partial<
  Record<MastraPersistenceLayer, Adapter<any, any, any, any>>
>;

/** The routed per-layer persistence surface. */
export interface MastraPersistence {
  /** The resolved routing configuration. */
  config: MastraPersistenceConfig;
  /** The adapter backing each layer. */
  adapters: Record<MastraPersistenceLayer, Adapter<any, any, any, any>>;
  /** The versioned replay-snapshot store (replays layer). */
  replays: MastraReplayRepository;
  /** The compiled-workflow cache ledger (cache layer). */
  cache: MastraCacheRepository;
  /** Shuts the routed adapters down (owned adapters only). */
  shutdown(): Promise<void>;
}

/**
 * Builds the per-layer persistence routing: one adapter per layer from the
 * Environment-resolved configuration (`ram`/`fs`), with host-supplied adapter
 * overrides taking precedence (R8 on-demand driver adapters). Adapters are
 * initialized eagerly; a layer whose adapter fails to initialize fails the
 * construction — hosts route that layer to `ram` or supply their own adapter.
 *
 * @param overrides - Host-supplied per-layer adapter overrides.
 * @param logger - Optional logger for construction diagnostics.
 * @returns The routed persistence surface.
 */
export async function createMastraPersistence(
  overrides?: MastraPersistenceAdapterOverrides,
  logger?: Logger
): Promise<MastraPersistence> {
  const log = logger ?? Logging.for("MastraPersistence");
  const config = resolveMastraPersistenceConfig();
  // Routing must not silently change the process-global current flavour: an
  // owned adapter's constructor claims it when no flavour is set, so capture
  // the pre-routing state and restore it after construction.
  let flavourBefore: string | undefined;
  try {
    flavourBefore = Adapter.currentFlavour;
  } catch {
    flavourBefore = undefined;
  }
  const kinds: Record<MastraPersistenceLayer, MastraPersistenceAdapterKind> = {
    replays: config.replaysAdapter,
    cache: config.cacheAdapter,
    pins: config.pinsAdapter,
  };
  const adapters = {} as Record<MastraPersistenceLayer, Adapter<any, any, any, any>>;
  const owned: Adapter<any, any, any, any>[] = [];
  for (const layer of ["replays", "cache", "pins"] as const) {
    const override = overrides?.[layer];
    if (override) {
      adapters[layer] = override;
      continue;
    }
    const kind = kinds[layer];
    const alias = `mastra-${layer}-persistence`;
    const user = { user: "as-graph-mastra" };
    // Decaf adapters register in a process-global cache under both their alias
    // and their flavour, and a second construction under the same key throws —
    // so a kind whose flavour is already registered reuses that adapter (the
    // decaf-idiomatic singleton) instead of colliding with, for example, the
    // Nest module's default RamAdapter (or vice versa).
    const flavour = kind === "fs" ? "fs" : kind === "ram" ? "ram" : undefined;
    if (flavour) {
      let existing: Adapter<any, any, any, any> | undefined;
      try {
        existing = Adapter.get(flavour);
      } catch {
        existing = undefined;
      }
      if (existing) {
        adapters[layer] = existing;
        continue;
      }
    }
    if (kind === "fs") {
      const adapter = new FilesystemAdapter(
        { ...user, rootDir: config.fsRoot },
        `${alias}-fs`
      );
      await adapter.initialize();
      adapters[layer] = adapter;
      owned.push(adapter);
      continue;
    }
    if (kind === "ram") {
      const adapter = new RamAdapter(user, `${alias}-ram`);
      await adapter.initialize();
      adapters[layer] = adapter;
      owned.push(adapter);
      continue;
    }
    throw new Error(
      `The ${layer} persistence layer is configured with the 'host' adapter kind but no host adapter was supplied (pass overrides.${layer})`
    );
  }
  let flavourAfter: string | undefined;
  try {
    flavourAfter = Adapter.currentFlavour;
  } catch {
    flavourAfter = undefined;
  }
  if (flavourAfter !== flavourBefore) {
    if (flavourBefore) Adapter.setCurrent(flavourBefore);
    else {
      const internals = Adapter as unknown as { _currentFlavour?: string };
      if ("_currentFlavour" in internals) internals._currentFlavour = undefined;
    }
  }
  for (const layer of ["replays", "cache", "pins"] as const) {
    log.for({ layer, adapter: adapters[layer].alias }).debug(
      `[mastra-persistence] layer routed`
    );
  }
  return {
    config,
    adapters,
    replays: createMastraReplayRepository(adapters.replays),
    cache: createMastraCacheRepository(adapters.cache),
    shutdown: async () => {
      for (const adapter of owned) {
        await adapter.shutdown();
      }
    },
  };
}
