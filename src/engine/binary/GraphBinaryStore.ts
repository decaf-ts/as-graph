/**
 * @module as-graph/engine/binary/GraphBinaryStore
 * @summary Run-scoped storage for the bytes of binary workflow values.
 * @description A node hands the engine a binary payload with inline base64
 * `data`. The engine writes the bytes to a {@link GraphBinaryStore} and
 * replaces the payload, at every serialization boundary, with a
 * `GraphBinaryReference` — the same descriptor without `data`, plus the store
 * `id`. A node that needs the bytes gets the payload back, re-hydrated from
 * the store, in its `request.inputs`.
 *
 * Ids are content-addressed (`graph-binary:<sha256>`), so the same bytes
 * flowing through several nodes, loop iterations or nested runs are stored
 * once.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GRAPH_BINARY_ID_PREFIX,
  isGraphBinaryPayload,
  isGraphBinaryReference,
  type GraphBinaryDescriptor,
} from "../../shared/graph/document/GraphBinaryReference";
import { GraphExecutionError } from "../errors/GraphExecutionError";
import { assertGraphBinaryBufferable } from "./GraphBinaryAccess";

/** Storage for binary bytes, addressed by a content-derived id. */
export interface GraphBinaryStore {
  /**
   * Stores bytes on behalf of a run.
   *
   * @param runId - The run that produced the bytes.
   * @param bytes - The bytes to store.
   * @param descriptor - File name, media type and size, kept for lookups.
   * @returns The id the bytes are addressed by.
   */
  write(
    runId: string,
    bytes: Buffer,
    descriptor: GraphBinaryDescriptor
  ): Promise<string>;
  /**
   * Reads stored bytes.
   *
   * @param id - The id returned by {@link GraphBinaryStore.write}.
   * @returns The bytes, or `undefined` when the id is unknown or was evicted.
   */
  read(id: string): Promise<Buffer | undefined>;
  /**
   * Reads the descriptor recorded with stored bytes.
   *
   * @param id - The binary id.
   * @returns The descriptor, or `undefined` when the id is unknown.
   */
  describe(id: string): Promise<GraphBinaryDescriptor | undefined>;
  /**
   * Whether a run produced or received the given binary.
   *
   * @param runId - The run to check.
   * @param id - The binary id.
   * @returns `true` when the run references the id.
   */
  belongsTo(runId: string, id: string): Promise<boolean>;
  /**
   * Records that a run holds a binary another run stored (a loop body's
   * output surfacing on the parent run, a sub-workflow result).
   *
   * @param runId - The run now referencing the binary.
   * @param id - The binary id.
   */
  retain(runId: string, id: string): Promise<void>;
  /**
   * Releases every binary only the given run references (the run's holder,
   * {@link graphBinaryRunHolder}); binaries another run or a pin still holds
   * stay.
   *
   * @param runId - The run whose binaries are released.
   */
  deleteRun(runId: string): Promise<void>;
  /**
   * Records that a holder references a binary. Holders are runs
   * ({@link graphBinaryRunHolder}) and pinned values
   * ({@link graphBinaryPinHolder}); bytes are deleted only once no holder is
   * left.
   *
   * @param holder - The holder key.
   * @param id - The binary id.
   */
  hold(holder: string, id: string): Promise<void>;
  /**
   * Drops a holder from every binary it holds and deletes the bytes no holder
   * references any more.
   *
   * @param holder - The holder key.
   */
  releaseHolder(holder: string): Promise<void>;
  /**
   * Streams stored bytes without loading the whole file.
   *
   * @param id - The binary id.
   * @returns The byte stream, or `undefined` when the id is unknown.
   */
  openStream?(id: string): Promise<AsyncIterable<Uint8Array> | undefined>;
  /**
   * Stores a byte stream on behalf of a run without buffering it, hashing
   * as it goes.
   *
   * @param runId - The run that produced the bytes.
   * @param stream - The bytes.
   * @param descriptor - File name, media type and optional path.
   * @returns The id and the size of the stored bytes.
   */
  writeStream?(
    runId: string,
    stream: AsyncIterable<Uint8Array>,
    descriptor: Omit<GraphBinaryDescriptor, "byteLength">
  ): Promise<{ id: string; byteLength: number }>;
  /**
   * A short-lived URL the client downloads the bytes from directly (a signed
   * object-store URL), or `undefined` when the store cannot sign one.
   */
  downloadUrl?(
    id: string,
    options: { fileName: string; mimeType: string; inline: boolean; expiresInSeconds?: number }
  ): Promise<string | undefined>;
  /**
   * Deletes the bytes of files that have had no holder for longer than the
   * store's grace period.
   *
   * @param now - The reference time.
   * @returns The number of files deleted.
   */
  sweep?(now?: Date): Promise<number>;
}

