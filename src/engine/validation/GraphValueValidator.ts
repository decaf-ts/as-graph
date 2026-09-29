/**
 * @module as-graph/validation/GraphValueValidator
 * @summary Validates runtime values against graph port definitions.
 * @description Validates workflow inputs/outputs and node inputs/outputs using the schema resolver.
 */
import type {
  GraphNodeDefinition,
  GraphPortDefinition,
  GraphWorkflowDefinition,
} from "../../shared/graph";

import { GraphInputError } from "../errors/GraphInputError";
import type { GraphPortSchemaResolver } from "./GraphPortSchemaResolver";
import type { GraphExecutionValues } from "../types";

/**
 * Validates runtime values against port definitions.
 */
export class GraphValueValidator {
  constructor(private readonly resolver: GraphPortSchemaResolver) {}

  /** Validates workflow-level input values. */
  validateWorkflowInputs(
    workflow: GraphWorkflowDefinition,
    values: GraphExecutionValues
  ): void {
    this.validatePorts(workflow.inputs, values, "workflow input");
  }

  /** Validates workflow-level output values. */
  validateWorkflowOutputs(
    workflow: GraphWorkflowDefinition,
    values: GraphExecutionValues
  ): void {
    this.validatePorts(workflow.outputs, values, "workflow output");
  }

  /** Validates a node's input values. */
  validateNodeInputs(
    node: GraphNodeDefinition,
    values: GraphExecutionValues
  ): void {
    const inputPorts = (node.ports ?? []).filter(
      (p) => p.direction === "input"
    );
    this.validatePorts(inputPorts, values, `node '${node.name}' input`);
  }

  /** Validates a node's output values. */
  validateNodeOutputs(
    node: GraphNodeDefinition,
    values: GraphExecutionValues
  ): void {
    const outputPorts = (node.ports ?? []).filter(
      (p) => p.direction === "output"
    );
    this.validatePorts(outputPorts, values, `node '${node.name}' output`);
  }

  /**
   * Validates values against a set of port definitions.
   */
  private validatePorts(
    ports: GraphPortDefinition[] | undefined,
    values: GraphExecutionValues,
    context: string
  ): void {
    if (!ports) return;
    for (const port of ports) {
      const has = Object.prototype.hasOwnProperty.call(values, port.name);
      if (port.required && !has) {
        throw new GraphInputError(
          `Missing required ${context} port '${port.name}'`
        );
      }
      if (has) {
        const descriptor = this.resolver.resolve(port);
        if (!descriptor.validate(values[port.name])) {
          throw new GraphInputError(
            `Invalid value for ${context} port '${port.name}'`
          );
        }
      }
    }
  }
}
