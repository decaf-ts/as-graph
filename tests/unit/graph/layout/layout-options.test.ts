/**
 * @module as-graph/tests/unit/graph/layout/layout-options.test
 * @summary Headless unit tests for the ELK option mapping behind
 * `computeGraphWorkflowLayout` (SAA-249).
 * @description Covers the mode presets, the spacing profiles and their
 * preset×profile composition, the hard-coded left-to-right direction invariant,
 * and the default resolution helpers. No `src/**` file is edited.
 */
import {
  buildLayoutOptions,
  computeGraphWorkflowLayout,
  GraphLayoutMode,
  GraphLayoutSpacing,
  resolveLayoutMode,
  resolveLayoutSpacing,
  toElkGraph,
  type GraphLayoutOptions,
} from "../../../../src/shared/graph";
import { document, edge, node } from "../../../../src/workflows/builders";

const NODE = 96;

/** Base ELK spacing in pixels; the profile multiplier is applied on top. */
const BASE = {
  "elk.spacing.nodeNode": 20,
  "elk.spacing.edgeNode": 10,
  "elk.spacing.edgeEdge": 10,
  "elk.layered.spacing.nodeNodeBetweenLayers": 20,
  "elk.layered.spacing.edgeNodeBetweenLayers": 10,
  "elk.layered.spacing.edgeEdgeBetweenLayers": 10,
} as const;

const SPACING_KEYS = Object.keys(BASE);
const MULTIPLIER: Record<GraphLayoutSpacing, number> = {
  [GraphLayoutSpacing.TIGHT]: 0.5,
  [GraphLayoutSpacing.NORMAL]: 1,
  [GraphLayoutSpacing.COMFORTABLE]: 1.5,
};

const MODE_OPTIONS: Record<GraphLayoutMode, Record<string, string>> = {
  [GraphLayoutMode.READABILITY]: {
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.edgeRouting": "ORTHOGONAL",
  },
  [GraphLayoutMode.COMPACTNESS]: {
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    "elk.edgeRouting": "POLYLINE",
  },
  [GraphLayoutMode.BALANCED]: {
    "elk.layered.crossingMinimization.strategy": "GREEDY",
    "elk.edgeRouting": "ORTHOGONAL",
  },
};

const MODE_DEFAULT_SPACING: Record<GraphLayoutMode, GraphLayoutSpacing> = {
  [GraphLayoutMode.READABILITY]: GraphLayoutSpacing.COMFORTABLE,
  [GraphLayoutMode.COMPACTNESS]: GraphLayoutSpacing.TIGHT,
  [GraphLayoutMode.BALANCED]: GraphLayoutSpacing.NORMAL,
};

function expectedSpacing(spacing: GraphLayoutSpacing): Record<string, string> {
  const multiplier = MULTIPLIER[spacing];
  return Object.fromEntries(
    SPACING_KEYS.map((key) => [key, String(Math.round(BASE[key as keyof typeof BASE] * multiplier))])
  );
}

/** A simple A→B→C chain used to exercise the adapter end to end. */
function chain(): ReturnType<typeof document> {
  return document({
    id: "layout-options-chain",
    nodes: [node("a", "core.flow.log"), node("b", "core.flow.log"), node("c", "core.flow.log")],
    edges: [
      edge("e1", ["node", "a", "out"], ["node", "b", "in"]),
      edge("e2", ["node", "b", "out"], ["node", "c", "in"]),
    ],
  });
}

describe("buildLayoutOptions mode presets (SAA-249)", () => {
  for (const mode of [
    GraphLayoutMode.READABILITY,
    GraphLayoutMode.COMPACTNESS,
    GraphLayoutMode.BALANCED,
  ]) {
    it(`maps ${mode} to its ELK algorithm options and default spacing`, () => {
      const options = buildLayoutOptions({ mode });
      expect(options["elk.algorithm"]).toBe("layered");
      expect(options["elk.direction"]).toBe("RIGHT");
      for (const [key, value] of Object.entries(MODE_OPTIONS[mode])) {
        expect(options[key]).toBe(value);
      }
      expect(options).toMatchObject(expectedSpacing(MODE_DEFAULT_SPACING[mode]));
    });
  }

  it("defaults to the BALANCED preset when no mode is given", () => {
    expect(buildLayoutOptions()).toMatchObject({
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.crossingMinimization.strategy": "GREEDY",
      "elk.edgeRouting": "ORTHOGONAL",
      ...expectedSpacing(GraphLayoutSpacing.NORMAL),
    });
    expect(buildLayoutOptions()).toEqual(buildLayoutOptions({ mode: GraphLayoutMode.BALANCED }));
  });

  it("omits nodePlacement for BALANCED and crossingMinimization for COMPACTNESS", () => {
    expect(buildLayoutOptions({ mode: GraphLayoutMode.BALANCED })).not.toHaveProperty(
      "elk.layered.nodePlacement.strategy"
    );
    expect(buildLayoutOptions({ mode: GraphLayoutMode.COMPACTNESS })).not.toHaveProperty(
      "elk.layered.crossingMinimization.strategy"
    );
  });
});

