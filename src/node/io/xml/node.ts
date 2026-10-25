/**
 * @module as-graph/nodes/io/xml
 * @description Converts XML text to JSON with `xml2js` `Parser` or JSON data to
 * XML with `Builder`. XML input may be a string, a field of a graph record, or
 * a base64/UTF-8 binary payload. Attribute and character keys, array/root
 * handling, namespaces/whitespace normalization, CDATA, and the root element
 * name are configurable; the result can be nested under `destinationField`.
 * Before parsing, `xmlToJson` rejects entity declarations
 * (`GRAPH_XML_ENTITY_FORBIDDEN`) and inputs larger than 10 MiB
 * (`GRAPH_XML_INPUT_TOO_LARGE`).
 */
import { Builder, Parser } from "xml2js";
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
  getGraphDataValue,
  isGraphDataRecord,
  setGraphDataValue,
} from "../../data/support";
import { binaryBufferOf } from "../file-support";

/** Conversion direction. */
export type XmlMode = "jsonToXml" | "xmlToJson";

/** Maximum accepted XML input size, in bytes. */
const MAX_XML_INPUT_BYTES = 10 * 1024 * 1024;

/** Entity declarations are rejected before parsing (case-insensitive). */
const XML_ENTITY_DECLARATION_PATTERN = /<!ENTITY/i;

/** Inputs accepted by the XML node; `value` carries the XML text or JSON data. */
export type XmlNodeInput = Record<string, unknown>;

/** Outputs produced by the XML node. */
export interface XmlNodeOutput {
  /** Parsed JSON data or the built XML string (optionally nested under `destinationField`). */
  result: unknown;
}

/**
 * XML node (`core.io.xml`): parses XML into JSON or builds XML from JSON with
 * configurable `xml2js` parser/builder options.
 */
