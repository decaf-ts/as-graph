/**
 * @module as-graph/engine/validation/GraphNodeInstanceValidator
 * @summary Kind resolution and dynamic-port validation (DECAF-50 §4.8 stages 2 and 4).
 * @description Stage 2 resolves every node instance against the trusted
 * backend catalogue (kind existence, effective manifest with expanded
 * dynamic ports, paired executor). Stage 4 validates that the effective
 * dynamic ports resolved consistently and that binding ids refer to
 * effective ports.
 */
import type { Context, MaybeContextualArg } from "@decaf-ts/core";
import type { GraphNodeInstance } from "../../shared/graph";

import type { GraphNodeCatalogue } from "../catalog/GraphNodeCatalogue";
import type {
  GraphNodeResolutionContext,
  GraphResolvedNodeManifest,
} from "../../shared/graph";
import { GraphExecutionError } from "../errors/GraphExecutionError";
import type { GraphNodeExecutor } from "../execution/GraphNodeExecutor";
import type { GraphValidationIssue } from "./GraphValidationIssue";
import type { GraphResolvedNodeInstance } from "./GraphResolvedWorkflow";

/** Options controlling kind resolution. */
export interface GraphNodeInstanceValidatorOptions {
  /**
   * Resolve unknown kinds and their reference-only edges for a backend that
   * serves an opaque deployment projection and binds the authoritative artifact
   * itself. The synthetic manifest is lenient and its executor fails closed.
   */
  deploymentProjection?: boolean;
}

const DEPLOYMENT_PROJECTION_EXECUTOR: GraphNodeExecutor = {
  execute: () => {
    throw new GraphExecutionError(
      "A deployment-projection node cannot be executed by the facade; the backend must bind and run the authoritative deployment artifact",
      "GRAPH_DEPLOYMENT_PROJECTION_NOT_EXECUTABLE"
    );
  },
};

function deploymentProjectionManifest(
  kind: string
): GraphResolvedNodeManifest {
  return {
    kind,
    display: { name: kind },
    inputs: [],
    outputs: [],
    parameters: [],
    policies: {
      allowUndeclaredParameters: true,
      allowUnknownOutputs: true,
    },
  };
}

/**
 * Resolves node instances against the backend catalogue and validates the
 * resolved dynamic-port surface.
 */
export class GraphNodeInstanceValidator {
  constructor(
    private readonly catalogue: GraphNodeCatalogue,
    private readonly options: GraphNodeInstanceValidatorOptions = {}
  ) {}

  /**
   * Stage 2 — kind resolution. Every node kind must exist in the backend
   * catalogue; the effective manifest (with dynamic ports expanded from the
   * instance parameters) and the paired executor are attached to the
   * resolved node. Nodes that fail resolution are skipped (issues recorded)
   * and never reach the planner.
   */
  async resolveNodes(
    nodes: GraphNodeInstance[],
    issues: GraphValidationIssue[],
    resolutionContext?: GraphNodeResolutionContext,
    ...args: MaybeContextualArg<Context>
  ): Promise<Map<string, GraphResolvedNodeInstance>> {
    const resolved = new Map<string, GraphResolvedNodeInstance>();
    for (const [index, node] of nodes.entries()) {
      const path = `nodes[${index}]`;
      if (!this.catalogue.has(node.kind, ...args)) {
        if (this.options.deploymentProjection === true) {
          resolved.set(node.id, {
            instance: node,
            manifest: deploymentProjectionManifest(node.kind),
            executor: DEPLOYMENT_PROJECTION_EXECUTOR,
          });
          continue;
        }
        issues.push({
          code: "kind.unknown",
          path: `${path}.kind`,
          message: `Node '${node.id}' references kind '${node.kind}' which is not registered in the backend catalogue`,
          nodeId: node.id,
          details: { kind: node.kind },
        });
        continue;
      }
      try {
        const manifest: GraphResolvedNodeManifest =
          await this.catalogue.resolveManifest(
            node.kind,
            node,
            resolutionContext,
            ...args
          );
        const executor = this.catalogue.getExecutor(node.kind, ...args);
        resolved.set(node.id, { instance: node, manifest, executor });
      } catch (error) {
        issues.push({
          code: "kind.resolution-failed",
          path: `${path}.kind`,
          message: `Node '${node.id}' kind '${node.kind}' failed to resolve: ${(error as Error).message}`,
          nodeId: node.id,
          details: { kind: node.kind },
        });
      }
    }
    return resolved;
  }

  /**
   * Stage 4 — dynamic ports and binding ids. Verifies that input/output
   * binding ids refer to ports on the effective (dynamics-expanded) manifest
   * surface, unless the manifest policy explicitly allows undeclared
   * parameters (transition placeholder kinds).
   */
  validateEffectivePorts(
    node: GraphNodeInstance,
    manifest: GraphResolvedNodeManifest,
    issues: GraphValidationIssue[],
    path: string
  ): void {
    const lenient = manifest.policies?.allowUndeclaredParameters === true;
    const effectiveInputs = new Set(manifest.inputs.map((port) => port.id));
    const effectiveOutputs = new Set(manifest.outputs.map((port) => port.id));

    for (const key of Object.keys(node.inputBindings ?? {})) {
      if (lenient || effectiveInputs.has(key)) continue;
      issues.push({
        code: "binding.unknown-port",
        path: `${path}.inputBindings.${key}`,
        message: `Node '${node.id}' input binding '${key}' does not refer to an effective input port of kind '${manifest.kind}'`,
        nodeId: node.id,
        details: { effectiveInputs: [...effectiveInputs] },
      });
    }

    for (const key of Object.keys(node.outputBindings ?? {})) {
      if (lenient || effectiveOutputs.has(key)) continue;
      issues.push({
        code: "binding.unknown-port",
        path: `${path}.outputBindings.${key}`,
        message: `Node '${node.id}' output binding '${key}' does not refer to an effective output port of kind '${manifest.kind}'`,
        nodeId: node.id,
        details: { effectiveOutputs: [...effectiveOutputs] },
      });
    }
  }
}
