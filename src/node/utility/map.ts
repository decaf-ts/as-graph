/**
 * @module as-graph/nodes/utility/map
 * @summary Map utility node declaration (DECAF-32 §22.2.2).
 * @description Map — transforms the current input into a new output object.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../shared/graph";
import { GraphNode } from "../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../engine/types";

/**
 * Map utility node: transforms the current input into a new output object.
 */
@node("core.utility.map", {
  kind: "core.utility.map",
  category: "Utility",
  color: "#0d9488",
  icon: "ti-arrows-right-left",
  width: 96,
  height: 96,
  labels: ["utility", "map", "transform"],
  metadata: {
    title: "Map",
    description:
      "Transforms the current input into a new output object using the configured mapper.",
    mapper: {},
  },
})
@model()
export class MapNode extends GraphNode {
  static override execute(request: GraphNodeExecutionRequest): GraphExecutionValues {
    return { result: { mapped: request.inputs["value"] ?? request.inputs } };
  }

  @required()
  @uielement("textarea", {
    label: "Input value",
    placeholder: "Value to transform",
  })
  @input({ handle: "value" })
  value!: unknown;

  @required()
  @uielement("input", {
    label: "Transformed output",
    placeholder: "Mapped result",
  })
  @output({ handle: "result" })
  result!: unknown;
}
