import type { LayoutOptions } from "elkjs/lib/elk-api";

/**
 * User-selectable auto-layout algorithm presets. Every preset is left-to-right;
 * direction is not (and must never become) an option.
 */
export enum GraphLayoutMode {
  /** Crossing-minimisation priority: LAYER_SWEEP + BRANDES_KOEPF + ORTHOGONAL. */
  READABILITY = "readability",
  /** Tight packing: NETWORK_SIMPLEX + POLYLINE routing. */
  COMPACTNESS = "compactness",
  /** Default: GREEDY crossing minimisation + ORTHOGONAL routing. */
  BALANCED = "balanced",
}

/**
 * Spacing profiles composable with any {@link GraphLayoutMode}. Each profile is a
 * scalar multiplier over the ELK `elk.spacing.*` keys.
 */
export enum GraphLayoutSpacing {
  /** Reduced spacing (0.5x). */
  TIGHT = "tight",
  /** Baseline spacing (1x). */
  NORMAL = "normal",
  /** Generous spacing (1.5x). */
  COMFORTABLE = "comfortable",
}

/**
 * Options accepted by `computeGraphWorkflowLayout`. The interface deliberately has
 * no direction field: the adapter hard-codes `elk.direction: "RIGHT"` so no caller
 * can ever request a non-left-to-right layout.
 */
export interface GraphLayoutOptions {
  /** Algorithm preset. Defaults to {@link GraphLayoutMode.BALANCED}. */
  mode?: GraphLayoutMode;
  /** Spacing profile. Defaults to the selected mode's own spacing. */
  spacing?: GraphLayoutSpacing;
}

// ELK layered base spacing in pixels, before the profile multiplier is applied.
const BASE_SPACING: Record<string, number> = {
  "elk.spacing.nodeNode": 20,
  "elk.spacing.edgeNode": 10,
  "elk.spacing.edgeEdge": 10,
  "elk.layered.spacing.nodeNodeBetweenLayers": 20,
  "elk.layered.spacing.edgeNodeBetweenLayers": 10,
  "elk.layered.spacing.edgeEdgeBetweenLayers": 10,
};

const SPACING_MULTIPLIER: Record<GraphLayoutSpacing, number> = {
  [GraphLayoutSpacing.TIGHT]: 0.5,
  [GraphLayoutSpacing.NORMAL]: 1,
  [GraphLayoutSpacing.COMFORTABLE]: 1.5,
};

// Mode preset mapping onto ELK layered options. The manifest algorithms map 1:1:
// crossingMinimization.strategy -> LAYER_SWEEP/GREEDY, nodePlacement.strategy ->
// BRANDES_KOEPF/NETWORK_SIMPLEX, edgeRouting -> ORTHOGONAL/POLYLINE. The
// preset's `spacing` is the profile used when the caller does not override it.
const MODE_PRESET: Record<
  GraphLayoutMode,
  { spacing: GraphLayoutSpacing; options: LayoutOptions }
> = {
  [GraphLayoutMode.READABILITY]: {
    spacing: GraphLayoutSpacing.COMFORTABLE,
    options: {
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.edgeRouting": "ORTHOGONAL",
    },
  },
  [GraphLayoutMode.COMPACTNESS]: {
    spacing: GraphLayoutSpacing.TIGHT,
    options: {
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.edgeRouting": "POLYLINE",
    },
  },
  [GraphLayoutMode.BALANCED]: {
    spacing: GraphLayoutSpacing.NORMAL,
    options: {
      "elk.layered.crossingMinimization.strategy": "GREEDY",
      "elk.edgeRouting": "ORTHOGONAL",
    },
  },
};

/** Resolves the requested mode, defaulting to {@link GraphLayoutMode.BALANCED}. */
export function resolveLayoutMode(
  options?: GraphLayoutOptions
): GraphLayoutMode {
  return options?.mode ?? GraphLayoutMode.BALANCED;
}

/** Resolves the requested spacing, defaulting to the mode's own profile. */
export function resolveLayoutSpacing(
  options?: GraphLayoutOptions
): GraphLayoutSpacing {
  return options?.spacing ?? MODE_PRESET[resolveLayoutMode(options)].spacing;
}

/**
 * Builds the ELK `layoutOptions` map for the requested mode and spacing. The
 * `elk.direction` key is hard-coded to `"RIGHT"` here — this is the only place
 * direction is set and it is not reachable from {@link GraphLayoutOptions}.
 */
export function buildLayoutOptions(options?: GraphLayoutOptions): LayoutOptions {
  const mode = resolveLayoutMode(options);
  const spacing = resolveLayoutSpacing(options);
  const multiplier = SPACING_MULTIPLIER[spacing];
  const result: LayoutOptions = {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    ...MODE_PRESET[mode].options,
  };
  for (const key of Object.keys(BASE_SPACING)) {
    result[key] = String(Math.round(BASE_SPACING[key] * multiplier));
  }
  return result;
}