describe("buildLayoutOptions spacing profiles (SAA-249)", () => {
  for (const spacing of [
    GraphLayoutSpacing.TIGHT,
    GraphLayoutSpacing.NORMAL,
    GraphLayoutSpacing.COMFORTABLE,
  ]) {
    it(`applies the ${spacing} profile over every elk.spacing key`, () => {
      const options = buildLayoutOptions({ spacing });
      expect(options).toMatchObject(expectedSpacing(spacing));
      for (const key of SPACING_KEYS) {
        expect(options[key]).toBe(expectedSpacing(spacing)[key]);
      }
    });
  }

  it("overrides the mode default when an explicit spacing is given", () => {
    const comfortable = buildLayoutOptions({
      mode: GraphLayoutMode.READABILITY,
      spacing: GraphLayoutSpacing.TIGHT,
    });
    expect(comfortable).toMatchObject({
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.edgeRouting": "ORTHOGONAL",
      ...expectedSpacing(GraphLayoutSpacing.TIGHT),
    });
    expect(resolveLayoutSpacing({ mode: GraphLayoutMode.READABILITY })).toBe(
      GraphLayoutSpacing.COMFORTABLE
    );
    expect(
      resolveLayoutSpacing({ mode: GraphLayoutMode.READABILITY, spacing: GraphLayoutSpacing.TIGHT })
    ).toBe(GraphLayoutSpacing.TIGHT);
  });
});

describe("buildLayoutOptions preset×profile composition (SAA-249)", () => {
  for (const mode of [
    GraphLayoutMode.READABILITY,
    GraphLayoutMode.COMPACTNESS,
    GraphLayoutMode.BALANCED,
  ]) {
    for (const spacing of [
      GraphLayoutSpacing.TIGHT,
      GraphLayoutSpacing.NORMAL,
      GraphLayoutSpacing.COMFORTABLE,
    ]) {
      it(`composes ${mode} with ${spacing}`, () => {
        const options = buildLayoutOptions({ mode, spacing });
        expect(options).toMatchObject({
          "elk.algorithm": "layered",
          "elk.direction": "RIGHT",
          ...MODE_OPTIONS[mode],
          ...expectedSpacing(spacing),
        });
        expect(Object.keys(options).sort()).toEqual(
          ["elk.algorithm", "elk.direction", ...SPACING_KEYS, ...Object.keys(MODE_OPTIONS[mode])].sort()
        );
      });
    }
  }
});

describe("layout direction invariant (SAA-249)", () => {
  type HasDirection = "direction" extends keyof GraphLayoutOptions ? true : false;
  const hasDirection: HasDirection = false;

  it("exposes no direction option on GraphLayoutOptions", () => {
    expect(hasDirection).toBe(false);
    expect(Object.keys(buildLayoutOptions())).not.toContain("direction");
  });

  it("hard-codes elk.direction RIGHT and ignores a smuggled direction", () => {
    const smuggled = {
      mode: GraphLayoutMode.BALANCED,
      direction: "DOWN",
    } as unknown as GraphLayoutOptions;
    expect(buildLayoutOptions(smuggled)["elk.direction"]).toBe("RIGHT");
    expect(buildLayoutOptions({ mode: GraphLayoutMode.READABILITY })["elk.direction"]).toBe("RIGHT");
    expect(toElkGraph(chain()).layoutOptions?.["elk.direction"]).toBe("RIGHT");
    expect(toElkGraph(chain(), { mode: GraphLayoutMode.COMPACTNESS }).layoutOptions?.["elk.direction"]).toBe(
      "RIGHT"
    );
  });
});

describe("resolveLayoutMode / resolveLayoutSpacing defaults (SAA-249)", () => {
  it("defaults the mode to BALANCED", () => {
    expect(resolveLayoutMode()).toBe(GraphLayoutMode.BALANCED);
    expect(resolveLayoutMode({})).toBe(GraphLayoutMode.BALANCED);
    expect(resolveLayoutMode({ mode: GraphLayoutMode.COMPACTNESS })).toBe(
      GraphLayoutMode.COMPACTNESS
    );
  });

  it("defaults the spacing to the resolved mode's own profile", () => {
    expect(resolveLayoutSpacing()).toBe(GraphLayoutSpacing.NORMAL);
    expect(resolveLayoutSpacing({ mode: GraphLayoutMode.COMPACTNESS })).toBe(
      GraphLayoutSpacing.TIGHT
    );
    expect(resolveLayoutSpacing({ mode: GraphLayoutMode.READABILITY })).toBe(
      GraphLayoutSpacing.COMFORTABLE
    );
    expect(resolveLayoutSpacing({ spacing: GraphLayoutSpacing.TIGHT })).toBe(
      GraphLayoutSpacing.TIGHT
    );
  });
});

describe("mode preset positions (SAA-249)", () => {
  function orderedX(
    result: Awaited<ReturnType<typeof computeGraphWorkflowLayout>>
  ): number[] {
    return ["a", "b", "c"].map((id) => result.nodes[id].x);
  }

  it("places every mode left-to-right", async () => {
    for (const mode of [
      GraphLayoutMode.READABILITY,
      GraphLayoutMode.COMPACTNESS,
      GraphLayoutMode.BALANCED,
    ]) {
      const result = await computeGraphWorkflowLayout(chain(), { mode });
      const xs = orderedX(result);
      expect(xs[1]).toBeGreaterThan(xs[0]);
      expect(xs[2]).toBeGreaterThan(xs[1]);
    }
  });

  it("spaces layers according to the mode's default spacing", async () => {
    const gap = async (mode: GraphLayoutMode): Promise<number> => {
      const result = await computeGraphWorkflowLayout(chain(), { mode });
      return result.nodes.b.x - result.nodes.a.x - NODE;
    };
    const comfortable = await gap(GraphLayoutMode.READABILITY);
    const normal = await gap(GraphLayoutMode.BALANCED);
    const tight = await gap(GraphLayoutMode.COMPACTNESS);
    expect(comfortable).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(tight);
  });
});
