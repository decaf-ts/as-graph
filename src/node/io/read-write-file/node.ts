/**
 * @module as-graph/nodes/io/read-write-file
 * @summary Read/Write Files from Disk IO node declaration (DECAF-746 IO
 * family).
 * @description Read/Write Files from Disk — read or write a file at the
 * configured `path`. The path is required and must not contain a NUL byte.
 * `read` returns the file's content (`base64` or `utf8` per `encoding`) with
 * its byte length. `write` resolves the content from the configured `content`
 * field or the `value` input (strings are encoded per `encoding`, binaries
 * pass through, anything else is stringified), optionally creates the parent
 * directories (`createDirectories`), and either appends to or overwrites the
 * file per `append`. The write path and byte length are reported on both
 * `result` and `bytes`.
 */
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";

/** Environment variable selecting the directory file operations are rooted at. */
const FILE_IO_BASE_ENV = "GRAPH_FILE_IO_BASE";

/** Directory names that are never readable or writable through the node. */
const FORBIDDEN_PATH_SEGMENTS = new Set(["workdocs"]);

/** Absolute system directories that are never readable or writable. */
function forbiddenAbsoluteDirectories(): string[] {
  return ["/etc", "/proc", "/root", resolve(homedir(), ".ssh")];
}

/**
 * Resolves the configured file-IO root, defaulting to the process cwd.
 */
function fileIoBase(): string {
  const configured = process.env[FILE_IO_BASE_ENV]?.trim();
  const lexical = resolve(
    configured && configured.length > 0 ? configured : process.cwd()
  );
  try {
    // Canonicalize the root so a symlinked workspace does not make every
    // legitimate real path look like an escape.
    return realpathSync(lexical);
  } catch {
    return lexical;
  }
}

/**
 * Returns whether `candidate` is the base itself or lives beneath it.
 */
function isWithinBase(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Rejects a resolved path that escapes the file-IO root or hits a forbidden
 * system/workdocs directory.
 */
function assertContainedPath(
  base: string,
  candidate: string,
  configuredPath: string
): void {
  if (!isWithinBase(base, candidate)) {
    throw new GraphExecutionError(
      `Read/Write Files from Disk node path '${configuredPath}' resolves outside the configured file IO base`,
      "GRAPH_READ_WRITE_FILE_PATH_FORBIDDEN",
      { path: configuredPath, base }
    );
  }
  for (const forbidden of forbiddenAbsoluteDirectories()) {
    if (isWithinBase(forbidden, candidate)) {
      throw new GraphExecutionError(
        `Read/Write Files from Disk node path '${configuredPath}' targets a forbidden directory`,
        "GRAPH_READ_WRITE_FILE_PATH_FORBIDDEN",
        { path: configuredPath }
      );
    }
  }
  const segments = relative(base, candidate).split(sep).filter(Boolean);
  for (const segment of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment.toLowerCase())) {
      throw new GraphExecutionError(
        `Read/Write Files from Disk node path '${configuredPath}' targets a forbidden directory`,
        "GRAPH_READ_WRITE_FILE_PATH_FORBIDDEN",
        { path: configuredPath, segment }
      );
    }
  }
}

/**
 * Rejects an absolute configured path that lexically names a forbidden host
 * directory.
 *
 * Absolute paths are interpreted relative to the file-IO root, but a path such
 * as `/etc/passwd` must still fail with the FORBIDDEN code: mapping it below the
 * root would only fail later as a missing file and report the wrong reason.
 * The check runs against the configured absolute path before the leading
 * separators are stripped.
 */
function assertNotForbiddenAbsolutePath(configuredPath: string): void {
  if (!isAbsolute(configuredPath)) return;
  const lexical = resolve(configuredPath);
  for (const forbidden of forbiddenAbsoluteDirectories()) {
    if (isWithinBase(forbidden, lexical)) {
      throw new GraphExecutionError(
        `Read/Write Files from Disk node path '${configuredPath}' targets a forbidden directory`,
        "GRAPH_READ_WRITE_FILE_PATH_FORBIDDEN",
        { path: configuredPath }
      );
    }
  }
}

/**
 * Resolves a configured path against the file-IO root.
 *
 * Absolute paths are interpreted relative to the root (their leading
 * separators are stripped), so `/etc/passwd` can never escape to the system
 * file. Relative paths are resolved lexically and must stay beneath the root.
 * An absolute path that names a forbidden host directory fails closed with the
 * FORBIDDEN code before being mapped below the root.
 */
function resolveFileIoPath(configuredPath: string): {
  base: string;
  candidate: string;
} {
  const base = fileIoBase();
  assertNotForbiddenAbsolutePath(configuredPath);
  const normalized = configuredPath.replace(/^[/\\]+/, "");
  const candidate = resolve(base, normalized);
  assertContainedPath(base, candidate, configuredPath);
  return { base, candidate };
}

/**
 * Resolves the real path of the nearest existing ancestor (or the target
 * itself when it exists), so a symlink cannot redirect an operation outside the
 * base after the lexical check.
 */
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

/** What the node does at the configured path. */
export type ReadWriteFileOperation = "read" | "write";

/** Encoding applied to string content. */
export type ReadWriteFileEncoding = "utf8" | "base64";

