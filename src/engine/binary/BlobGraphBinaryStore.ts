/**
 * @module as-graph/engine/binary/BlobGraphBinaryStore
 * @summary Durable, shareable binary store: bytes in an integrations blob
 * store, descriptors and holders in the binary index tables.
 * @description
 * - **Bytes** live at `bytes/<sha256>` in any `@decaf-ts/integrations`
 *   {@link BlobStoreService} (S3, MinIO, R2, Azure Blob, GCS, local disk,
 *   memory) — chosen by configuration, shared by every backend process,
 *   surviving restarts.
 * - **Descriptors and holders** live in `graph_binary` / `graph_binary_holder`
 *   ({@link GraphBinaryModel}, {@link GraphBinaryHolderModel}) through the
 *   Decaf adapter (the host's, or `Adapter.current`): holding and releasing
 *   are row writes, and a descriptor lookup never reaches the blob store.
 * - **Deletion** is deferred: releasing a file's last holder only marks it
 *   (`deletePendingAt`); {@link BlobGraphBinaryStore.sweep} deletes the bytes
 *   once the grace period passed and the file is still unheld. A writer that
 *   holds the file again within the grace period keeps it, which closes the
 *   release/write race. A grace of `0` deletes immediately on release.
 * - **Streaming**: {@link BlobGraphBinaryStore.writeStream} uploads to a
 *   temporary key while hashing, then copies to `bytes/<sha256>`;
 *   {@link BlobGraphBinaryStore.openStream} streams back. Downloads use a
 *   short-lived signed URL when the provider can sign one.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  Adapter,
  Condition,
  OrderDirection,
  Repository,
  type Repo,
} from "@decaf-ts/core";
import type { BlobStoreService } from "@decaf-ts/integrations/blob";
import {
  GRAPH_BINARY_ID_PREFIX,
  type GraphBinaryDescriptor,
} from "../../shared/graph/document/GraphBinaryReference";
import {
  graphBinaryIdOf,
  graphBinaryRunHolder,
  type GraphBinaryStore,
} from "./GraphBinaryStore";
import {
  GraphBinaryHolderModel,
  GraphBinaryModel,
  graphBinaryHolderId,
  graphBinaryRowId,
} from "./GraphBinaryModels";

/** Default grace period between a file's last release and its deletion. */
export const DEFAULT_GRAPH_BINARY_DELETE_GRACE_MS = 60 * 60 * 1000;
/** Rows handled per query batch. */
const BATCH = 500;

/** Options of {@link BlobGraphBinaryStore}. */
export interface BlobGraphBinaryStoreOptions {
  /** Adapter of the index tables; defaults to `Adapter.current` at first use. */
  adapter?: Adapter<any, any, any, any>;
  /** Grace period before an unheld file's bytes are deleted (`0`: immediately). */
  deleteGraceMs?: number;
  /** Lifetime of signed download URLs, in seconds (default 300). */
  downloadUrlSeconds?: number;
  /**
   * Index scope of this store's rows (default `<provider>:<sourceId>` of the
   * blob service), so stores on different buckets share one database safely.
   */
  scope?: string;
}

/** The SHA-256 hex digest of a `graph-binary:` id, or `undefined` when malformed. */
function digestOf(id: string): string | undefined {
  if (!id.startsWith(GRAPH_BINARY_ID_PREFIX)) return undefined;
  const digest = id.slice(GRAPH_BINARY_ID_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(digest) ? digest : undefined;
}

/** Whether a blob-store or repository error means "no such record/object". */
function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? "";
  const message = (error as { message?: string })?.message ?? "";
  return (
    /NotFound|NoSuchKey/i.test(name) ||
    /not ?found|NoSuchKey|ENOENT|does not exist/i.test(message)
  );
}

