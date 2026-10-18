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
import { dirname } from "node:path";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";

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

    if (this.operation === "read") {
      const content = await readFile(this.path);
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

    if (this.createDirectories) {
      await mkdir(dirname(this.path), { recursive: true });
    }
    if (this.append) {
      await appendFile(this.path, data);
    } else {
      await writeFile(this.path, data);
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
