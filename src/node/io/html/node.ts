/**
 * @module as-graph/nodes/io/html
 * @description HTML node with three operations: render a `{{path}}` template
 * against the input (an array input renders one document per item), extract
 * values from HTML using CSS selectors (see `HtmlExtractionValue`), and convert
 * item data into an HTML table. Extraction accepts JSON, text, or base64 binary
 * input and is backed by the helpers in `html-support`.
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
  asGraphDataArray,
  getGraphDataValue,
  isGraphDataRecord,
} from "../../data/support";
import { binaryBufferOf } from "../file-support";
import {
  extractHtmlValues,
  graphDataToHtmlTable,
  htmlDocumentOf,
  renderHtmlTemplate,
  type HtmlExtractionValue,
} from "../html-support";

/** HTML operation: template rendering, content extraction, or table generation. */
export type HtmlOperation =
  | "generateHtmlTemplate"
  | "extractHtmlContent"
  | "convertToHtmlTable";

/** How extraction reads its input: graph data/JSON or a base64 binary payload. */
export type HtmlSourceData = "json" | "binary";

/** Inputs accepted by the HTML node; `value` carries the source data. */
export type HtmlNodeInput = Record<string, unknown>;

/** Outputs produced by the HTML node. */
export interface HtmlNodeOutput {
  /** Rendered document(s), extracted record(s), or the generated table. */
  result: unknown;

  /** Generated HTML table (`convertToHtmlTable` only). */
  table?: string;
}

/**
 * HTML node (`core.io.html`): renders templates, extracts CSS-selected values,
 * and converts item data to an HTML table.
 */
@node("core.io.html", {
  kind: "core.io.html",
  category: "IO",
  color: "#0ea5e9",
  icon: "ti-brand-html5",
  width: 96,
  height: 96,
  labels: ["io", "html", "template", "table"],
  metadata: {
    title: "graph.node.io.html.name",
    description: "graph.node.io.html.description",
  },
})
@model()
export class HtmlNode extends GraphNode<HtmlNodeInput, HtmlNodeOutput> {
  /**
   * Runs the configured HTML operation.
   *
   * @param request - Execution request; `inputs.value` carries the source data.
   * @returns Execution values with the rendered, extracted, or tabular `result`
   *   and, for `convertToHtmlTable`, the `table` string.
   * @throws {GraphExecutionError} `GRAPH_HTML_INVALID_INPUT` when extraction has
   *   no document, `GRAPH_HTML_EXTRACT_VALUES_REQUIRED` when no CSS selector is
   *   configured, or `GRAPH_HTML_TEMPLATE_REQUIRED` when template rendering has
   *   no template.
   */
  override execute(
    request: GraphNodeExecutionRequest<HtmlNodeInput>
  ): GraphExecutionValues {
    const input = request.inputs["value"];
    switch (this.operation) {
      case "extractHtmlContent": {
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
            "HTML node requires HTML content to extract",
            "GRAPH_HTML_INVALID_INPUT"
          );
        }
        const values = (this.extractionValues ?? []).filter(
          (entry) => entry && typeof entry.cssSelector === "string"
        );
        if (values.length === 0) {
          throw new GraphExecutionError(
            "HTML node requires at least one extraction value",
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
      case "convertToHtmlTable": {
        const table = graphDataToHtmlTable(asGraphDataArray(input), {
          caption: this.caption,
          tableAttributes: this.tableAttributes,
          headerAttributes: this.headerAttributes,
          rowAttributes: this.rowAttributes,
          cellAttributes: this.cellAttributes,
          customStyling: this.customStyling === true,
          capitalize: this.capitalize === true,
        });
        return { result: table, table };
      }
      case "generateHtmlTemplate":
      default: {
        if (!this.html) {
          throw new GraphExecutionError(
            "HTML node requires a template to render",
            "GRAPH_HTML_TEMPLATE_REQUIRED"
          );
        }
        if (Array.isArray(input)) {
          return {
            result: input
              .filter((entry) => entry !== undefined && entry !== null)
              .map((entry) => renderHtmlTemplate(this.html as string, entry)),
          };
        }
        return { result: renderHtmlTemplate(this.html, input) };
      }
    }
  }

  /** Source data: template context, JSON/text HTML, or a base64 binary payload. */
  @input({ handle: "value" })
  value?: unknown;

  /** Operation to perform (default `generateHtmlTemplate`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: HtmlOperation = "generateHtmlTemplate";

  /** Template source containing `{{path}}` placeholders. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html.fields.html.label",
    type: "textarea",
  })
  @input({ handle: "html", userControlled: true })
  html?: string;

  /** Extraction input kind (default `json`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html.fields.sourceData.label",
    type: "select",
  })
  @input({ handle: "sourceData", userControlled: true })
  sourceData: HtmlSourceData = "json";

  /** Field holding the HTML document or base64 payload (default `data`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html.fields.dataPropertyName.label",
    placeholder: "graph.node.io.html.fields.dataPropertyName.placeholder",
    type: "text",
  })
  @input({ handle: "dataPropertyName", userControlled: true })
  dataPropertyName: string = "data";

  /** CSS-selector extraction rules applied to each document. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html.fields.extractionValues.label",
    placeholder: "graph.node.io.html.fields.extractionValues.placeholder",
    type: "collection",
  })
  @input({ handle: "extractionValues", userControlled: true, type: "array" })
  extractionValues?: HtmlExtractionValue[] = [];

  /** Trim extracted values (default `true`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html.fields.trimValues.label",
    type: "checkbox",
  })
  @input({ handle: "trimValues", userControlled: true })
  trimValues?: boolean = true;

  /** Collapse whitespace and newlines in extracted text (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html.fields.cleanUpText.label",
    type: "checkbox",
  })
  @input({ handle: "cleanUpText", userControlled: true })
  cleanUpText?: boolean = false;

  /** Caption for the generated HTML table. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html.fields.caption.label",
    type: "text",
  })
  @input({ handle: "caption", userControlled: true })
  caption?: string;

  /** Extra attributes appended to the generated `<table>` tag. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html.fields.tableAttributes.label",
    type: "text",
  })
  @input({ handle: "tableAttributes", userControlled: true })
  tableAttributes?: string;

  /** Extra attributes appended to the generated `<thead>` tag. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html.fields.headerAttributes.label",
    type: "text",
  })
  @input({ handle: "headerAttributes", userControlled: true })
  headerAttributes?: string;

  /** Extra attributes appended to every generated `<tr>` tag. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html.fields.rowAttributes.label",
    type: "text",
  })
  @input({ handle: "rowAttributes", userControlled: true })
  rowAttributes?: string;

  /** Extra attributes appended to every generated `<td>` tag. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html.fields.cellAttributes.label",
    type: "text",
  })
  @input({ handle: "cellAttributes", userControlled: true })
  cellAttributes?: string;

  /** Omit the default inline table styles (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html.fields.customStyling.label",
    type: "checkbox",
  })
  @input({ handle: "customStyling", userControlled: true })
  customStyling?: boolean = false;

  /** Capitalize and humanize table headers (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.html.fields.capitalize.label",
    type: "checkbox",
  })
  @input({ handle: "capitalize", userControlled: true })
  capitalize?: boolean = false;

  /** Operation result. */
  @required()
  @output({ handle: "result" })
  result!: unknown;

  /** Generated table (`convertToHtmlTable` only). */
  @output({ handle: "table" })
  table?: string;
}
