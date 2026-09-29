/**
 * Gate-2 P0 #7 (D7) + #1 (D1) — manifest display is the single authority
 * for node geometry and face (DECAF-50 §4.5, gate-3 revision).
 *
 * Category base colours are authoritative (G3-22): every node of a category
 * resolves to that category's one base colour, and a per-node colour is only an
 * explicit override applied at this single precedence point. The stale second
 * manifest authority for the loop kinds is removed (G3-23): the hand-authored
 * loop manifests mirror the decorated classes' display. Content growth is evaluated
 * from manifest-declared, value-driven rules (G3-03).
 */
import {
  graphNodeSizeOf,
  resolveEffectiveColor,
  resolveEffectiveIcon,
} from "../../../src/shared/graph";

describe("graph display contract (D1/D7, G3-22..25)", () => {
  it("resolves the category base colour for same-category nodes (G3-22)", () => {
    expect(resolveEffectiveColor("#f97316", "Flow Control")).toBe("#f59e0b");
    expect(resolveEffectiveColor("#ef4444", "Flow Control")).toBe("#f59e0b");
    expect(resolveEffectiveColor("#db2777", "Loop")).toBe("#eab308");
    expect(resolveEffectiveColor("#6366f1", "Utility")).toBe("#0d9488");
  });

  it("applies an explicit per-node colour override at one precedence point (G3-22)", () => {
    expect(resolveEffectiveColor("#f97316", "Flow Control", "#123456")).toBe("#123456");
  });

  it("resolves the category base icon with an explicit override (G3-22)", () => {
    expect(resolveEffectiveIcon("ti-code", "Flow Control")).toBe("ti-arrows-split-2");
    expect(resolveEffectiveIcon("ti-code", "Flow Control", "ti-custom")).toBe("ti-custom");
  });

  it("grows node height from a manifest-declared value-driven rule (G3-03)", () => {
    expect(
      graphNodeSizeOf(
        {
          width: 120,
          height: 140,
          sizeRules: [
            { type: "parameterCount", parameter: "cases", dimension: "height", perItem: 24 },
          ],
        },
        { cases: 4 }
      )
    ).toEqual({ width: 120, height: 236 });
  });

  it("never grows without a manifest rule (G3-03)", () => {
    expect(graphNodeSizeOf({ width: 120, height: 140 }, { cases: 4 })).toEqual({
      width: 120,
      height: 140,
    });
  });
});
