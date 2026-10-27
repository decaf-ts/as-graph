/**
 * @module as-graph/tests/unit/graph/mastra/MastraNodeRegistry
 * @summary SAA-1143 regression for the mastra node registry (SAA-1141 Phase B.1).
 * @description Pins the registry invariants the mastra backend depends on:
 *
 * - the built-in catalogue reports no mastra coverage gaps
 *   (`auditMastraNodeCoverage()` is empty and `assertMastraNodeCoverage()` throws
 *   on gaps);
 * - `MASTRA_ONLY_NODE_KINDS` contains exactly the registered mastra-gated kinds
 *   (`core.agent` and its `core.agent.*` family) and no local kind;
 * - `createMastraNodeStepHandlers()` returns exactly one handler per mastra kind,
 *   never a duplicate and never a general-engine kind;
 * - each implementation resolves the same node class the built-in catalogue
 *   registers for that kind, so the backend can never stand up a handler with a
 *   missing or foreign node class.
 */
import { describe, expect, it } from "@jest/globals";
import {
  MASTRA_NODE_CLASSES_BY_KIND,
  MASTRA_NODE_IMPLEMENTATION_BY_KIND,
  MASTRA_NODE_IMPLEMENTATIONS,
  MASTRA_ONLY_NODE_KINDS,
  assertMastraNodeCoverage,
  auditMastraNodeCoverage,
  createMastraNodeStepHandlers,
} from "../../../../src/mastra/nodes";
import { graphNodeRequiresMastraEngine } from "../../../../src/engine/execution/GraphNodeEngineRequirements";

/** Every registered mastra-owned kind the mastra engine is the only executor for. */
const REGISTERED_MASTRA_KINDS: readonly string[] = Object.keys(
  MASTRA_NODE_CLASSES_BY_KIND
).sort();

/** Representative general-engine kinds that must never leak into the registry. */
const LOCAL_KINDS = [
  "value",
  "result",
  "core.flow.if",
  "core.flow.switch",
  "core.flow.humanApproval",
  "core.utility.code",
  "core.utility.log",
  "core.data.set",
] as const;

describe("MastraNodeRegistry coverage (SAA-1143)", () => {
  it("reports no gaps for the registered built-in catalogue", () => {
    expect(auditMastraNodeCoverage()).toEqual([]);
    expect(() => assertMastraNodeCoverage()).not.toThrow();
  });

  it("implements every registered mastra kind exactly once", () => {
    expect([...MASTRA_ONLY_NODE_KINDS].sort()).toEqual([
      ...REGISTERED_MASTRA_KINDS,
    ]);
    expect(new Set(MASTRA_ONLY_NODE_KINDS).size).toBe(
      MASTRA_ONLY_NODE_KINDS.length
    );
  });

  it("contains only mastra-gated kinds", () => {
    expect(
      MASTRA_ONLY_NODE_KINDS.filter(
        (kind) => !graphNodeRequiresMastraEngine(kind)
      )
    ).toEqual([]);
    for (const local of LOCAL_KINDS) {
      expect(MASTRA_ONLY_NODE_KINDS).not.toContain(local);
    }
  });

  it("binds every implementation to the registered node class for its kind", () => {
    expect(MASTRA_NODE_IMPLEMENTATIONS).toHaveLength(
      MASTRA_ONLY_NODE_KINDS.length
    );
    for (const implementation of MASTRA_NODE_IMPLEMENTATIONS) {
      expect(implementation.nodeClass).toBe(
        MASTRA_NODE_CLASSES_BY_KIND[implementation.kind]
      );
      expect(typeof implementation.nodeClass.instantiate).toBe("function");
    }
  });

  it("indexes every implementation by kind", () => {
    expect(MASTRA_NODE_IMPLEMENTATION_BY_KIND.size).toBe(
      MASTRA_NODE_IMPLEMENTATIONS.length
    );
    for (const implementation of MASTRA_NODE_IMPLEMENTATIONS) {
      expect(MASTRA_NODE_IMPLEMENTATION_BY_KIND.get(implementation.kind)).toBe(
        implementation
      );
    }
  });

  it("fails the audit closed on a missing implementation", () => {
    const gaps = auditMastraNodeCoverage(["core.agent.unknownKind"]);
    expect(gaps).toEqual([
      { kind: "core.agent.unknownKind", reason: "missing-implementation" },
    ]);
    expect(() => assertMastraNodeCoverage(["core.agent.unknownKind"])).toThrow(
      /core\.agent\.unknownKind \(missing-implementation\)/
    );
  });
});

describe("createMastraNodeStepHandlers (SAA-1143)", () => {
  it("returns exactly one handler per mastra kind and no local kind", () => {
    const handlers = createMastraNodeStepHandlers();
    const kinds = handlers.map((handler) => handler.kind);

    expect(new Set(kinds).size).toBe(kinds.length);
    expect([...kinds].sort()).toEqual([...MASTRA_ONLY_NODE_KINDS].sort());
    expect(kinds.filter((kind) => !graphNodeRequiresMastraEngine(kind))).toEqual(
      []
    );
    for (const local of LOCAL_KINDS) {
      expect(kinds).not.toContain(local);
    }
  });

  it("builds each implementation's handler set for its own kind only", () => {
    for (const implementation of MASTRA_NODE_IMPLEMENTATIONS) {
      const handlers = implementation.createStepHandlers({});
      expect(handlers).toHaveLength(1);
      expect(handlers[0]?.kind).toBe(implementation.kind);
    }
  });
});
