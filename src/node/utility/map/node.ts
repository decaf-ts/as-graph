/**
 * @module as-graph/nodes/utility/map
 * @summary Map utility node declaration (DECAF-32 §22.2.2).
 * @description Map — transforms the current input into a new output object.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the map node. */
export type MapNodeInput = Record<string, unknown>;

/** Outputs produced by the map node. */
export interface MapNodeOutput {
  result: unknown;
}

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
    title: "graph.node.utility.map.name",
    description:
      "graph.node.utility.map.description",
    mapper: {},
  },
})
@model()
export class MapNode extends GraphNode<MapNodeInput, MapNodeOutput> {
  /**
   * Wraps the `value` input into the output shape `{ result: { mapped: value } }`.
   *
   * @param {GraphNodeExecutionRequest<MapNodeInput>} request - Execution request carrying the `value` input.
   * @return {GraphExecutionValues} The transformed output under `result`.
   */
  override execute(
    request: GraphNodeExecutionRequest<MapNodeInput>
  ): GraphExecutionValues {
    return { result: { mapped: request.inputs["value"] ?? request.inputs } };
  }

  /** Input value transformed into the output mapping. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.utility.map.fields.value.label",
    placeholder: "graph.node.utility.map.fields.value.placeholder",
    type: "textarea",
  })
  @input({ handle: "value" })
  value!: unknown;

  /** Output carrying the transformed mapping. */
  @required()
  @output({ handle: "result" })
  result!: unknown;
}
