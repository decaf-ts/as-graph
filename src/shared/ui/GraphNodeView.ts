/**
 * @module as-graph/shared/ui/GraphNodeView
 * @summary Builds the framework-neutral node/port view models.
 * @description Projects a node manifest (static or resolved) plus an optional
 * document instance and an optional run record into the {@link GraphNodeView}
 * a graph UI renders. Dynamic ports are expected to be expanded by the caller
 * (the engine's manifest resolver) before projection; this module is pure and
 * DOM-free so it stays importable from any frontend bundle.
 */
import {
  GraphVisualState,
  graphCategoryStyleOf,
  graphVisualStyleOf,
} from "../graph";
import type {
  GraphNodeManifest,
  GraphPortManifest,
  GraphResolvedNodeManifest,
  GraphNodeInstance,
} from "../graph";
import type {
  GraphNodeView,
  GraphPortView,
  GraphPortViewDirection,
} from "./types";

/** A manifest accepted by the node view builder (static or resolved). */
export type GraphNodeManifestLike =
  | GraphNodeManifest
  | GraphResolvedNodeManifest;

/**
 * Resolves a catalogue icon reference to its display name. URL/data icons keep
 * their literal payload so a renderer can still show something meaningful.
 *
 * @param icon - The manifest icon reference, when present.
 * @returns The icon name/url/value, or `undefined`.
 */
function iconNameOf(
  icon: GraphNodeManifestLike["display"]["icon"]
): string | undefined {
  if (!icon) return undefined;
  switch (icon.type) {
    case "catalogue":
      return icon.name;
    case "url":
      return icon.url;
    case "data":
      return icon.value;
    default:
      return undefined;
  }
}

/**
 * Projects a manifest port into its view model.
 *
 * @param port - The manifest port.
 * @returns The port view model.
 */
export function graphPortViewOf(port: GraphPortManifest): GraphPortView {
  return {
    id: port.id,
    label: port.label,
    direction: port.direction as GraphPortViewDirection,
    required: port.required === true,
    hidden: port.hidden === true,
    category: port.category,
    handle: port.handle,
    schema: port.schema,
    element: port.element,
  };
}

/**
 * Resolves the effective accent colour for a node: the manifest's explicit
 * colour wins, else the registered category style, else the default style.
 *
 * @param manifest - The node manifest.
 * @returns The resolved colour, when one is known.
 */
export function graphNodeColorOf(
  manifest: GraphNodeManifestLike
): string | undefined {
  if (manifest.display.color) return manifest.display.color;
  return graphCategoryStyleOf(manifest.display.category).color;
}

/**
 * Resolves the effective icon for a node: the manifest's explicit icon wins,
 * else the registered category style icon.
 *
 * @param manifest - The node manifest.
 * @returns The resolved icon name, when one is known.
 */
export function graphNodeIconOf(
  manifest: GraphNodeManifestLike
): string | undefined {
  return (
    iconNameOf(manifest.display.icon) ??
    graphCategoryStyleOf(manifest.display.category).icon
  );
}

/**
 * Builds the view model for a single node instance.
 *
 * @param manifest - The node's manifest (static or already resolved).
 * @param instance - The optional document node instance.
 * @param run - The optional per-node run record.
 * @returns The node view model.
 */
export function graphNodeViewOf(
  manifest: GraphNodeManifestLike,
  instance?: GraphNodeInstance,
  run?: { visualState: GraphVisualState }
): GraphNodeView {
  const visualState = run?.visualState ?? GraphVisualState.IDLE;
  return {
    id: instance?.id ?? manifest.kind,
    kind: manifest.kind,
    label: instance?.label ?? manifest.display.name,
    description: manifest.display.description,
    category: manifest.display.category,
    color: graphNodeColorOf(manifest),
    icon: graphNodeIconOf(manifest),
    width: manifest.display.width,
    height: manifest.display.height,
    shape: manifest.display.shape,
    cornerRadius: manifest.display.cornerRadius,
    labels: [...(manifest.display.labels ?? [])],
    inputs: (manifest.inputs ?? []).map(graphPortViewOf),
    outputs: (manifest.outputs ?? []).map(graphPortViewOf),
    connections: (manifest.connections ?? []).map(graphPortViewOf),
    capabilities: [...(manifest.capabilities ?? [])],
    disabled: instance?.disabled === true,
    pinned: instance?.pinned !== undefined,
    visualState,
    visualStyle: { state: visualState, ...graphVisualStyleOf(visualState) },
  };
}