/** Inputs accepted by the Read/Write Files from Disk node. */
export type ReadWriteFileNodeInput = Record<string, unknown>;

/** Outputs produced by the Read/Write Files from Disk node. */
export interface ReadWriteFileNodeOutput {
  result: unknown;
  bytes?: number;
}

/**
 * Read/Write Files from Disk IO node: reads or writes a file at the
 * configured path.
 */
@node("core.io.readWriteFile", {
  kind: "core.io.readWriteFile",
  category: "IO",
  color: "#0ea5e9",
  icon: "ti-device-floppy",
  width: 96,
  height: 96,
  labels: ["io", "file", "disk"],
  metadata: {
    title: "graph.node.io.read_write_file.name",
    description: "graph.node.io.read_write_file.description",
  },
})
@model()
export class ReadWriteFileNode extends GraphNode<
  ReadWriteFileNodeInput,
  ReadWriteFileNodeOutput
> {
  /**
   * Reads or writes the file at the configured path.
   *
   * @param request - The execution request carrying the optional `value`
   *   content fallback.
   * @returns The file content (read) or the written path and byte count
   *   (write).
   * @throws {GraphExecutionError} with code `GRAPH_READ_WRITE_FILE_PATH_REQUIRED`
   *   when no `path` is configured, `GRAPH_READ_WRITE_FILE_INVALID_PATH` when
   *   the path contains a NUL byte, and `GRAPH_READ_WRITE_FILE_CONTENT_REQUIRED`
   *   when writing without any content.
   */
  override async execute(
    request: GraphNodeExecutionRequest<ReadWriteFileNodeInput>
  ): Promise<GraphExecutionValues> {
    if (!this.path) {
      throw new GraphExecutionError(
        "Read/Write Files from Disk node requires a path",
        "GRAPH_READ_WRITE_FILE_PATH_REQUIRED"
      );
    }
    if (this.path.includes("\0")) {
      throw new GraphExecutionError(
        "Read/Write Files from Disk node path contains a NUL byte",
        "GRAPH_READ_WRITE_FILE_INVALID_PATH",
        { path: this.path }
      );
    }

    const { base, candidate } = resolveFileIoPath(this.path);

    if (this.operation === "read") {
      let existing: string;
      try {
        existing = await realpath(candidate);
      } catch {
        throw new GraphExecutionError(
          `Read/Write Files from Disk node path '${this.path}' does not exist`,
          "GRAPH_READ_WRITE_FILE_INVALID_PATH",
          { path: this.path }
        );
      }
      assertContainedPath(base, existing, this.path);
      const content = await readFile(existing);
      return {
        result:
          this.encoding === "base64"
            ? content.toString("base64")
            : content.toString("utf8"),
        bytes: content.byteLength,
      };
    }

    const content = this.content !== undefined ? this.content : request.inputs["value"];
    if (content === undefined || content === null) {
      throw new GraphExecutionError(
        "Read/Write Files from Disk node requires content to write",
        "GRAPH_READ_WRITE_FILE_CONTENT_REQUIRED"
      );
    }
    const data =
      typeof content === "string"
        ? this.encoding === "base64"
          ? Buffer.from(content, "base64")
          : Buffer.from(content, "utf8")
        : Buffer.isBuffer(content)
          ? content
          : content instanceof Uint8Array
            ? Buffer.from(content)
            : Buffer.from(String(content), "utf8");

    const existing = await realPathOfNearestExisting(candidate);
    if (existing) assertContainedPath(base, existing, this.path);
    if (this.createDirectories) {
      await mkdir(dirname(candidate), { recursive: true });
    }
    const parentRealPath = await realpath(dirname(candidate));
    assertContainedPath(base, parentRealPath, this.path);
    const targetRealPath = await realPathOfNearestExisting(candidate);
    if (targetRealPath) assertContainedPath(base, targetRealPath, this.path);

    if (this.append) {
      await appendFile(candidate, data);
    } else {
      await writeFile(candidate, data);
    }

    return {
      result: { path: this.path, bytes: data.byteLength },
      bytes: data.byteLength,
    };
  }

  @input({ handle: "value" })
  value?: unknown;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.read_write_file.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: ReadWriteFileOperation = "read";

  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.read_write_file.fields.path.label",
    placeholder: "graph.node.io.read_write_file.fields.path.placeholder",
    type: "text",
  })
  @input({ handle: "path", userControlled: true })
  path: string = "";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.read_write_file.fields.encoding.label",
    type: "select",
  })
  @input({ handle: "encoding", userControlled: true })
  encoding: ReadWriteFileEncoding = "utf8";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.read_write_file.fields.content.label",
    type: "textarea",
  })
  @input({ handle: "content", userControlled: true })
  content?: string;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.read_write_file.fields.append.label",
    type: "checkbox",
  })
  @input({ handle: "append", userControlled: true })
  append?: boolean = false;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.read_write_file.fields.createDirectories.label",
    type: "checkbox",
  })
  @input({ handle: "createDirectories", userControlled: true })
  createDirectories?: boolean = false;

  @required()
  @output({ handle: "result" })
  result!: unknown;

  @output({ handle: "bytes" })
  bytes?: number;
}