@node("core.io.xml", {
  kind: "core.io.xml",
  category: "IO",
  color: "#0ea5e9",
  icon: "ti-code",
  width: 96,
  height: 96,
  labels: ["io", "xml", "json", "convert"],
  metadata: {
    title: "graph.node.io.xml.name",
    description: "graph.node.io.xml.description",
  },
})
@model()
export class XmlNode extends GraphNode<XmlNodeInput, XmlNodeOutput> {
  /**
   * Runs the configured XML conversion.
   *
   * @param request - Execution request; `inputs.value` carries the source data.
   * @returns Execution values with the parsed JSON or generated XML `result`.
   * @throws {GraphExecutionError} `GRAPH_XML_PARSE_FAILED` when XML parsing
   *   fails, `GRAPH_XML_INVALID_INPUT` when the source cannot be read,
   *   `GRAPH_XML_ENTITY_FORBIDDEN` when the input declares XML entities,
   *   `GRAPH_XML_INPUT_TOO_LARGE` when the input exceeds the 10 MB limit, or
   *   `GRAPH_XML_BUILD_FAILED` when building XML fails.
   */
  override async execute(
    request: GraphNodeExecutionRequest<XmlNodeInput>
  ): Promise<GraphExecutionValues> {
    const input = request.inputs["value"];
    if (this.mode === "xmlToJson") {
      const text = this.xmlTextOf(input);
      const byteLength = Buffer.byteLength(text, "utf8");
      if (byteLength > MAX_XML_INPUT_BYTES) {
        throw new GraphExecutionError(
          `XML input of ${byteLength} bytes exceeds the ${MAX_XML_INPUT_BYTES}-byte limit`,
          "GRAPH_XML_INPUT_TOO_LARGE",
          { byteLength, maxBytes: MAX_XML_INPUT_BYTES }
        );
      }
      if (XML_ENTITY_DECLARATION_PATTERN.test(text)) {
        throw new GraphExecutionError(
          "XML input entity declarations are not allowed",
          "GRAPH_XML_ENTITY_FORBIDDEN"
        );
      }
      const parser = new Parser({
        attrkey: this.attrkey || "$",
        charkey: this.charkey || "_",
        explicitArray: this.explicitArray === true,
        explicitRoot: this.explicitRoot !== false,
        ignoreAttrs: this.ignoreAttrs === true,
        mergeAttrs: this.mergeAttrs !== false,
        normalize: this.normalize === true,
        normalizeTags: this.normalizeTags === true,
        trim: this.trim === true,
      });
      try {
        const parsed = await parser.parseStringPromise(text);
        return { result: this.wrap(parsed) };
      } catch (error) {
        throw new GraphExecutionError(
          `XML node could not parse XML: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "GRAPH_XML_PARSE_FAILED"
        );
      }
    }

    const source = input;
    if (source === undefined || source === null) {
      throw new GraphExecutionError(
        "XML node requires JSON data to convert",
        "GRAPH_XML_INVALID_INPUT"
      );
    }
    const builder = new Builder({
      attrkey: this.attrkey || "$",
      charkey: this.charkey || "_",
      headless: this.headless === true,
      rootName: this.rootName || "root",
      cdata: this.cdata === true,
      allowSurrogateChars: this.allowSurrogateChars === true,
    });
    try {
      return { result: this.wrap(builder.buildObject(source)) };
    } catch (error) {
      throw new GraphExecutionError(
        `XML node could not build XML: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_XML_BUILD_FAILED"
      );
    }
  }

  private wrap(value: unknown): unknown {
    if (!this.destinationField) return value;
    const result: Record<string, unknown> = {};
    setGraphDataValue(result, this.destinationField, value, true);
    return result;
  }

  private xmlTextOf(value: unknown): string {
    if (typeof value === "string") return value;
    if (isGraphDataRecord(value)) {
      const selected = this.dataPropertyName
        ? getGraphDataValue(value, this.dataPropertyName, true)
        : undefined;
      if (typeof selected === "string") return selected;
    }
    try {
      return binaryBufferOf(
        value,
        "utf8",
        this.dataPropertyName || "data"
      ).toString("utf8");
    } catch {
      throw new GraphExecutionError(
        "XML node requires XML text to parse",
        "GRAPH_XML_INVALID_INPUT"
      );
    }
  }

  /** XML text, a record containing it, or JSON data to serialize. */
  @required()
  @input({ handle: "value" })
  value!: unknown;

  /** Conversion direction (default `xmlToJson`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.mode.label",
    type: "select",
  })
  @input({ handle: "mode", userControlled: true })
  mode: XmlMode = "xmlToJson";

  /** Record field holding the XML text or binary payload (default `data`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.dataPropertyName.label",
    placeholder: "graph.node.io.xml.fields.dataPropertyName.placeholder",
    type: "text",
  })
  @input({ handle: "dataPropertyName", userControlled: true })
  dataPropertyName: string = "data";

  /** Wrap the conversion result under this record key. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.destinationField.label",
    placeholder: "graph.node.io.xml.fields.destinationField.placeholder",
    type: "text",
  })
  @input({ handle: "destinationField", userControlled: true })
  destinationField?: string;

  /** Key used for XML attributes (default `$`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.attrkey.label",
    type: "text",
  })
  @input({ handle: "attrkey", userControlled: true })
  attrkey?: string = "$";

  /** Key used for element character data (default `_`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.charkey.label",
    type: "text",
  })
  @input({ handle: "charkey", userControlled: true })
  charkey?: string = "_";

  /** Always wrap child elements in arrays (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.explicitArray.label",
    type: "checkbox",
  })
  @input({ handle: "explicitArray", userControlled: true })
  explicitArray?: boolean = false;

  /** Include the root element in parsed output (default `true`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.explicitRoot.label",
    type: "checkbox",
  })
  @input({ handle: "explicitRoot", userControlled: true })
  explicitRoot?: boolean = true;

  /** Ignore attributes while parsing (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.ignoreAttrs.label",
    type: "checkbox",
  })
  @input({ handle: "ignoreAttrs", userControlled: true })
  ignoreAttrs?: boolean = false;

  /** Merge attributes into their element instead of using `attrkey` (default `true`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.mergeAttrs.label",
    type: "checkbox",
  })
  @input({ handle: "mergeAttrs", userControlled: true })
  mergeAttrs?: boolean = true;

  /** Normalize whitespace in text nodes (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.normalize.label",
    type: "checkbox",
  })
  @input({ handle: "normalize", userControlled: true })
  normalize?: boolean = false;

  /** Lowercase tag names while parsing (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.normalizeTags.label",
    type: "checkbox",
  })
  @input({ handle: "normalizeTags", userControlled: true })
  normalizeTags?: boolean = false;

  /** Trim whitespace in text nodes (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.trim.label",
    type: "checkbox",
  })
  @input({ handle: "trim", userControlled: true })
  trim?: boolean = false;

  /** Wrap text values in CDATA when building XML (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.cdata.label",
    type: "checkbox",
  })
  @input({ handle: "cdata", userControlled: true })
  cdata?: boolean = false;

  /** Omit the XML declaration when building XML (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.headless.label",
    type: "checkbox",
  })
  @input({ handle: "headless", userControlled: true })
  headless?: boolean = false;

  /** Root element name used when building XML (default `root`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.rootName.label",
    type: "text",
  })
  @input({ handle: "rootName", userControlled: true })
  rootName?: string = "root";

  /** Allow surrogate characters when building XML (default `false`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.io.xml.fields.allowSurrogateChars.label",
    type: "checkbox",
  })
  @input({ handle: "allowSurrogateChars", userControlled: true })
  allowSurrogateChars?: boolean = false;

  /** Conversion result. */
  @required()
  @output({ handle: "result" })
  result!: unknown;
}
