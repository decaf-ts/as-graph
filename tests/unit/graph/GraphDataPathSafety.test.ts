/**
 * @module as-graph/tests/unit/graph/GraphDataPathSafety
 * @summary C2 regression coverage for SAA-958: reserved prototype keys are
 * rejected in literal-key mode (`dotNotation: false`) as well as in dotted-path
 * mode.
 * @description `setGraphDataValue` with `dotNotation: false` bypasses path
 * splitting, so a literal `__proto__` key used to reach the target object's
 * prototype. The same reserved-segment check now applies to the whole literal
 * key. Normal literal keys (including dotted text that must stay a single key)
 * keep working.
 */
import { describe, it, expect } from "@jest/globals";

import {
  deleteGraphDataValue,
  getGraphDataValue,
  setGraphDataValue,
} from "../../../src/node/data/support";

function capture(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("graph data literal-key safety (C2)", () => {
  it("rejects __proto__ as a literal key with GRAPH_DATA_UNSAFE_PATH", () => {
    const target: Record<string, unknown> = {};
    const error = capture(() =>
      setGraphDataValue(
        target,
        "__proto__",
        { polluted: true },
        false
      )
    );

    expect(error).toMatchObject({ graphCode: "GRAPH_DATA_UNSAFE_PATH" });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("rejects constructor and prototype as literal keys", () => {
    const target: Record<string, unknown> = {};

    expect(
      capture(() => setGraphDataValue(target, "constructor", {}, false))
    ).toMatchObject({ graphCode: "GRAPH_DATA_UNSAFE_PATH" });
    expect(
      capture(() => setGraphDataValue(target, "prototype", {}, false))
    ).toMatchObject({ graphCode: "GRAPH_DATA_UNSAFE_PATH" });

    // Read and delete paths apply the same guard.
    expect(
      capture(() => getGraphDataValue(target, "__proto__", false))
    ).toMatchObject({ graphCode: "GRAPH_DATA_UNSAFE_PATH" });
    expect(
      capture(() => deleteGraphDataValue(target, "__proto__", false))
    ).toMatchObject({ graphCode: "GRAPH_DATA_UNSAFE_PATH" });
  });

  it("still stores a normal literal key, including dotted text", () => {
    const target: Record<string, unknown> = {};

    setGraphDataValue(target, "a.b", "literal", false);

    expect(target["a.b"]).toBe("literal");
    expect(target["a"]).toBeUndefined();
    expect(getGraphDataValue(target, "a.b", false)).toBe("literal");

    deleteGraphDataValue(target, "a.b", false);
    expect(target["a.b"]).toBeUndefined();
  });
});
