/**
 * @module as-graph/nodes/io/read-pdf
 * @summary Read PDF IO node declaration (DECAF-746 IO family).
 * @description Read PDF — extract text from a PDF payload. The `value` input
 * is normalized into a `Buffer` (raw string, data URL, base64/utf8 string per
 * `encoding`, a record's `data`/`content` field, or a binary payload) and
 * parsed through the `pdf-parse` dependency, loaded lazily so the dependency
 * is only required when the node actually runs. Extraction can be guarded
 * with `password`. The full text is emitted under `result` and the per-page
 * text under `pages` (1-based `pageNumber`s). The parser instance is always
 * destroyed, even on failure.
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
import { isBinaryGraphDataPayload, isGraphDataRecord } from "../../data/support";

/** Encoding of the incoming string payload. */
export type ReadPDFEncoding = "utf8" | "base64";

/** Inputs accepted by the Read PDF node. */
export type ReadPDFNodeInput = Record<string, unknown>;

/** Text extracted from a single PDF page. */
export interface ReadPDFPage {
  /** 1-based page number. */
  pageNumber: number;
  /** The page's extracted text. */
  text: string;
}

/** Outputs produced by the Read PDF node. */
export interface ReadPDFNodeOutput {
  result: string;
  pages?: ReadPDFPage[];
}

/**
 * Normalizes the incoming payload into a PDF `Buffer`.
 *
 * Data-URL strings are always decoded as base64; record payloads are
 * unwrapped from their `data`/`content` field first.
 *
 * @param value - The raw input payload.
 * @param encoding - Encoding to apply to plain string payloads.
 * @returns The PDF bytes.
 * @throws {GraphExecutionError} with code `GRAPH_READ_PDF_INVALID_INPUT` when
 *   the payload is not a decodable string, record, or binary value.
 */
function pdfBufferOf(value: unknown, encoding: ReadPDFEncoding): Buffer {
  if (typeof value === "string") {
    if (value.startsWith("data:")) {
      const comma = value.indexOf(",");
      return Buffer.from(value.slice(comma + 1), "base64");
    }
    return encoding === "base64"
      ? Buffer.from(value, "base64")
      : Buffer.from(value, "utf8");
  }
  if (isGraphDataRecord(value)) {
    const content = value["data"] ?? value["content"];
    if (content !== undefined) return pdfBufferOf(content, encoding);
  }
  if (isBinaryGraphDataPayload(value)) {
    return Buffer.isBuffer(value)
      ? value
      : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  }
  throw new GraphExecutionError(
    "Read PDF node requires a PDF file payload",
    "GRAPH_READ_PDF_INVALID_INPUT",
    { valueType: typeof value }
  );
}

/**
 * Read PDF IO node: extracts text (full document and per page) from a PDF
 * payload via the lazily loaded `pdf-parse` dependency.
 */
@node("core.io.readPDF", {
  kind: "core.io.readPDF",
  category: "IO",
  color: "#0ea5e9",
  icon: "ti-file-type-pdf",
  width: 96,
  height: 96,
  labels: ["io", "pdf", "extract"],
  metadata: {
    title: "graph.node.io.read_pdf.name",
    description: "graph.node.io.read_pdf.description",
  },
})
@model()
export class ReadPDFNode extends GraphNode<
  ReadPDFNodeInput,
  ReadPDFNodeOutput
> {
  /**
   * Normalizes the payload, parses the PDF, and extracts its text.
   *
   * @param request - The execution request carrying the `value` payload.
   * @returns The full text under `result` and the per-page text under `pages`.
   * @throws {GraphExecutionError} with code `GRAPH_READ_PDF_INVALID_INPUT`
   *   when the payload cannot be decoded, `GRAPH_READ_PDF_DEPENDENCY_MISSING`
   *   when `pdf-parse` is not installed or does not expose a parser, and
   *   `GRAPH_READ_PDF_FAILED` when extraction fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<ReadPDFNodeInput>
  ): Promise<GraphExecutionValues> {
    const data = pdfBufferOf(request.inputs["value"], this.encoding ?? "utf8");

    let parse: typeof import("pdf-parse");
    try {
      parse = await import("pdf-parse");
    } catch (error) {
      throw new GraphExecutionError(
        `Read PDF node requires the 'pdf-parse' dependency: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_READ_PDF_DEPENDENCY_MISSING"
      );
    }

    const PDFParse = (parse as { PDFParse?: new (options: unknown) => unknown })
      .PDFParse;
    if (!PDFParse) {
      throw new GraphExecutionError(
        "Read PDF node could not resolve the PDF parser",
        "GRAPH_READ_PDF_DEPENDENCY_MISSING"
      );
    }

    const parser = new PDFParse({
      data,
      ...(this.password ? { password: this.password } : {}),
    }) as {
      getText: () => Promise<{
        text?: string;
        pages?: { text?: string }[];
      }>;
      destroy?: () => Promise<void>;
    };

    try {
      const parsed = await parser.getText();
      const text = parsed.text ?? "";
      const pages = (parsed.pages ?? []).map((page, index) => ({
        pageNumber: index + 1,
        text: page.text ?? "",
      }));
      return { result: text, pages };
    } catch (error) {
      throw new GraphExecutionError(
        `Read PDF node failed to extract text: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_READ_PDF_FAILED"
      );
    } finally {
      await parser.destroy?.();
    }
  }

  @required()
  @input({ handle: "value" })
  value!: unknown;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.read_pdf.fields.encoding.label",
    type: "select",
  })
  @input({ handle: "encoding", userControlled: true })
  encoding: ReadPDFEncoding = "utf8";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.read_pdf.fields.password.label",
    placeholder: "graph.node.io.read_pdf.fields.password.placeholder",
    type: "password",
  })
  @input({ handle: "password", userControlled: true })
  password?: string;

  @required()
  @output({ handle: "result" })
  result!: string;

  @output({ handle: "pages" })
  pages?: ReadPDFPage[];
}
