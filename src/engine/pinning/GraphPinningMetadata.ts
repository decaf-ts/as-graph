/**
 * @module as-graph/pinning/GraphPinningMetadata
 * @summary Pinning metadata defaults and helpers.
 * @description Provides default pinning metadata values and a helper to check pinnability. The `GraphPinningMetadata` type itself is defined in `../types` and re-exported from the package root.
 */
import type { GraphPinningMetadata } from "../types";

/**
 * Default pinning metadata applied when `@pinnable()` is used without options.
 */
export const DEFAULT_PINNING_METADATA: GraphPinningMetadata = {
  enabled: true,
  strategy: "manual",
  includeDependencies: true,
};

/**
 * Returns `true` when the given metadata allows pinning.
 */
export function isPinnable(metadata: GraphPinningMetadata | undefined): boolean {
  return metadata?.enabled === true && metadata.strategy !== "disabled";
}
