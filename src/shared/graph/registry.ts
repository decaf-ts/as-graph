/**
 * @module ui-decorators/graph/registry
 * @summary Node and workflow class registries.
 * @description Module-level registries that track every `@node`-decorated and
 * `@graph`-decorated constructor. The `@node` and `@graph` decorators call
 * {@link registerNode} / {@link registerWorkflow} as a side-effect; consumers
 * discover all decorated classes via {@link graphNodes} / {@link graphWorkflows}
 * or the `Metadata.nodes()` / `Metadata.workflows()` accessors.
 *
 * This follows the same pattern as `Injectables` (`injectable-decorators`)
 * which maintains its own `InjectablesRegistry` rather than using the private
 * `Metadata.innerGet`/`innerSet` helpers.
 */

import type { Constructor } from "@decaf-ts/decoration";

/**
 * Internal registry of all `@node`-decorated constructors.
 */
const NODE_REGISTRY = new Set<Constructor>();

/**
 * Internal registry of all `@graph`-decorated constructors.
 */
const WORKFLOW_REGISTRY = new Set<Constructor>();

/**
 * Appends a constructor to the node registry. Called by the `@node` decorator.
 * Idempotent — re-decorating the same class does not duplicate the entry.
 * @param ctor The `@node`-decorated constructor.
 */
export function registerNode(ctor: Constructor): void {
  NODE_REGISTRY.add(ctor);
}

/**
 * Appends a constructor to the workflow registry. Called by the `@graph`
 * decorator. Idempotent.
 * @param ctor The `@graph`-decorated constructor.
 */
export function registerWorkflow(ctor: Constructor): void {
  WORKFLOW_REGISTRY.add(ctor);
}

/**
 * Returns all `@node`-decorated constructors.
 * @returns A fresh array of constructors (mutable; does not expose the internal set).
 */
export function graphNodes(): Constructor[] {
  return [...NODE_REGISTRY];
}

/**
 * Returns all `@graph`-decorated constructors.
 * @returns A fresh array of constructors.
 */
export function graphWorkflows(): Constructor[] {
  return [...WORKFLOW_REGISTRY];
}

/**
 * Clears both registries. Intended for tests only.
 */
export function resetGraphRegistries(): void {
  NODE_REGISTRY.clear();
  WORKFLOW_REGISTRY.clear();
}
