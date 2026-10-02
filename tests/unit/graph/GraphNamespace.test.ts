/**
 * @module as-graph/tests/unit/graph/GraphNamespace.test
 * @summary SAA-2014: namespace grammar decomposition, match modes, and cache
 * validation tests.
 * @description Pins the pure namespace contract the engine authorizes against:
 * - grammar `<organization>.<department>(,<sub-departments>...).<role>` with exactly
 *   two `.` segments and a comma-split department segment;
 * - `exact` mode (default) and `inherit` prefix mode;
 * - malformed strings (no `.` or more than two `.`) fail closed;
 * - `namespaceCache` is a pure performance cache that is never trusted blindly.
 */
import { describe, it, expect } from "@jest/globals";

import {
  composeGraphNamespace,
  decomposeGraphNamespace,
  findMalformedGraphNamespaces,
  findUngrantedGraphNamespaces,
  graphNamespaceCovers,
  graphNamespacePartsOf,
  graphRolesFromNamespaces,
  isGraphNamespaceCacheEntryValid,
} from "../../../src/engine/auth";
import type { GraphNamespaceCacheEntry } from "../../../src/engine/auth";

describe("GraphNamespace grammar (SAA-2014)", () => {
  describe("decomposeGraphNamespace", () => {
    it("decomposes <organization>.<department>.<role>", () => {
      expect(decomposeGraphNamespace("acme.engineering.admin")).toEqual({
        organization: "acme",
        departments: ["engineering"],
        role: "admin",
      });
    });

    it("splits the department segment into sub-departments", () => {
      expect(
        decomposeGraphNamespace("acme.engineering,platform.admin")
      ).toEqual({
        organization: "acme",
        departments: ["engineering", "platform"],
        role: "admin",
      });
    });

    it("normalizes surrounding whitespace and drops empty sub-departments", () => {
      expect(
        decomposeGraphNamespace(" acme . engineering , , platform . admin ")
      ).toEqual({
        organization: "acme",
        departments: ["engineering", "platform"],
        role: "admin",
      });
    });

    it("fails closed for strings that do not have exactly two dots", () => {
      expect(decomposeGraphNamespace("acme")).toBeUndefined();
      expect(decomposeGraphNamespace("acme.engineering")).toBeUndefined();
      expect(decomposeGraphNamespace("acme.engineering.sub.admin")).toBeUndefined();
      expect(decomposeGraphNamespace("acme.engineering.admin.extra")).toBeUndefined();
    });

    it("fails closed for empty organization, role, or department segments", () => {
      expect(decomposeGraphNamespace("acme..admin")).toBeUndefined();
      expect(decomposeGraphNamespace(".engineering.admin")).toBeUndefined();
      expect(decomposeGraphNamespace("acme.engineering.")).toBeUndefined();
      expect(decomposeGraphNamespace("acme. , .admin")).toBeUndefined();
      expect(decomposeGraphNamespace("")).toBeUndefined();
      expect(decomposeGraphNamespace("   ")).toBeUndefined();
    });

    it("fails closed for non-string input", () => {
      expect(decomposeGraphNamespace(undefined as never)).toBeUndefined();
      expect(decomposeGraphNamespace(42 as never)).toBeUndefined();
    });
  });

  describe("composeGraphNamespace", () => {
    it("round-trips a decomposed namespace", () => {
      const parts = decomposeGraphNamespace("acme.engineering,platform.admin");
      expect(parts).toBeDefined();
      expect(composeGraphNamespace(parts!)).toBe(
        "acme.engineering,platform.admin"
      );
    });

    it("composes a namespace from parts", () => {
      expect(
        composeGraphNamespace({
          organization: "acme",
          departments: ["engineering", "platform"],
          role: "admin",
        })
      ).toBe("acme.engineering,platform.admin");
    });
  });

  describe("graphNamespaceCovers — exact mode", () => {
    const exact = { mode: "exact" as const };

    it("grants an identical namespace", () => {
      expect(
        graphNamespaceCovers("acme.engineering.admin", "acme.engineering.admin", exact)
      ).toBe(true);
    });

    it("grants identical org, department set, and role", () => {
      expect(
        graphNamespaceCovers(
          "acme.engineering,platform.admin",
          "acme.engineering,platform.admin",
          exact
        )
      ).toBe(true);
    });

    it("normalizes whitespace on both sides", () => {
      expect(
        graphNamespaceCovers(
          " acme . engineering . admin ",
          "acme.engineering.admin",
          exact
        )
      ).toBe(true);
    });

    it("currently compares case-sensitively (case normalization flagged on SAA-2014)", () => {
      // The SAA-2014 wake contract says matching is normalized by
      // "case/whitespace"; only whitespace is normalized today. Reported as a
      // product defect on SAA-2014 rather than patched here.
      expect(
        graphNamespaceCovers("acme.engineering.admin", "ACME.ENGINEERING.ADMIN")
      ).toBe(false);
    });

    it("denies when the organization differs", () => {
      expect(
        graphNamespaceCovers("other.engineering.admin", "acme.engineering.admin", exact)
      ).toBe(false);
    });

    it("denies when the role differs", () => {
      expect(
        graphNamespaceCovers("acme.engineering.viewer", "acme.engineering.admin", exact)
      ).toBe(false);
    });

    it("denies when the department differs", () => {
      expect(
        graphNamespaceCovers("acme.platform.admin", "acme.engineering.admin", exact)
      ).toBe(false);
    });

    it("denies a granted sub-department superset of the required set", () => {
      expect(
        graphNamespaceCovers(
          "acme.engineering,platform.admin",
          "acme.engineering.admin",
          exact
        )
      ).toBe(false);
    });

    it("denies a granted sub-department subset of the required set", () => {
      expect(
        graphNamespaceCovers(
          "acme.engineering.admin",
          "acme.engineering,platform.admin",
          exact
        )
      ).toBe(false);
    });

    it("compares the department path positionally", () => {
      // Current implementation compares component-for-component (positional).
      // The contract calls it a "set"; flagged on SAA-2014 as an ambiguity.
      expect(
        graphNamespaceCovers(
          "acme.platform,engineering.admin",
          "acme.engineering,platform.admin",
          exact
        )
      ).toBe(false);
    });

    it("fails closed when either side is malformed", () => {
      expect(
        graphNamespaceCovers("team-a", "acme.engineering.admin", exact)
      ).toBe(false);
      expect(
        graphNamespaceCovers("acme.engineering.admin", "team-a", exact)
      ).toBe(false);
      expect(
        graphNamespaceCovers("a.b.c.d", "acme.engineering.admin", exact)
      ).toBe(false);
    });
  });

  describe("graphNamespaceCovers — inherit mode (default)", () => {
    const inherit = { mode: "inherit" as const };

    it("defaults to inherit mode when no option is passed", () => {
      // Board ruling (interaction 142e945c): inherit is the default.
      expect(
        graphNamespaceCovers("acme.engineering.admin", "acme.engineering,platform.admin")
      ).toBe(true);
    });

    it("grants a broader department scope covering a narrower requirement", () => {
      expect(
        graphNamespaceCovers(
          "acme.engineering.admin",
          "acme.engineering,platform.admin",
          inherit
        )
      ).toBe(true);
    });

    it("grants an identical namespace", () => {
      expect(
        graphNamespaceCovers("acme.engineering.admin", "acme.engineering.admin", inherit)
      ).toBe(true);
    });

    it("denies a granted path longer than the required path", () => {
      expect(
        graphNamespaceCovers(
          "acme.engineering,platform.admin",
          "acme.engineering.admin",
          inherit
        )
      ).toBe(false);
    });

    it("denies a granted path that is not a prefix of the required path", () => {
      expect(
        graphNamespaceCovers(
          "acme.platform.admin",
          "acme.engineering,platform.admin",
          inherit
        )
      ).toBe(false);
    });

    it("denies a different organization or role even with a matching prefix", () => {
      expect(
        graphNamespaceCovers(
          "other.engineering.admin",
          "acme.engineering,platform.admin",
          inherit
        )
      ).toBe(false);
      expect(
        graphNamespaceCovers(
          "acme.engineering.viewer",
          "acme.engineering,platform.admin",
          inherit
        )
      ).toBe(false);
    });

    it("fails closed when either side is malformed", () => {
      expect(graphNamespaceCovers("team-a", "team-a", inherit)).toBe(false);
      expect(
        graphNamespaceCovers("a.b.c.d", "a.b.c.d", inherit)
      ).toBe(false);
    });
  });

  describe("findUngrantedGraphNamespaces", () => {
    it("returns every required namespace not covered by a grant", () => {
      expect(
        findUngrantedGraphNamespaces(
          ["acme.engineering.admin", "acme.engineering.viewer"],
          ["acme.engineering.admin"]
        )
      ).toEqual(["acme.engineering.viewer"]);
    });

    it("returns an empty list when every requirement is covered", () => {
      expect(
        findUngrantedGraphNamespaces(
          ["acme.engineering.admin", "acme.platform.viewer"],
          ["acme.engineering.admin", "acme.platform.viewer"]
        )
      ).toEqual([]);
    });

    it("honours the inherit prefix mode", () => {
      expect(
        findUngrantedGraphNamespaces(
          ["acme.engineering,platform.admin"],
          ["acme.engineering.admin"],
          { mode: "inherit" }
        )
      ).toEqual([]);
      expect(
        findUngrantedGraphNamespaces(
          ["acme.engineering,platform.admin"],
          ["acme.engineering.admin"],
          { mode: "exact" }
        )
      ).toEqual(["acme.engineering,platform.admin"]);
    });

    it("treats malformed required namespaces as ungranted", () => {
      expect(
        findUngrantedGraphNamespaces(["team-a"], ["team-a"])
      ).toEqual(["team-a"]);
    });
  });

  describe("findMalformedGraphNamespaces", () => {
    it("reports every namespace that does not match the grammar", () => {
      expect(
        findMalformedGraphNamespaces([
          "acme.engineering.admin",
          "team-a",
          "a.b.c.d",
          "acme..admin",
        ])
      ).toEqual(["team-a", "a.b.c.d", "acme..admin"]);
    });

    it("reports nothing for well-formed namespaces", () => {
      expect(
        findMalformedGraphNamespaces([
          "acme.engineering.admin",
          "acme.engineering,platform.admin",
        ])
      ).toEqual([]);
    });
  });

  describe("graphRolesFromNamespaces", () => {
    it("derives the role set from the trailing .role of each namespace", () => {
      expect(
        graphRolesFromNamespaces([
          "acme.engineering.admin",
          "acme.platform.viewer",
          "acme.engineering.admin",
        ])
      ).toEqual(["admin", "viewer"]);
    });

    it("contributes no role for malformed namespaces", () => {
      expect(graphRolesFromNamespaces(["team-a", "acme.eng.admin"])).toEqual([
        "admin",
      ]);
    });

    it("uses a valid cache entry and re-derives a forged one", () => {
      const valid = cacheEntry("acme.engineering.viewer");
      expect(graphRolesFromNamespaces([valid.namespace], [valid])).toEqual([
        "viewer",
      ]);
      const forged: GraphNamespaceCacheEntry = {
        namespace: "acme.engineering.viewer",
        parts: {
          organization: "acme",
          departments: ["engineering"],
          role: "admin",
        },
      };
      expect(
        graphRolesFromNamespaces(["acme.engineering.viewer"], [forged])
      ).toEqual(["viewer"]);
    });
  });

  describe("namespaceCache validation", () => {
    it("accepts a valid entry whose parts compose back to its namespace", () => {
      const entry = cacheEntry("acme.engineering,platform.admin");
      expect(isGraphNamespaceCacheEntryValid(entry)).toBe(true);
    });

    it("rejects a forged entry whose parts disagree with its namespace", () => {
      const forged: GraphNamespaceCacheEntry = {
        namespace: "acme.engineering.viewer",
        parts: {
          organization: "acme",
          departments: ["engineering"],
          role: "admin",
        },
      };
      expect(isGraphNamespaceCacheEntryValid(forged)).toBe(false);
    });

    it("rejects a malformed namespace and nullish entries", () => {
      expect(
        isGraphNamespaceCacheEntryValid({
          namespace: "team-a",
          parts: {
            organization: "team-a",
            departments: ["x"],
            role: "y",
          },
        })
      ).toBe(false);
      expect(isGraphNamespaceCacheEntryValid(null)).toBe(false);
      expect(isGraphNamespaceCacheEntryValid(undefined)).toBe(false);
    });

    it("uses a valid cache entry instead of re-deriving", () => {
      const entry = cacheEntry("acme.engineering,platform.admin");
      expect(graphNamespacePartsOf(entry.namespace, [entry])).toEqual(entry.parts);
    });

    it("ignores a forged cache entry and re-derives from the raw string", () => {
      const forged: GraphNamespaceCacheEntry = {
        namespace: "acme.engineering.viewer",
        parts: {
          organization: "acme",
          departments: ["engineering"],
          role: "admin",
        },
      };
      expect(graphNamespacePartsOf("acme.engineering.viewer", [forged])).toEqual({
        organization: "acme",
        departments: ["engineering"],
        role: "viewer",
      });
    });

    it("ignores an entry for a different namespace", () => {
      const other = cacheEntry("acme.platform.admin");
      expect(graphNamespacePartsOf("acme.engineering.admin", [other])).toEqual({
        organization: "acme",
        departments: ["engineering"],
        role: "admin",
      });
    });

    it("re-derives when the cache is absent", () => {
      expect(graphNamespacePartsOf("acme.engineering.admin")).toEqual({
        organization: "acme",
        departments: ["engineering"],
        role: "admin",
      });
      expect(
        graphNamespacePartsOf("acme.engineering.admin", undefined)
      ).toEqual({
        organization: "acme",
        departments: ["engineering"],
        role: "admin",
      });
    });
  });
});

function cacheEntry(namespace: string): GraphNamespaceCacheEntry {
  const parts = decomposeGraphNamespace(namespace);
  if (!parts) throw new Error(`Invalid test namespace '${namespace}'`);
  return { namespace, parts };
}