/** Prefix of a run holder key. */
export const GRAPH_BINARY_RUN_HOLDER_PREFIX = "run:";
/** Prefix of a pinned-value holder key. */
export const GRAPH_BINARY_PIN_HOLDER_PREFIX = "pin:";

/**
 * Holder key of a run.
 *
 * @param runId - The run id.
 * @returns `run:<runId>`.
 */
export function graphBinaryRunHolder(runId: string): string {
  return `${GRAPH_BINARY_RUN_HOLDER_PREFIX}${runId}`;
}

/**
 * Holder key of a pinned value.
 *
 * @param valueKey - The serialized value key of the pin.
 * @returns `pin:<valueKey>`.
 */
export function graphBinaryPinHolder(valueKey: string): string {
  return `${GRAPH_BINARY_PIN_HOLDER_PREFIX}${valueKey}`;
}

/**
 * Collects the ids of every binary reference inside a value.
 *
 * @param value - The value to search (records and arrays are walked).
 * @param depth - Remaining recursion depth.
 * @returns The distinct binary ids, in first-seen order.
 */
export function graphBinaryIdsOf(value: unknown, depth = 12): string[] {
  const ids = new Set<string>();
  const visit = (entry: unknown, remaining: number): void => {
    if (isGraphBinaryReference(entry)) {
      ids.add(entry.id);
      return;
    }
    if (remaining <= 0 || entry === null || typeof entry !== "object") return;
    if (Buffer.isBuffer(entry) || entry instanceof Uint8Array) return;
    for (const child of Array.isArray(entry)
      ? entry
      : Object.values(entry as Record<string, unknown>)) {
      visit(child, remaining - 1);
    }
  };
  visit(value, depth);
  return [...ids];
}

/**
 * Derives the content-addressed id of a byte sequence.
 *
 * @param bytes - The bytes to address.
 * @returns `graph-binary:<sha256 hex digest>`.
 */
export function graphBinaryIdOf(bytes: Buffer): string {
  return `${GRAPH_BINARY_ID_PREFIX}${createHash("sha256")
    .update(bytes)
    .digest("hex")}`;
}

/** Default ceiling of the in-memory store: 256 MiB. */
export const GRAPH_BINARY_MEMORY_MAX_BYTES = 256 * 1024 * 1024;

interface StoredBinary {
  bytes?: Buffer;
  descriptor: GraphBinaryDescriptor;
  holders: Set<string>;
}

/**
 * Shared bookkeeping (descriptors and run ownership) for the built-in stores.
 */
abstract class TrackingGraphBinaryStore implements GraphBinaryStore {
  protected readonly entries = new Map<string, StoredBinary>();

  abstract write(
    runId: string,
    bytes: Buffer,
    descriptor: GraphBinaryDescriptor
  ): Promise<string>;

  abstract read(id: string): Promise<Buffer | undefined>;

  protected abstract release(id: string): Promise<void>;

  async describe(id: string): Promise<GraphBinaryDescriptor | undefined> {
    const entry = this.entries.get(id);
    return entry ? { ...entry.descriptor } : undefined;
  }

  async belongsTo(runId: string, id: string): Promise<boolean> {
    return (
      this.entries.get(id)?.holders.has(graphBinaryRunHolder(runId)) === true
    );
  }

  async retain(runId: string, id: string): Promise<void> {
    await this.hold(graphBinaryRunHolder(runId), id);
  }

  async deleteRun(runId: string): Promise<void> {
    await this.releaseHolder(graphBinaryRunHolder(runId));
  }

  async hold(holder: string, id: string): Promise<void> {
    this.entries.get(id)?.holders.add(holder);
  }

  async releaseHolder(holder: string): Promise<void> {
    for (const [id, entry] of [...this.entries]) {
      if (!entry.holders.delete(holder)) continue;
      if (entry.holders.size === 0) {
        this.entries.delete(id);
        await this.release(id);
      }
    }
  }

