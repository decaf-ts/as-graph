/**
 * @module as-graph/pinning/GraphPinningPolicy
 * @summary Decides whether a node can be pinned and whether pinned values should be used.
 * @description Reads pinning metadata from plan nodes and enforces the pinning strategy.
 */
import type { GraphExecutionPlanNode } from "../planning/GraphExecutionPlanNode";
import type { GraphPinningMetadata } from "../types";
import { DEFAULT_PINNING_METADATA, isPinnable } from "./GraphPinningMetadata";

/**
 * Policy that decides pinning behaviour for a plan node.
 */
export class GraphPinningPolicy {
  /** Returns whether the node is allowed to be pinned. */
  canPin(node: GraphExecutionPlanNode): boolean {
    return isPinnable(this.getPinningMetadata(node));
  }

  /** Returns whether the engine should attempt to use a pinned value for the node. */
  shouldUsePinnedValue(node: GraphExecutionPlanNode): boolean {
    const metadata = this.getPinningMetadata(node);
    return metadata.enabled === true && metadata.strategy !== "disabled";
  }

  /** Returns whether automatic pinning should occur after execution. */
  shouldAutoPin(node: GraphExecutionPlanNode): boolean {
    const metadata = this.getPinningMetadata(node);
    return metadata.enabled === true && metadata.strategy === "automatic";
  }

  /** Extracts pinning metadata from a plan node. */
  getPinningMetadata(node: GraphExecutionPlanNode): GraphPinningMetadata {
    const raw =
      (node.manifest.metadata as Record<string, unknown> | undefined)?.["pinnable"] ??
      (node.metadata as Record<string, unknown> | undefined)?.["pinnable"];
    return raw
      ? { ...DEFAULT_PINNING_METADATA, ...raw }
      : { ...DEFAULT_PINNING_METADATA, enabled: false };
  }
}
