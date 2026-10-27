/**
 * @module as-graph/nodes/manifest-compile
 * @summary Shared manifest compilation helpers for built-in node classes.
 * @description Compiles a `@node`-decorated class into its published
 * {@link GraphNodeManifest} and applies the sanctioned catalogue overlays
 * (display icon and JSON-safe capability metadata). Shared by the engine-neutral
 * catalogue (`src/node/manifests.ts`) and the Mastra-owned catalogue
 * (`src/mastra/nodes/manifests.ts`) so neither surface duplicates the
 * compilation rules.
 */
import type { Constructor } from "@decaf-ts/decoration";
import type { GraphNodeManifest } from "../shared/graph";
import { graphNodeManifest, graphNodeMetadataOf } from "../shared/graph";

/**
 * Compiles a `@node`-decorated class into its published manifest, using the
 * class's own `@node` metadata title as the display name.
 *
 * @param node - The decorated node class constructor.
 * @returns The compiled node manifest.
 */
export function compile(node: unknown): GraphNodeManifest {
  const ctor = node as Constructor;
  const meta = graphNodeMetadataOf(ctor);
  const title = (meta?.metadata as { title?: string } | undefined)?.title;
  return graphNodeManifest(ctor, title ? { name: title } : {});
}

/**
 * Compiles a node manifest with an explicit display-icon overlay.
 *
 * @param node - The decorated node class constructor.
 * @param icon - The catalogue icon name to overlay (e.g. `ti-brand-slack`).
 * @returns The compiled node manifest with the icon overlay.
 */
export function compileWithIcon(
  node: unknown,
  icon: string
): GraphNodeManifest {
  const ctor = node as Constructor;
  const meta = graphNodeMetadataOf(ctor);
  const title = (meta?.metadata as { title?: string } | undefined)?.title;
  return graphNodeManifest(ctor, {
    ...(title ? { name: title } : {}),
    icon: { type: "catalogue", name: icon },
  });
}

/**
 * Compiles a node manifest and overlays JSON-safe catalogue metadata used for
 * capability gating.
 *
 * @param node - The decorated node class constructor.
 * @param metadata - JSON-safe catalogue flags (for example `danger`).
 * @returns The compiled manifest with the flags merged under `metadata`.
 */
export function compileWithManifestMetadata(
  node: unknown,
  metadata: Record<string, string | boolean>
): GraphNodeManifest {
  const manifest = compile(node);
  return {
    ...manifest,
    metadata: { ...(manifest.metadata ?? {}), ...metadata },
  };
}