  /**
   * Records that a run references an id, creating the entry when new.
   *
   * @returns `true` when the bytes still have to be persisted.
   */
  protected track(
    runId: string,
    id: string,
    descriptor: GraphBinaryDescriptor
  ): { entry: StoredBinary; created: boolean } {
    const holder = graphBinaryRunHolder(runId);
    const existing = this.entries.get(id);
    if (existing) {
      existing.holders.add(holder);
      return { entry: existing, created: false };
    }
    const entry: StoredBinary = {
      descriptor: { ...descriptor },
      holders: new Set([holder]),
    };
    this.entries.set(id, entry);
    return { entry, created: true };
  }
}

/**
 * Process-memory binary store, bounded by a total byte budget.
 *
 * When a write would exceed the budget the oldest binaries are evicted first
 * (a binary a pinned value holds is never evicted); a reference to an evicted
 * binary resolves to `undefined` and the node that needs its bytes fails
 * closed with `GRAPH_BINARY_NOT_FOUND`. Suited to tests and single-process
 * hosts; production hosts use {@link BlobGraphBinaryStore}, which persists
 * bytes and holders through an integrations blob store.
 */
export class InMemoryGraphBinaryStore extends TrackingGraphBinaryStore {
  private totalBytes = 0;

  /**
   * @param maxBytes - Total byte budget. Defaults to
   * {@link GRAPH_BINARY_MEMORY_MAX_BYTES}.
   */
  constructor(private readonly maxBytes = GRAPH_BINARY_MEMORY_MAX_BYTES) {
    super();
  }

  async write(
    runId: string,
    bytes: Buffer,
    descriptor: GraphBinaryDescriptor
  ): Promise<string> {
    const id = graphBinaryIdOf(bytes);
    const { entry, created } = this.track(runId, id, descriptor);
    if (created || !entry.bytes) {
      this.evictFor(bytes.byteLength, id);
      entry.bytes = bytes;
      this.totalBytes += bytes.byteLength;
    }
    return id;
  }

  async read(id: string): Promise<Buffer | undefined> {
    return this.entries.get(id)?.bytes;
  }

  async openStream(id: string): Promise<AsyncIterable<Uint8Array> | undefined> {
    const bytes = this.entries.get(id)?.bytes;
    if (!bytes) return undefined;
    return (async function* () {
      yield bytes;
    })();
  }

  async writeStream(
    runId: string,
    stream: AsyncIterable<Uint8Array>,
    descriptor: Omit<GraphBinaryDescriptor, "byteLength">
  ): Promise<{ id: string; byteLength: number }> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const id = await this.write(runId, bytes, {
      ...descriptor,
      byteLength: bytes.byteLength,
    });
    return { id, byteLength: bytes.byteLength };
  }

  protected async release(): Promise<void> {
    this.totalBytes = [...this.entries.values()].reduce(
      (total, entry) => total + (entry.bytes?.byteLength ?? 0),
      0
    );
  }

  private evictFor(incoming: number, keep: string): void {
    if (this.totalBytes + incoming <= this.maxBytes) return;
    for (const [id, entry] of [...this.entries]) {
      if (id === keep || !entry.bytes) continue;
      if (
        [...entry.holders].some((holder) =>
          holder.startsWith(GRAPH_BINARY_PIN_HOLDER_PREFIX)
        )
      ) {
        continue;
      }
      this.totalBytes -= entry.bytes.byteLength;
      this.entries.delete(id);
      if (this.totalBytes + incoming <= this.maxBytes) return;
    }
  }
}

/**
 * Binary store writing each binary to one file under a base directory.
 *
 * Bytes survive the process only as long as the directory does; descriptors
 * and run ownership are tracked in memory, so the store serves the runs of the
 * process that wrote them.
 */
export class FileSystemGraphBinaryStore extends TrackingGraphBinaryStore {
  /**
   * @param directory - Directory the binaries are written to (created on
   * first write).
   */
  constructor(private readonly directory: string) {
    super();
  }

  private fileOf(id: string): string {
    return join(this.directory, id.slice(GRAPH_BINARY_ID_PREFIX.length));
  }

  async write(
    runId: string,
    bytes: Buffer,
    descriptor: GraphBinaryDescriptor
  ): Promise<string> {
    const id = graphBinaryIdOf(bytes);
    const { created } = this.track(runId, id, descriptor);
    if (created) {
      await mkdir(this.directory, { recursive: true });
      await writeFile(this.fileOf(id), bytes);
    }
    return id;
  }

