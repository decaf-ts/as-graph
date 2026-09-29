/**
 * @module ui-decorators/graph/overrides/Metadata
 * @summary Metadata namespace augmentation for graph nodes and workflows.
 * @description Extends the `Metadata` class from `@decaf-ts/decoration` with
 * `Metadata.nodes()` and `Metadata.workflows()` accessors that return all
 * `@node`-decorated and `@graph`-decorated constructors respectively.
 *
 * This follows the existing override pattern used by `core` (`core/src/overrides/`)
 * and `decorator-validation` (`decorator-validation/src/overrides/`):
 * 1. This file declares the new static methods on the `Metadata` namespace via
 *    `declare module` (TypeScript declaration merging).
 * 2. The companion `overrides.ts` attaches the implementations to the
 *    `Metadata` class at runtime via `(Metadata as any).fn = ...`.
 * 3. The `index.ts` of this folder side-effect-imports `overrides.ts` so the
 *    attachments run whenever the graph module is loaded.
 * 4. The package's `sideEffects` array in `package.json` includes the compiled
 *    overrides entry points so bundlers preserve the side-effect imports.
 */
import "@decaf-ts/decoration";
import type { Constructor } from "@decaf-ts/decoration";

declare module "@decaf-ts/decoration" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Metadata {
    /**
     * Returns all `@node`-decorated constructors.
     *
     * The list is populated as a side-effect of the `@node` decorator — every
     * class decorated with `@node(...)` is appended to the node registry at
     * decoration time. Consumers (e.g. the for-angular graph palette, CRUD form
     * builders, executor registries) call this to discover all available node
     * kinds without a hand-maintained array.
     * @returns A fresh array of `@node`-decorated constructors.
     */
    function nodes(): Constructor[];

    /**
     * Returns all `@graph`-decorated constructors (workflow roots).
     *
     * Analogous to {@link nodes} but for `@graph`-decorated workflow-root
     * classes. Populated as a side-effect of the `@graph` decorator.
     * @returns A fresh array of `@graph`-decorated constructors.
     */
    function workflows(): Constructor[];
  }
}