/** Collects an async byte stream into one buffer. */
async function bufferOf(value: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of value) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** A `Content-Disposition` header value carrying a (UTF-8) file name. */
function dispositionOf(fileName: string, inline: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * {@link GraphBinaryStore} over an integrations blob store plus the binary
 * index tables.
 *
 * @example
 * ```ts
 * const blobs = new S3BlobStoreService();
 * await blobs.boot(); // BLOBS__S3__* environment
 * await engine.boot({ ...config, binaryStore: new BlobGraphBinaryStore(blobs) });
 * ```
 */
export class BlobGraphBinaryStore implements GraphBinaryStore {
  private readonly graceMs: number;
  private readonly urlSeconds: number;
  private binaries?: Repo<GraphBinaryModel>;
  private holders?: Repo<GraphBinaryHolderModel>;

  /**
   * @param blobs - An initialized integrations blob store service.
   * @param options - Index adapter, deletion grace and URL lifetime.
   */
  constructor(
    private readonly blobs: BlobStoreService,
    private readonly options: BlobGraphBinaryStoreOptions = {}
  ) {
    this.graceMs = options.deleteGraceMs ?? DEFAULT_GRAPH_BINARY_DELETE_GRACE_MS;
    this.urlSeconds = options.downloadUrlSeconds ?? 300;
    this.scope =
      options.scope ??
      `${blobs.provider}:${blobs.sourceId ?? ""}`;
  }

  /** Index scope of this store's rows. */
  private readonly scope: string;

  /** The underlying blob store service. */
  get service(): BlobStoreService {
    return this.blobs;
  }

  /**
   * The index repositories, bound to the configured adapter, else the current
   * one, else a private in-process RAM adapter (tests, embedding).
   */
  private async repos(): Promise<{
    binaries: Repo<GraphBinaryModel>;
    holders: Repo<GraphBinaryHolderModel>;
  }> {
    if (!this.binaries || !this.holders) {
      let adapter = this.options.adapter;
      if (!adapter) {
        try {
          adapter = Adapter.current;
          void Repository.forModel(GraphBinaryModel, adapter?.alias);
        } catch {
          adapter = undefined;
        }
      }
      if (!adapter) {
        const { RamAdapter } = await import("@decaf-ts/core/ram");
        const ram = new RamAdapter(undefined, `as-graph-binary-index-${randomUUID()}`);
        await ram.initialize();
        adapter = ram as unknown as Adapter<any, any, any, any>;
      }
      this.binaries = Repository.forModel(
        GraphBinaryModel,
        adapter.alias
      ) as Repo<GraphBinaryModel>;
      this.holders = Repository.forModel(
        GraphBinaryHolderModel,
        adapter.alias
      ) as Repo<GraphBinaryHolderModel>;
    }
    return { binaries: this.binaries, holders: this.holders };
  }

  async write(
    runId: string,
    bytes: Buffer,
    descriptor: GraphBinaryDescriptor
  ): Promise<string> {
    const id = graphBinaryIdOf(bytes);
    const digest = digestOf(id) as string;
    await this.index(id, { ...descriptor, byteLength: bytes.byteLength });
    await this.addHolder(graphBinaryRunHolder(runId), id);
    if (!(await this.blobs.has(`bytes/${digest}`))) {
      await this.blobs.put(`bytes/${digest}`, bytes, {
        contentType: descriptor.mimeType,
      });
    }
    return id;
  }

  async writeStream(
    runId: string,
    stream: AsyncIterable<Uint8Array>,
    descriptor: Omit<GraphBinaryDescriptor, "byteLength">
  ): Promise<{ id: string; byteLength: number }> {
    const hash = createHash("sha256");
    let byteLength = 0;
    const tapped = (async function* () {
      for await (const chunk of stream) {
        hash.update(chunk);
        byteLength += chunk.byteLength;
        yield chunk;
      }
    })();
    const temporary = `tmp/${randomUUID()}`;
    await this.blobs.put(temporary, tapped, { contentType: descriptor.mimeType });
    const digest = hash.digest("hex");
    const id = `${GRAPH_BINARY_ID_PREFIX}${digest}`;
    try {
      await this.index(id, { ...descriptor, byteLength });
      await this.addHolder(graphBinaryRunHolder(runId), id);
      if (!(await this.blobs.has(`bytes/${digest}`))) {
        await this.blobs.copy(temporary, `bytes/${digest}`, {
          contentType: descriptor.mimeType,
        });
      }
    } finally {
      await this.deleteQuietly(temporary);
    }
    return { id, byteLength };
  }

  async read(id: string): Promise<Buffer | undefined> {
    const stream = await this.openStream(id);
    return stream ? bufferOf(stream) : undefined;
  }

  async openStream(id: string): Promise<AsyncIterable<Uint8Array> | undefined> {
    const digest = digestOf(id);
    if (!digest) return undefined;
    try {
      return (await this.blobs.get(`bytes/${digest}`)).value;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async describe(id: string): Promise<GraphBinaryDescriptor | undefined> {
    if (!digestOf(id)) return undefined;
    const row = await this.readRow(id);
    if (!row) return undefined;
    return {
      fileName: row.fileName,
      mimeType: row.mimeType,
      byteLength: Number(row.byteLength),
      ...(row.path ? { path: row.path } : {}),
    };
  }

  async belongsTo(runId: string, id: string): Promise<boolean> {
    if (!digestOf(id)) return false;
    try {
      await (await this.repos()).holders.read(
        graphBinaryHolderId(this.scope, id, graphBinaryRunHolder(runId))
      );
      return true;
    } catch {
      return false;
    }
  }

  async retain(runId: string, id: string): Promise<void> {
    await this.hold(graphBinaryRunHolder(runId), id);
  }

  async deleteRun(runId: string): Promise<void> {
    await this.releaseHolder(graphBinaryRunHolder(runId));
  }

  async hold(holder: string, id: string): Promise<void> {
    if (!digestOf(id) || !(await this.readRow(id))) return;
    await this.addHolder(holder, id);
  }

  async releaseHolder(holder: string): Promise<void> {
    const { holders } = await this.repos();
    for (let round = 0; round < 10_000; round++) {
      const rows = (await holders
        .select()
        .where(
          Condition.attr<GraphBinaryHolderModel>("scope")
            .eq(this.scope)
            .and(Condition.attr<GraphBinaryHolderModel>("holder").eq(holder))
        )
        .limit(BATCH)
        .execute()) as GraphBinaryHolderModel[];
      for (const row of rows) {
        await this.deleteRowQuietly(holders, row.id);
        if (!(await this.isHeld(row.binaryId))) {
          if (this.graceMs <= 0) await this.deleteBinary(row.binaryId);
          else await this.markPending(row.binaryId, new Date());
        }
      }
      if (rows.length < BATCH) return;
    }
  }

  async downloadUrl(
    id: string,
    options: { fileName: string; mimeType: string; inline: boolean; expiresInSeconds?: number }
  ): Promise<string | undefined> {
    const digest = digestOf(id);
    if (!digest) return undefined;
    try {
      const signed = await this.blobs.url(`bytes/${digest}`, {
        operation: "get",
        expiresInSeconds: options.expiresInSeconds ?? this.urlSeconds,
        responseContentDisposition: dispositionOf(options.fileName, options.inline),
        responseContentType: options.inline ? options.mimeType : "application/octet-stream",
      });
      // A provider without real signing (memory, local) returns a non-HTTP URL.
      return /^https?:\/\//.test(signed.url) ? signed.url : undefined;
    } catch {
      return undefined;
    }
  }

  async sweep(now: Date = new Date()): Promise<number> {
    const { binaries } = await this.repos();
    const cutoff = new Date(now.getTime() - this.graceMs);
    let deleted = 0;
    for (let round = 0; round < 10_000; round++) {
      const rows = (await binaries
        .select()
        .where(
          Condition.attr<GraphBinaryModel>("scope")
            .eq(this.scope)
            .and(Condition.attr<GraphBinaryModel>("deletePendingAt").lte(cutoff))
        )
        .orderBy("deletePendingAt", OrderDirection.ASC)
        .limit(BATCH)
        .execute()) as GraphBinaryModel[];
      for (const row of rows) {
        if (!row.deletePendingAt) continue;
        if (await this.isHeld(row.binaryId)) {
          await this.markPending(row.binaryId, undefined);
          continue;
        }
        await this.deleteBinary(row.binaryId);
        deleted++;
      }
      if (rows.length < BATCH) break;
    }
    return deleted;
  }

  /** Reads a file's index row, or `undefined`. */
  private async readRow(id: string): Promise<GraphBinaryModel | undefined> {
    try {
      return (await (await this.repos()).binaries.read(
        graphBinaryRowId(this.scope, id)
      )) as GraphBinaryModel;
    } catch {
      return undefined;
    }
  }

  /** Creates a file's index row (first writer wins), clearing a pending delete. */
  private async index(id: string, descriptor: GraphBinaryDescriptor): Promise<void> {
    const existing = await this.readRow(id);
    if (existing) {
      if (existing.deletePendingAt) await this.markPending(id, undefined);
      return;
    }
    try {
      await (await this.repos()).binaries.create(
        new GraphBinaryModel({
          id: graphBinaryRowId(this.scope, id),
          scope: this.scope,
          binaryId: id,
          fileName: descriptor.fileName,
          mimeType: descriptor.mimeType,
          byteLength: descriptor.byteLength,
          ...(descriptor.path ? { path: descriptor.path } : {}),
        })
      );
    } catch (error) {
      // A concurrent writer created it first.
      if (!(await this.readRow(id))) throw error;
    }
  }

  /** Records a holder (idempotent) and clears a pending delete. */
  private async addHolder(holder: string, id: string): Promise<void> {
    const { holders } = await this.repos();
    const key = graphBinaryHolderId(this.scope, id, holder);
    try {
      await holders.read(key);
    } catch {
      try {
        await holders.create(
          new GraphBinaryHolderModel({ id: key, scope: this.scope, binaryId: id, holder })
        );
      } catch {
        // a concurrent hold of the same file by the same holder
      }
    }
    const row = await this.readRow(id);
    if (row?.deletePendingAt) await this.markPending(id, undefined);
  }

  /** Whether any holder still references a file. */
  private async isHeld(id: string): Promise<boolean> {
    const { holders } = await this.repos();
    const rows = (await holders
      .select()
      .where(
        Condition.attr<GraphBinaryHolderModel>("scope")
          .eq(this.scope)
          .and(Condition.attr<GraphBinaryHolderModel>("binaryId").eq(id))
      )
      .limit(1)
      .execute()) as GraphBinaryHolderModel[];
    return rows.length > 0;
  }

  /** Sets (or clears, with `undefined`) a file's pending-delete mark. */
  private async markPending(id: string, at: Date | undefined): Promise<void> {
    const row = await this.readRow(id);
    if (!row) return;
    row.deletePendingAt = (at ?? null) as unknown as Date;
    try {
      await (await this.repos()).binaries.update(row);
    } catch (error) {
      // A row deleted concurrently is fine; anything else would leak the
      // file (it would never become sweepable), so it must surface.
      if (await this.readRow(id)) throw error;
    }
  }

  /** Deletes a file's bytes, then its index row. */
  private async deleteBinary(id: string): Promise<void> {
    const digest = digestOf(id);
    if (digest) await this.deleteQuietly(`bytes/${digest}`);
    await this.deleteRowQuietly(
      (await this.repos()).binaries,
      graphBinaryRowId(this.scope, id)
    );
  }

  private async deleteRowQuietly(repo: Repo<any>, id: string): Promise<void> {
    try {
      await repo.delete(id);
    } catch {
      // already gone
    }
  }

  /** Deletes an object, ignoring "not found". */
  private async deleteQuietly(key: string): Promise<void> {
    try {
      await this.blobs.delete(key);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}
