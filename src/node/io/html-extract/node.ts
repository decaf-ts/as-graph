/**
 * @module as-graph/nodes/io/html-extract
 * @description Extracts values from one or more HTML documents with CSS
 * selectors. Input may be a graph record (its `dataPropertyName` field or the
 * record itself), raw HTML/text, an array of documents, or a base64 binary
 * payload. Each document produces one record keyed by the configured
 * extraction keys; see `extractHtmlValues` in `html-support`.
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
import { getGraphDataValue, isGraphDataRecord } from "../../data/support";
import { binaryBufferOf } from "../file-support";
import {
  extractHtmlValues,
  htmlDocumentOf,
  type HtmlExtractionValue,
} from "../html-support";

/** How the node reads its input: graph data/JSON or a base64 binary payload. */
export type HtmlExtractSource = "json" | "binary";

/** Inputs accepted by the HTML Extract node; `value` carries the source document(s). */
export type HtmlExtractNodeInput = Record<string, unknown>;

/** Outputs produced by the HTML Extract node. */
export interface HtmlExtractNodeOutput {
  /** One extraction record per input document. */
  result: Record<string, unknown>[];
}

/**
 * HTML Extract node (`core.io.htmlExtract`): applies CSS-selector extraction
 * rules to each HTML document and returns one record per document.
 */
@node("core.io.htmlExtract", {
  kind: "core.io.htmlExtract",
  category: "IO",
  color: "#0ea5e9",
  icon: "ti-cut",
  width: 96,
  height: 96,
  labels: ["io", "html", "extract", "css"],
  metadata: {
    title: "graph.node.io.html_extract.name",
    description: "graph.node.io.html_extract.description",
  },
})
@model()
export class HtmlExtractNode extends GraphNode<
  HtmlExtractNodeInput,
  HtmlExtractNodeOutput
> {
  /**
   * Extracts values from the input document(s).
   *
   * @param request - Execution request; `inputs.value` carries the document(s).
   * @returns Execution values with the per-document extraction records.
   * @throws {GraphExecutionError} `GRAPH_HTML_EXTRACT_INVALID_INPUT` when no
   *   document can be read, or `GRAPH_HTML_EXTRACT_VALUES_REQUIRED` when no CSS
   *   selector is configured.
   */
  override execute(
    request: GraphNodeExecutionRequest<HtmlExtractNodeInput>
  ): GraphExecutionValues {
    const input = request.inputs["value"];
    const dataPropertyName = this.dataPropertyName || "data";
    let documents: string[];

    if (this.sourceData === "binary") {
      documents = [
        binaryBufferOf(input, "base64", dataPropertyName).toString("utf8"),
      ];
    } else if (isGraphDataRecord(input)) {
      const selected = getGraphDataValue(input, dataPropertyName, true);
      documents = htmlDocumentOf(selected ?? input);
    } else {
      documents = htmlDocumentOf(input);
    }

    if (documents.length === 0) {
      throw new GraphExecutionError(
        "HTML Extract node requires HTML content",
        "GRAPH_HTML_EXTRACT_INVALID_INPUT"
      );
    }

    const values = (this.extractionValues ?? []).filter(
      (entry) => entry && typeof entry.cssSelector === "string"
    );
    if (values.length === 0) {
      throw new GraphExecutionError(
        "HTML Extract node requires at least one extraction value",
        "GRAPH_HTML_EXTRACT_VALUES_REQUIRED"
      );
    }

    return {
      result: documents.map((document) =>
        extractHtmlValues(document, values, {
          trimValues: this.trimValues !== false,
          cleanUpText: this.cleanUpText === true,
        })
      ),
    };
  }

  /** HTML document(s) or a record/payload containing them. */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** Input kind (default `json`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html_extract.fields.sourceData.label",
    type: "select",
  })
  @input({ handle: "sourceData", userControlled: true })
  sourceData: HtmlExtractSource = "json";

  /** Field holding the HTML document or base64 payload (default `data`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html_extract.fields.dataPropertyName.label",
    placeholder:
      "graph.node.io.html_extract.fields.dataPropertyName.placeholder",
    type: "text",
  })
  @input({ handle: "dataPropertyName", userControlled: true })
  dataPropertyName: string = "data";

  /** CSS-selector extraction rules; entries without a `cssSelector` are ignored. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html_extract.fields.extractionValues.label",
    placeholder:
      "graph.node.io.html_extract.fields.extractionValues.placeholder",
    type: "collection",
  })
  @input({ handle: "extractionValues", userControlled: true, type: "array" })
  extractionValues?: HtmlExtractionValue[] = [];

  /** Trim extracted values (default `true`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html_extract.fields.trimValues.label",
    type: "checkbox",
  })
  @input({ handle: "trimValues", userControlled: true })
  trimValues?: boolean = true;

  /** Collapse whitespace and newlines in extracted text (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html_extract.fields.cleanUpText.label",
    type: "checkbox",
  })
  @input({ handle: "cleanUpText", userControlled: true })
  cleanUpText?: boolean = false;

  /** Extraction records. */
  @required()
  @output({ handle: "result" })
  result!: Record<string, unknown>[];
}
