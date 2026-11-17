/**
 * @module as-graph/engine/binary/GraphBinaryAccess
 * @summary Streaming access to workflow files for nodes.
 * @description A node declaring the `binaryStream` capability receives file
 * inputs as `GraphBinaryReference`s (never hydrated base64) and reads or
 * produces files through `context.binaries`:
 *
 * - `open(ref)` streams the bytes;
 * - `readBuffer(ref)` loads them, refusing files above
 *   `GRAPH_BINARY_MAX_BUFFER_BYTES` (default 64 MiB) — for formats that need
 *   the whole file in memory;
 * - `write(bytes | stream, descriptor)` stores a new file and returns its
 *   reference (streamed straight to the store when the store can stream).
 *
 * Every other node keeps the hydrated-payload contract, under the same buffer
 * cap ({@link assertGraphBinaryBufferable}).
 */
import {
  isGraphBinaryPayload,
  isGraphBinaryReference,
  type GraphBinaryDescriptor,
  type GraphBinaryPayload,
  type GraphBinaryReference,
} from "../../shared/graph/document/GraphBinaryReference";
import { GraphExecutionError } from "../errors/GraphExecutionError";
import type { GraphBinaryStore } from "./GraphBinaryStore";

/** Environment variable: the largest file a node may load into memory. */
export const GRAPH_BINARY_MAX_BUFFER_ENV = "GRAPH_BINARY_MAX_BUFFER_BYTES";
/** Default in-memory ceiling for one file: 64 MiB. */
export const DEFAULT_GRAPH_BINARY_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** The node capability that opts a node into reference inputs. */
export const GRAPH_BINARY_STREAM_CAPABILITY = "binaryStream";

/** The configured in-memory ceiling for one file. */
export function graphBinaryMaxBufferBytes(): number {
  const raw = Number(process.env[GRAPH_BINARY_MAX_BUFFER_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GRAPH_BINARY_MAX_BUFFER_BYTES;
}

/**
 * Fails closed when a file is too large to load into memory.
 *
 * @param descriptor - The file's name and size.
 * @param maxBytes - The ceiling (default {@link graphBinaryMaxBufferBytes}).
 * @throws {GraphExecutionError} `GRAPH_BINARY_TOO_LARGE`.
 */
export function assertGraphBinaryBufferable(
  descriptor: { fileName: string; byteLength: number },
  maxBytes: number = graphBinaryMaxBufferBytes()
): void {
  if (descriptor.byteLength > maxBytes) {
    throw new GraphExecutionError(
      `File '${descriptor.fileName}' is ${descriptor.byteLength} bytes, above the ${maxBytes}-byte limit for loading a file into memory (${GRAPH_BINARY_MAX_BUFFER_ENV}); use a node that streams it`,
      "GRAPH_BINARY_TOO_LARGE",
      { fileName: descriptor.fileName, byteLength: descriptor.byteLength, maxBytes }
    );
  }
}

/** Whether a node manifest opts into reference (streamed) file inputs. */
export function graphNodeStreamsBinaries(
  manifest: { capabilities?: readonly string[] } | undefined
): boolean {
  return manifest?.capabilities?.includes(GRAPH_BINARY_STREAM_CAPABILITY) === true;
}

/** Streaming file access handed to nodes through `context.binaries`. */
export class GraphBinaryAccess {
  /**
   * @param store - The engine's binary store (`undefined` in inline mode).
   * @param runId - The run that holds the files this node writes.
   */
  constructor(
    private readonly store: GraphBinaryStore | undefined,
    private readonly runId: string
  ) {}

  /**
   * Streams a file: a store reference, or an inline payload.
   *
   * @throws {GraphExecutionError} `GRAPH_BINARY_NOT_FOUND` when the bytes are gone.
   */
  async open(file: GraphBinaryReference | GraphBinaryPayload): Promise<AsyncIterable<Uint8Array>> {
    if (isGraphBinaryPayload(file)) {
      const bytes = Buffer.from(file.data, "base64");
      return (async function* () {
        yield bytes;
      })();
    }
    const stream = this.store?.openStream
      ? await this.store.openStream(file.id)
      : await this.store?.read(file.id).then((bytes) =>
          bytes
            ? (async function* () {
                yield bytes;
              })()
            : undefined
        );
    if (!stream) {
      throw new GraphExecutionError(
        `Binary '${file.fileName}' (${file.id}) is no longer available in the binary store`,
        "GRAPH_BINARY_NOT_FOUND",
        { id: file.id, fileName: file.fileName }
      );
    }
    return stream;
  }

  /**
   * Loads a file into memory, under the buffer ceiling.
   *
   * @throws {GraphExecutionError} `GRAPH_BINARY_TOO_LARGE` / `GRAPH_BINARY_NOT_FOUND`.
   */
  async readBuffer(
    file: GraphBinaryReference | GraphBinaryPayload,
    maxBytes: number = graphBinaryMaxBufferBytes()
  ): Promise<Buffer> {
    assertGraphBinaryBufferable(file, maxBytes);
    const chunks: Buffer[] = [];
    for await (const chunk of await this.open(file)) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  /**
   * Stores a new file for this run and returns its reference (or, without a
   * store, the inline payload).
   */
  async write(
    bytes: Buffer | AsyncIterable<Uint8Array>,
    descriptor: Omit<GraphBinaryDescriptor, "byteLength">
  ): Promise<GraphBinaryReference | GraphBinaryPayload> {
    if (!Buffer.isBuffer(bytes) && this.store?.writeStream) {
      const { id, byteLength } = await this.store.writeStream(this.runId, bytes, descriptor);
      return { ...descriptor, byteLength, id };
    }
    let buffer: Buffer;
    if (Buffer.isBuffer(bytes)) {
      buffer = bytes;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of bytes) chunks.push(Buffer.from(chunk));
      buffer = Buffer.concat(chunks);
    }
    if (!this.store) {
      return { ...descriptor, byteLength: buffer.byteLength, data: buffer.toString("base64") };
    }
    const id = await this.store.write(this.runId, buffer, {
      ...descriptor,
      byteLength: buffer.byteLength,
    });
    return { ...descriptor, byteLength: buffer.byteLength, id };
  }

  /**
   * Whether a value is a file this accessor can read.
   * @returns {boolean} Whether the value is a binary reference or payload.
   */
  static isFile(value: unknown): value is GraphBinaryReference | GraphBinaryPayload {
    return isGraphBinaryReference(value) || isGraphBinaryPayload(value);
  }
}