  async read(id: string): Promise<Buffer | undefined> {
    if (!id.startsWith(GRAPH_BINARY_ID_PREFIX)) return undefined;
    if (!/^[0-9a-f]{64}$/.test(id.slice(GRAPH_BINARY_ID_PREFIX.length))) {
      return undefined;
    }
    try {
      return await readFile(this.fileOf(id));
    } catch {
      return undefined;
    }
  }

  protected async release(id: string): Promise<void> {
    await rm(this.fileOf(id), { force: true });
  }
}

const MAX_BINARY_WALK_DEPTH = 12;

/**
 * Moves every inline binary payload inside a value into the store.
 *
 * Records and arrays are walked; each binary payload is replaced by its
 * reference (`data` removed, `id` set). Values without binaries are returned
 * as-is (same object identity), so the common no-binary case allocates
 * nothing.
 *
 * @param value - The value to externalise (typically a node's outputs).
 * @param store - The store receiving the bytes.
 * @param runId - The run the bytes belong to.
 * @returns The value with every binary payload replaced by a reference.
 */
export async function dehydrateGraphBinaries<T>(
  value: T,
  store: GraphBinaryStore,
  runId: string
): Promise<T> {
  return (await walk(value, MAX_BINARY_WALK_DEPTH, async (entry) => {
    if (isGraphBinaryReference(entry)) {
      // Already externalised by a nested run: this run now holds it too.
      await store.retain(runId, entry.id);
      return entry;
    }
    if (!isGraphBinaryPayload(entry)) return undefined;
    const bytes = Buffer.from(entry.data, "base64");
    const descriptor: GraphBinaryDescriptor = {
      fileName: String(entry.fileName ?? "file"),
      mimeType: entry.mimeType,
      byteLength: bytes.byteLength,
      ...(typeof entry.path === "string" ? { path: entry.path } : {}),
    };
    const id = await store.write(runId, bytes, descriptor);
    const { data: _data, ...rest } = entry as unknown as Record<
      string,
      unknown
    >;
    void _data;
    return { ...rest, byteLength: bytes.byteLength, id };
  })) as T;
}

/**
 * Restores the inline bytes of every binary reference inside a value.
 *
 * The inverse of {@link dehydrateGraphBinaries}: each reference gets its
 * base64 `data` back from the store, so a node reads a binary input exactly as
 * the producing node emitted it.
 *
 * @param value - The value to hydrate (typically a node's inputs).
 * @param store - The store holding the bytes.
 * @param runId - The run reading the bytes; it is recorded as a holder.
 * @returns The value with every reference turned back into a payload.
 * @throws {GraphExecutionError} `GRAPH_BINARY_NOT_FOUND` when a referenced
 * binary is no longer in the store.
 */
export async function hydrateGraphBinaries<T>(
  value: T,
  store: GraphBinaryStore,
  runId?: string
): Promise<T> {
  return (await walk(value, MAX_BINARY_WALK_DEPTH, async (entry) => {
    if (!isGraphBinaryReference(entry)) return undefined;
    // Hydration loads the whole file: refuse files above the buffer ceiling
    // (streaming nodes receive the reference and never come here).
    assertGraphBinaryBufferable(entry);
    const bytes = await store.read(entry.id);
    if (!bytes) {
      throw new GraphExecutionError(
        `Binary '${entry.fileName}' (${entry.id}) is no longer available in the binary store`,
        "GRAPH_BINARY_NOT_FOUND",
        { id: entry.id, fileName: entry.fileName }
      );
    }
    if (runId) {
      await store.write(runId, bytes, {
        fileName: entry.fileName,
        mimeType: entry.mimeType,
        byteLength: bytes.byteLength,
        ...(entry.path ? { path: entry.path } : {}),
      });
    }
    return { ...entry, data: bytes.toString("base64") };
  })) as T;
}

async function walk(
  value: unknown,
  depth: number,
  replace: (entry: unknown) => Promise<unknown | undefined>
): Promise<unknown> {
  const replaced = await replace(value);
  if (replaced !== undefined) return replaced;
  if (depth <= 0 || value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next: unknown[] = [];
    for (const entry of value) {
      const walked = await walk(entry, depth - 1, replace);
      if (walked !== entry) changed = true;
      next.push(walked);
    }
    return changed ? next : value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const walked = await walk(entry, depth - 1, replace);
    if (walked !== entry) changed = true;
    next[key] = walked;
  }
  return changed ? next : value;
}
