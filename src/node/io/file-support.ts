/**
 * @module as-graph/nodes/io/file-support
 * @summary Path-safe file IO and binary payload helpers for the IO nodes.
 * @description Every file path is resolved under a single file-IO base —
 * `GRAPH_FILE_IO_BASE` when set, otherwise the process working directory — and
 * checked against that base after symlink resolution. Paths containing NUL
 * bytes, escaping the base, or targeting `workdocs`, `/etc`, `/proc`, `/root`,
 * or `~/.ssh` are rejected with `GRAPH_FILE_PATH_FORBIDDEN`/`GRAPH_FILE_INVALID_PATH`.
 * The module also maps extensions to MIME types and converts between strings,
 * buffers, base64 payload records, and the `BinaryFilePayload` shape the file
 * nodes emit.
 */
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { glob, mkdir, readFile, realpath, writeFile, appendFile } from "node:fs/promises";
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";
import { isBinaryGraphDataPayload, isGraphDataRecord } from "../data/support";

const FILE_IO_BASE_ENV = "GRAPH_FILE_IO_BASE";
const FORBIDDEN_PATH_SEGMENTS = new Set(["workdocs"]);

function forbiddenAbsoluteDirectories(): string[] {
  return ["/etc", "/proc", "/root", resolve(homedir(), ".ssh")];
}

/**
 * Resolves the file-IO base directory.
 *
 * @returns The real path of `GRAPH_FILE_IO_BASE` (when set and non-empty) or
 *   the current working directory; the lexical path is returned when it cannot
 *   be resolved.
 */
export function fileIoBase(): string {
  const configured = process.env[FILE_IO_BASE_ENV]?.trim();
  const lexical = resolve(
    configured && configured.length > 0 ? configured : process.cwd()
  );
  try {
    return realpathSync(lexical);
  } catch {
    return lexical;
  }
}

function isWithinBase(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Asserts that a resolved candidate path stays inside the base and avoids the
 * forbidden directories.
 *
 * @param base - The resolved file-IO base.
 * @param candidate - The resolved candidate path.
 * @param configuredPath - The original configured path for error context.
 * @throws {GraphExecutionError} `GRAPH_FILE_PATH_FORBIDDEN` when the path
 *   escapes the base or targets a forbidden directory or segment.
 */
export function assertContainedPath(
  base: string,
  candidate: string,
  configuredPath: string
): void {
  if (!isWithinBase(base, candidate)) {
    throw new GraphExecutionError(
      `File node path '${configuredPath}' resolves outside the configured file IO base`,
      "GRAPH_FILE_PATH_FORBIDDEN",
      { path: configuredPath, base }
    );
  }
  for (const forbidden of forbiddenAbsoluteDirectories()) {
    if (isWithinBase(forbidden, candidate)) {
      throw new GraphExecutionError(
        `File node path '${configuredPath}' targets a forbidden directory`,
        "GRAPH_FILE_PATH_FORBIDDEN",
        { path: configuredPath }
      );
    }
  }
  const segments = relative(base, candidate).split(sep).filter(Boolean);
  for (const segment of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment.toLowerCase())) {
      throw new GraphExecutionError(
        `File node path '${configuredPath}' targets a forbidden directory`,
        "GRAPH_FILE_PATH_FORBIDDEN",
        { path: configuredPath, segment }
      );
    }
  }
}

function assertNotForbiddenAbsolutePath(configuredPath: string): void {
  if (!isAbsolute(configuredPath)) return;
  const lexical = resolve(configuredPath);
  for (const forbidden of forbiddenAbsoluteDirectories()) {
    if (isWithinBase(forbidden, lexical)) {
      throw new GraphExecutionError(
        `File node path '${configuredPath}' targets a forbidden directory`,
        "GRAPH_FILE_PATH_FORBIDDEN",
        { path: configuredPath }
      );
    }
  }
}

