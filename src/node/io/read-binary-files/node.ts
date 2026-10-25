/**
 * @module as-graph/nodes/io/read-binary-files
 * @description Expands a glob pattern inside the configured file-IO base and
 * reads every match as a base64 `BinaryFilePayload`, returning the payloads
 * with the file count and total byte size. Path containment is enforced by
 * `file-support`.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type { GraphExecutionValues } from "../../../engine/types";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import {
  graphGlobFiles,
  readGraphFilePayload,
  type BinaryFilePayload,
} from "../file-support";

/** Inputs accepted by the Read Binary Files node (the selector is configuration, not input). */
export type ReadBinaryFilesNodeInput = Record<string, unknown>;

/** Outputs produced by the Read Binary Files node. */
export interface ReadBinaryFilesNodeOutput {
  /** Payloads read from the matching files. */
  result: BinaryFilePayload[];

  /** Number of files read. */
  files: number;

  /** Total combined size in bytes. */
  bytes: number;
}

/**
 * Read Binary Files node (`core.io.readBinaryFiles`): reads every file matching
 * a glob selector as a base64 payload.
 */
@node("core.io.readBinaryFiles", {
  kind: "core.io.readBinaryFiles",
  category: "IO",
  color: "#0ea5e9",
  icon: "ti-files",
  width: 96,
  height: 96,
  labels: ["io", "file", "binary", "glob"],
  metadata: {
    title: "graph.node.io.read_binary_files.name",
    description: "graph.node.io.read_binary_files.description",
  },
})
@model()
export class ReadBinaryFilesNode extends GraphNode<
  ReadBinaryFilesNodeInput,
  ReadBinaryFilesNodeOutput
> {
  /**
   * Reads all files matching the configured selector.
   *
   * @returns Execution values with the payloads, file count, and total bytes.
   * @throws {GraphExecutionError} `GRAPH_READ_BINARY_FILES_SELECTOR_REQUIRED`
   *   when no selector is configured (and `GRAPH_FILE_*` codes from path
   *   resolution/read).
   */
  override async execute(): Promise<GraphExecutionValues> {
    const selector = this.fileSelector || this.pattern;
    if (!selector) {
      throw new GraphExecutionError(
        "Read Binary Files node requires a file selector pattern",
        "GRAPH_READ_BINARY_FILES_SELECTOR_REQUIRED"
      );
    }
    const files = await graphGlobFiles(selector);
    const payloads: BinaryFilePayload[] = [];
    let totalBytes = 0;
    for (const file of files) {
      const { payload, bytes } = await readGraphFilePayload(file);
      payloads.push(payload);
      totalBytes += bytes;
    }
    return { result: payloads, files: payloads.length, bytes: totalBytes };
  }

  /** Unused optional input retained for node uniformity. */
  @input({ handle: "value" })
  value?: unknown;

  /** Glob pattern to expand, relative to the file-IO base. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.read_binary_files.fields.fileSelector.label",
    placeholder:
      "graph.node.io.read_binary_files.fields.fileSelector.placeholder",
    type: "text",
  })
  @input({ handle: "fileSelector", userControlled: true })
  fileSelector?: string;

  /** Alias for `fileSelector`. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.read_binary_files.fields.pattern.label",
    placeholder: "graph.node.io.read_binary_files.fields.pattern.placeholder",
    type: "text",
  })
  @input({ handle: "pattern", userControlled: true })
  pattern?: string;

  /** Read payloads. */
  @required()
  @output({ handle: "result" })
  result!: BinaryFilePayload[];

  /** Number of files read. */
  @output({ handle: "files" })
  files!: number;

  /** Total combined size in bytes. */
  @output({ handle: "bytes" })
  bytes!: number;
}
