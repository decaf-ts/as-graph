/**
 * @module as-graph/nodes/data/date-time
 * @summary Date & Time data node declaration (DECAF-746 Data family).
 * @description Date & Time — parse, format, and shift dates. `current` ignores
 * the input and uses the wall clock; `parse`/`format` convert the input with
 * `parseGraphDateValue`; `add`/`subtract` shift the parsed input by `amount` of
 * `unit` (subtract negates the amount). The value is read from the `value`
 * input port first and falls back to the configured `value` field. Every
 * operation emits three outputs: `result` (formatted with `formatGraphDate` —
 * ISO-8601 when no pattern is configured), `iso`, and the epoch `timestamp`.
 * Array input maps item by item, producing parallel arrays for all three
 * outputs — array-in, array-out.
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
  addGraphDateUnits,
  formatGraphDate,
  parseGraphDateValue,
} from "../support";

/** What the node does with its input date. */
export type DateTimeOperation =
  | "current"
  | "parse"
  | "format"
  | "add"
  | "subtract";

/** Unit for the `add`/`subtract` amount. */
export type DateTimeUnit =
  | "seconds"
  | "minutes"
  | "hours"
  | "days"
  | "weeks"
  | "months"
  | "years";

/** Inputs accepted by the Date & Time node. */
export type DateTimeNodeInput = Record<string, unknown>;

/** Outputs produced by the Date & Time node. */
export interface DateTimeNodeOutput {
  result: unknown;
  iso?: unknown;
  timestamp?: unknown;
}

/**
 * Date & Time data node: parses, formats, and shifts dates, emitting the
 * formatted result, its ISO-8601 form, and its epoch timestamp.
 */
@node("core.data.dateTime", {
  kind: "core.data.dateTime",
  category: "Data",
  color: "#8b5cf6",
  icon: "ti-calendar-time",
  width: 96,
  height: 96,
  labels: ["data", "date", "time"],
  metadata: {
    title: "graph.node.data.date_time.name",
    description: "graph.node.data.date_time.description",
  },
})
@model()
export class DateTimeNode extends GraphNode<
  DateTimeNodeInput,
  DateTimeNodeOutput
> {
  /**
   * Converts the input (or each array element) according to `operation`.
   *
   * @param request - The execution request carrying the optional `value` input.
   * @returns The `result`/`iso`/`timestamp` outputs; parallel arrays when the
   *   input was an array.
   * @throws {GraphExecutionError} with code `GRAPH_DATE_TIME_UNSUPPORTED_OPERATION`
   *   when `operation` is not a known {@link DateTimeOperation}, and code
   *   `GRAPH_DATA_INVALID_DATE` when the input cannot be parsed.
   */
  override execute(
    request: GraphNodeExecutionRequest<DateTimeNodeInput>
  ): GraphExecutionValues {
    const value = request.inputs["value"] ?? this.value;
    if (Array.isArray(value)) {
      const results = value
        .filter((item) => item !== undefined && item !== null)
        .map((item) => this.convert(item));
      return {
        result: results.map((entry) => entry.result),
        iso: results.map((entry) => entry.iso),
        timestamp: results.map((entry) => entry.timestamp),
      };
    }
    const converted = this.convert(value);
    return {
      result: converted.result,
      iso: converted.iso,
      timestamp: converted.timestamp,
    };
  }

  /**
   * Resolves one value into its date according to the configured operation and
   * formats it.
   *
   * @param value - The raw value; ignored for `current`.
   * @returns The formatted result, ISO-8601 string, and epoch timestamp.
   * @throws {GraphExecutionError} with code `GRAPH_DATE_TIME_UNSUPPORTED_OPERATION`
   *   or `GRAPH_DATA_INVALID_DATE` as described on {@linkcode DateTimeNode.execute}.
   */
  private convert(value: unknown): {
    result: string;
    iso: string;
    timestamp: number;
  } {
    let date: Date;

    switch (this.operation) {
      case "current":
        date = new Date();
        break;
      case "add":
        date = addGraphDateUnits(
          parseGraphDateValue(value),
          this.amount ?? 0,
          this.unit ?? "days"
        );
        break;
      case "subtract":
        date = addGraphDateUnits(
          parseGraphDateValue(value),
          -(this.amount ?? 0),
          this.unit ?? "days"
        );
        break;
      case "parse":
      case "format":
        date = parseGraphDateValue(value);
        break;
      default:
        throw new GraphExecutionError(
          `Unsupported Date & Time operation '${String(this.operation)}'`,
          "GRAPH_DATE_TIME_UNSUPPORTED_OPERATION",
          { operation: this.operation }
        );
    }

    return {
      result: formatGraphDate(date, this.format),
      iso: date.toISOString(),
      timestamp: date.getTime(),
    };
  }

  @input({ handle: "value" })
  value?: unknown;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.date_time.fields.operation.label",
    type: "select",
  })
  @input({ handle: "operation", userControlled: true })
  operation: DateTimeOperation = "current";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.date_time.fields.format.label",
    placeholder: "graph.node.data.date_time.fields.format.placeholder",
    type: "text",
  })
  @input({ handle: "format", userControlled: true })
  format?: string;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.date_time.fields.amount.label",
    type: "number",
  })
  @input({ handle: "amount", userControlled: true })
  amount?: number = 0;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.data.date_time.fields.unit.label",
    type: "select",
  })
  @input({ handle: "unit", userControlled: true })
  unit: DateTimeUnit = "days";

  @required()
  @output({ handle: "result" })
  result!: unknown;

  @output({ handle: "iso" })
  iso?: string;

  @output({ handle: "timestamp" })
  timestamp?: number;
}