/**
 * Resolves a configured path under the file-IO base and validates containment.
 *
 * Leading separators are stripped so configured paths are always treated as
 * base-relative; NUL bytes are rejected before resolution.
 *
 * @param configuredPath - The configured file path.
 * @returns The resolved base directory and candidate path.
 * @throws {GraphExecutionError} `GRAPH_FILE_INVALID_PATH` for NUL bytes and
 *   `GRAPH_FILE_PATH_FORBIDDEN` for escaping/forbidden paths.
 */
export function resolveGraphFilePath(configuredPath: string): {
  base: string;
  candidate: string;
} {
  if (configuredPath.includes("\0")) {
    throw new GraphExecutionError(
      "File node path contains a NUL byte",
      "GRAPH_FILE_INVALID_PATH",
      { path: configuredPath }
    );
  }
  const base = fileIoBase();
  assertNotForbiddenAbsolutePath(configuredPath);
  const normalized = configuredPath.replace(/^[/\\]+/, "");
  const candidate = resolve(base, normalized);
  assertContainedPath(base, candidate, configuredPath);
  return { base, candidate };
}

async function realPathOfNearestExisting(
  candidate: string
): Promise<string | undefined> {
  let current = candidate;
  while (true) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

const MIME_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".ics": "text/calendar",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".rtf": "application/rtf",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

/**
 * Infers a MIME type from a file extension.
 *
 * @param fileName - File name or path.
 * @returns The mapped MIME type, or `application/octet-stream` for unknown
 *   extensions.
 */
export function mimeTypeFor(fileName: string): string {
  return MIME_TYPES[extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/** Serialized file payload shared by the binary and conversion nodes. */
export interface BinaryFilePayload {
  fileName: string;
  path?: string;
  mimeType: string;
  byteLength: number;
  data: string;
}

/**
 * Wraps a buffer as a `BinaryFilePayload`, encoding the data as base64.
 *
 * @param buffer - The file content.
 * @param fileName - File name used for payload metadata.
 * @param path - Optional original configured path.
 * @param mimeType - Optional MIME override; otherwise inferred from the name.
 * @returns The serialized payload.
 */
export function binaryPayloadOf(
  buffer: Buffer,
  fileName: string,
  path?: string,
  mimeType?: string
): BinaryFilePayload {
  const payload: BinaryFilePayload = {
    fileName,
    mimeType: mimeType || mimeTypeFor(fileName),
    byteLength: buffer.byteLength,
    data: buffer.toString("base64"),
  };
  if (path !== undefined) payload.path = path;
  return payload;
}

/** Input decoding mode: UTF-8 text, base64 text, or inference for payload records. */
export type GraphBinaryEncoding = "utf8" | "base64" | "auto";

/**
 * Decodes a node input into a `Buffer`.
 *
 * Strings decode as UTF-8 or base64; `data:` URLs drop their prefix; buffers,
 * typed arrays, and array buffers pass through; records are searched for the
 * first of `dataPropertyName`, `data`, `content`, or `value`.
 *
 * @param value - The input value.
 * @param encoding - Decoding mode (default `utf8`; `auto` inspects payload records).
 * @param dataPropertyName - Preferred record field (default `data`).
 * @returns The decoded buffer.
 * @throws {GraphExecutionError} `GRAPH_BINARY_INPUT_REQUIRED` when the value
 *   cannot be decoded.
 */
export function binaryBufferOf(
  value: unknown,
  encoding: GraphBinaryEncoding = "utf8",
  dataPropertyName = "data"
): Buffer {
  if (typeof value === "string") {
    if (value.startsWith("data:")) {
      const comma = value.indexOf(",");
      if (comma >= 0) {
        return Buffer.from(value.slice(comma + 1), "base64");
      }
    }
    return encoding === "base64"
      ? Buffer.from(value, "base64")
      : Buffer.from(value, "utf8");
  }
  if (isBinaryGraphDataPayload(value)) {
    return Buffer.isBuffer(value)
      ? value
      : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  }
  if (isGraphDataRecord(value)) {
    const recordEncoding: GraphBinaryEncoding =
      encoding === "auto"
        ? typeof value["byteLength"] === "number" ||
          typeof value["mimeType"] === "string"
          ? "base64"
          : "utf8"
        : encoding;
    for (const key of [dataPropertyName, "data", "content", "value"]) {
      if (key && value[key] !== undefined && value[key] !== value) {
        return binaryBufferOf(value[key], recordEncoding, dataPropertyName);
      }
    }
  }
  throw new GraphExecutionError(
    "File node requires a binary payload",
    "GRAPH_BINARY_INPUT_REQUIRED",
    { valueType: typeof value }
  );
}

/**
 * Reads a contained file and serializes it as a payload.
 *
 * @param configuredPath - The configured path, relative to the file-IO base.
 * @returns The payload and its byte length.
 * @throws {GraphExecutionError} `GRAPH_FILE_INVALID_PATH` when the file does
 *   not exist, plus the containment errors from `resolveGraphFilePath`.
 */
export async function readGraphFilePayload(
  configuredPath: string
): Promise<{ payload: BinaryFilePayload; bytes: number }> {
  const { base, candidate } = resolveGraphFilePath(configuredPath);
  let existing: string;
  try {
    existing = await realpath(candidate);
  } catch {
    throw new GraphExecutionError(
      `File node path '${configuredPath}' does not exist`,
      "GRAPH_FILE_INVALID_PATH",
      { path: configuredPath }
    );
  }
  assertContainedPath(base, existing, configuredPath);
  const content = await readFile(existing);
  return {
    payload: binaryPayloadOf(
      content,
      basename(candidate),
      configuredPath,
      mimeTypeFor(candidate)
    ),
    bytes: content.byteLength,
  };
}

/**
 * Writes a buffer to a contained file.
 *
 * Existing targets and the nearest existing ancestor are re-checked after
 * symlink resolution; parent directories are created unless disabled.
 *
 * @param configuredPath - The configured path, relative to the file-IO base.
 * @param data - The bytes to write.
 * @param options - Append and directory-creation options.
 * @returns The configured path and the number of bytes written.
 * @throws {GraphExecutionError} `GRAPH_FILE_PATH_FORBIDDEN` when the target or
 *   its parent resolves outside the base.
 */
export async function writeGraphFile(
  configuredPath: string,
  data: Buffer,
  options: { append?: boolean; createDirectories?: boolean } = {}
): Promise<{ path: string; bytes: number }> {
  const { base, candidate } = resolveGraphFilePath(configuredPath);
  const existing = await realPathOfNearestExisting(candidate);
  if (existing) assertContainedPath(base, existing, configuredPath);
  if (options.createDirectories) {
    await mkdir(dirname(candidate), { recursive: true });
  }
  const parentRealPath = await realpath(dirname(candidate));
  assertContainedPath(base, parentRealPath, configuredPath);
  const targetRealPath = await realPathOfNearestExisting(candidate);
  if (targetRealPath) assertContainedPath(base, targetRealPath, configuredPath);

  if (options.append) {
    await appendFile(candidate, data);
  } else {
    await writeFile(candidate, data);
  }
  return { path: configuredPath, bytes: data.byteLength };
}

/**
 * Expands a glob pattern inside the file-IO base.
 *
 * @param pattern - The glob pattern; leading separators are stripped.
 * @returns Matching, contained, existing paths in sorted order.
 * @throws {GraphExecutionError} `GRAPH_FILE_PATH_FORBIDDEN` when a match
 *   resolves outside the base.
 */
export async function graphGlobFiles(pattern: string): Promise<string[]> {
  const base = fileIoBase();
  const normalized = pattern.replace(/^[/\\]+/, "");
  const matches: string[] = [];
  for await (const match of glob(normalized, { cwd: base })) {
    matches.push(match);
  }
  matches.sort();
  const files: string[] = [];
  for (const match of matches) {
    const { candidate } = resolveGraphFilePath(match);
    const existing = await realPathOfNearestExisting(candidate);
    if (!existing) continue;
    assertContainedPath(base, existing, match);
    files.push(match);
  }
  return files;
}
