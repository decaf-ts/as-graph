/**
 * @module as-graph/tests/unit/graph/GraphCodeTimeoutCeilingGuard.test
 * @summary Unit tests for the Code node sandbox-timeout ceiling guard (SAA-567).
 * @description Pins the SAA-567 fix: `clampGraphCodeTimeoutMs` accepts an
 * `unknown` ceiling and falls back to {@link GRAPH_CODE_MAX_TIMEOUT_MS} when the
 * ceiling is non-number / non-finite / non-positive, so a clobbered
 * `GraphEnvironment.graph.execution` leaf (a truthy path-composition proxy) can
 * never produce `Math.min(1000, NaN) === NaN` and surface as
 * `GRAPH_CODE_SANDBOX_TIMEOUT`. A valid numeric ceiling still clamps.
 */
import { describe, it, expect } from "@jest/globals";

import {
  clampGraphCodeTimeoutMs,
  GRAPH_CODE_DEFAULT_TIMEOUT_MS,
} from "../../../src/node";
import { GRAPH_CODE_MAX_TIMEOUT_MS } from "../../../src/engine/constants";

/**
 * Stand-in for the `@decaf-ts/logging` path-composition proxy: any property
 * access returns another such proxy, and primitive coercion yields a composed ENV
 * key string (which `Number(...)` maps to `NaN`).
 */
function pathCompositionProxy(): unknown {
  const composedKey = "GRAPH__EXECUTION__MAX_CODE_TIMEOUT_MS";
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === Symbol.toPrimitive) return () => composedKey;
        if (prop === "toString") return () => composedKey;
        if (prop === "valueOf") return () => composedKey;
        if (typeof prop === "symbol") return undefined;
        return proxy;
      },
    }
  );
  return proxy;
}

describe("clampGraphCodeTimeoutMs ceiling guard (SAA-567)", () => {
  it("falls back to GRAPH_CODE_MAX_TIMEOUT_MS for a non-number ceiling and never returns NaN", () => {
    const invalidCeilings: unknown[] = [
      undefined,
      null,
      NaN,
      0,
      -1,
      Infinity,
      -Infinity,
      "",
      "not-a-number",
      {},
      [],
    ];

    for (const ceiling of invalidCeilings) {
      const result = clampGraphCodeTimeoutMs(1000, ceiling);
      expect(Number.isNaN(result)).toBe(false);
      expect(Number.isFinite(result)).toBe(true);
      // 1000 is within the fallback ceiling, so it passes through unchanged.
      expect(result).toBe(1000);
    }
  });

  it("falls back for a path-composition proxy-like ceiling", () => {
    const result = clampGraphCodeTimeoutMs(1000, pathCompositionProxy());
    expect(Number.isNaN(result)).toBe(false);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(1000);
  });

  it("still clamps against a valid numeric ceiling", () => {
    expect(clampGraphCodeTimeoutMs(5000, 2000)).toBe(2000);
    expect(clampGraphCodeTimeoutMs(50000, GRAPH_CODE_MAX_TIMEOUT_MS)).toBe(
      GRAPH_CODE_MAX_TIMEOUT_MS
    );
  });

  it("passes a within-ceiling value through unchanged", () => {
    expect(clampGraphCodeTimeoutMs(2500, GRAPH_CODE_MAX_TIMEOUT_MS)).toBe(2500);
    expect(clampGraphCodeTimeoutMs(2500, 5000)).toBe(2500);
  });

  it("still falls back to the node default for a missing or invalid value regardless of ceiling", () => {
    expect(clampGraphCodeTimeoutMs(0, undefined)).toBe(
      GRAPH_CODE_DEFAULT_TIMEOUT_MS
    );
    expect(clampGraphCodeTimeoutMs(NaN, pathCompositionProxy())).toBe(
      GRAPH_CODE_DEFAULT_TIMEOUT_MS
    );
    expect(clampGraphCodeTimeoutMs(undefined, 2000)).toBe(
      GRAPH_CODE_DEFAULT_TIMEOUT_MS
    );
  });
});
