/**
 * @module as-graph/nodes/io/write-binary-file
 * @description Writes the `value` input to a file inside the configured file-IO
 * base. The input may be a string, `Buffer`/`Uint8Array`, or a record carrying
 * the payload; the encoding can be `utf8`, `base64`, or `auto`. Parent
 * directories are created by default and appending is optional. Path
 * containment is enforced by `file-support`.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import {
  binaryBufferOf,
  writeGraphFile,
  type GraphBinaryEncoding,
} from "../file-support";

/** Inputs accepted by the Write Binary File node; `value` carries the payload. */
export type WriteBinaryFileNodeInput = Record<string, unknown>;

/** Outputs produced by the Write Binary File node. */
export interface WriteBinaryFileNodeOutput {
  /** Write summary with the configured name, resolved path, and byte count. */
  result: { fileName: string; path: string; bytes: number };

  /** Bytes written. */
  bytes: number;
}

/**
 * Write Binary File node (`core.io.writeBinaryFile`): decodes the input payload
 * and writes it to the configured file.
 */
@node("core.io.writeBinaryFile", {
  kind: "core.io.writeBinaryFile",
  category: "IO",
  color: "#0ea5e9",
  icon: "ti-file-upload",
  width: 96,
  height: 96,
  labels: ["io", "file", "binary", "write"],
  metadata: {
    title: "graph.node.io.write_binary_file.name",
    description: "graph.node.io.write_binary_file.description",
  },
})
@model()
export class WriteBinaryFileNode extends GraphNode<
  WriteBinaryFileNodeInput,
  WriteBinaryFileNodeOutput
> {
  /**
   * Writes the input payload to the configured file.
   *
   * @param request - Execution request; `inputs.value` carries the payload.
   * @returns Execution values with the write summary and byte count.
   * @throws {GraphExecutionError} `GRAPH_WRITE_BINARY_FILE_PATH_REQUIRED` when no
   *   path is configured, `GRAPH_WRITE_BINARY_FILE_CONTENT_REQUIRED` when the
   *   value is nil, or `GRAPH_BINARY_INPUT_REQUIRED` when the value cannot be
   *   decoded.
   */
  override async execute(
    request: GraphNodeExecutionRequest<WriteBinaryFileNodeInput>
  ): Promise<GraphExecutionValues> {
    const configured = this.fileName || this.path;
    if (!configured) {
      throw new GraphExecutionError(
        "Write Binary File node requires a file path",
        "GRAPH_WRITE_BINARY_FILE_PATH_REQUIRED"
      );
    }
    const value = request.inputs["value"];
    if (value === undefined || value === null) {
      throw new GraphExecutionError(
        "Write Binary File node requires a binary payload",
        "GRAPH_WRITE_BINARY_FILE_CONTENT_REQUIRED"
      );
    }
    const data = binaryBufferOf(
      value,
      this.encoding ?? "utf8",
      this.dataPropertyName || "data"
    );
    const written = await writeGraphFile(configured, data, {
      append: this.append === true,
      createDirectories: this.createDirectories !== false,
    });
    return {
      result: {
        fileName: configured,
        path: written.path,
        bytes: written.bytes,
      },
      bytes: written.bytes,
    };
  }

  /** Payload to write (string, binary buffer, or record containing it). */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** Target file path/name (relative to the file-IO base). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.write_binary_file.fields.fileName.label",
    placeholder: "graph.node.io.write_binary_file.fields.fileName.placeholder",
    type: "text",
  })
  @input({ handle: "fileName", userControlled: true })
  fileName?: string;

  /** Alias for `fileName`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.write_binary_file.fields.path.label",
    placeholder: "graph.node.io.write_binary_file.fields.path.placeholder",
    type: "text",
  })
  @input({ handle: "path", userControlled: true })
  path?: string;

  /** Record field holding the payload (default `data`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.write_binary_file.fields.dataPropertyName.label",
    type: "text",
  })
  @input({ handle: "dataPropertyName", userControlled: true })
  dataPropertyName: string = "data";

  /** Input decoding mode (default `auto`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.write_binary_file.fields.encoding.label",
    type: "select",
  })
  @input({ handle: "encoding", userControlled: true })
  encoding: GraphBinaryEncoding = "auto";

  /** Append instead of replacing the target file (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.write_binary_file.fields.append.label",
    type: "checkbox",
  })
  @input({ handle: "append", userControlled: true })
  append?: boolean = false;

  /** Create missing parent directories (default `true`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.write_binary_file.fields.createDirectories.label",
    type: "checkbox",
  })
  @input({ handle: "createDirectories", userControlled: true })
  createDirectories?: boolean = true;

  /** Write summary. */
  @required()
  @output({ handle: "result" })
  result!: { fileName: string; path: string; bytes: number };

  /** Bytes written. */
  @output({ handle: "bytes" })
  bytes!: number;
}
