/**
 * @module as-graph/nodes/io/read-binary-file
 * @description Reads one file from the configured file-IO base and returns it as
 * a base64 `BinaryFilePayload` with its file name, MIME type, and byte length.
 * Path resolution and containment checks are enforced by `file-support`.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type { GraphExecutionValues } from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import {
  readGraphFilePayload,
  type BinaryFilePayload,
} from "../file-support";

/** Inputs accepted by the Read Binary File node (the path is configuration, not input). */
export type ReadBinaryFileNodeInput = Record<string, unknown>;

/** Outputs produced by the Read Binary File node. */
export interface ReadBinaryFileNodeOutput {
  /** Read payload. */
  result: BinaryFilePayload;

  /** Base file name of the read file. */
  fileName: string;

  /** MIME type inferred from the file extension. */
  mimeType: string;

  /** File size in bytes. */
  bytes: number;
}

/**
 * Read Binary File node (`core.io.readBinaryFile`): reads one file as a
 * base64 payload.
 */
@node("core.io.readBinaryFile", {
  kind: "core.io.readBinaryFile",
  category: "IO",
  color: "#0ea5e9",
  icon: "ti-file-download",
  width: 96,
  height: 96,
  labels: ["io", "file", "binary", "read"],
  metadata: {
    title: "graph.node.io.read_binary_file.name",
    description: "graph.node.io.read_binary_file.description",
  },
})
@model()
export class ReadBinaryFileNode extends GraphNode<
  ReadBinaryFileNodeInput,
  ReadBinaryFileNodeOutput
> {
  /**
   * Reads the configured file.
   *
   * @returns Execution values with the payload and its file name, MIME type,
   *   and byte count.
   * @throws {GraphExecutionError} `GRAPH_READ_BINARY_FILE_PATH_REQUIRED` when no
   *   path is configured (and `GRAPH_FILE_*` codes from path resolution/read).
   */
  override async execute(): Promise<GraphExecutionValues> {
    const configured = this.filePath || this.path;
    if (!configured) {
      throw new GraphExecutionError(
        "Read Binary File node requires a file path",
        "GRAPH_READ_BINARY_FILE_PATH_REQUIRED"
      );
    }
    const { payload, bytes } = await readGraphFilePayload(configured);
    return {
      result: payload,
      fileName: payload.fileName,
      mimeType: payload.mimeType,
      bytes,
    };
  }

  /** Unused optional input retained for node uniformity. */
  @input({ handle: "value" })
  value?: unknown;

  /** File path to read (relative to the file-IO base). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.read_binary_file.fields.filePath.label",
    placeholder: "graph.node.io.read_binary_file.fields.filePath.placeholder",
    type: "text",
  })
  @input({ handle: "filePath", userControlled: true })
  filePath?: string;

  /** Alias for `filePath`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.read_binary_file.fields.path.label",
    placeholder: "graph.node.io.read_binary_file.fields.path.placeholder",
    type: "text",
  })
  @input({ handle: "path", userControlled: true })
  path?: string;

  /** Read payload. */
  @required()
  @output({ handle: "result" })
  result!: BinaryFilePayload;

  /** Base file name. */
  @output({ handle: "fileName" })
  fileName!: string;

  /** Inferred MIME type. */
  @output({ handle: "mimeType" })
  mimeType!: string;

  /** File size in bytes. */
  @output({ handle: "bytes" })
  bytes!: number;
}
