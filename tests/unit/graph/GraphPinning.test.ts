/**
 * @module as-graph/tests/unit/graph/GraphPinning.test
 * @summary Engine cache-pinning unit tests (pinning policy, dependency resolver,
 * and service).
 * @description DECAF-50 §4.9 pinning semantics: fingerprints derive from node
 * kind, parameters, bindings, effective inputs, relevant metadata, and
 * dependency fingerprints; presentation-only UI state is excluded.
 *
 * SCOPE (T8 relabel, DECAF-50 §4.24): this suite covers the ENGINE's cache
 * pinning only (`GraphPinning*`). It is NOT the UI pin-button contract — UI
 * data pinning (pin writes the canonical document, survives save/load, freezes
 * parameter values for downstream runs, and renders only when pinnable) is covered
 * by `for-angular` (`GraphDataPinning.spec.ts` + `tests/playwright/graph/`).
 * The two must never be conflated (G3-15).
 */
import { GraphExecutionPlanner } from "../../../src/engine/planning/GraphExecutionPlanner";
import { GraphPinningDependencyResolver } from "../../../src/engine/pinning/GraphPinningDependencyResolver";
import { GraphPinningPolicy } from "../../../src/engine/pinning/GraphPinningPolicy";
import { GraphPinningService } from "../../../src/engine/pinning/GraphPinningService";
import { InMemoryGraphValueStoreAdapter } from "../../../src/engine/store/InMemoryGraphValueStoreAdapter";
import { GraphValueStore } from "../../../src/engine/store/GraphValueStore";
import type { GraphExecutionPlanNode } from "../../../src/engine/planning/GraphExecutionPlanNode";
import type { GraphExecutionResult } from "../../../src/engine/types";

import { linearDocument, resolveDocument } from "./engine-fixtures";

const PINNABLE = {
  enabled: true,
  strategy: "manual",
  includeDependencies: true,
};

function makePlanNode(id: string, pinnable: boolean): GraphExecutionPlanNode {
  return {
    id,
    kind: "test",
    instance: {
      id,
      kind: "test",
      parameters: {},
      metadata: pinnable ? { pinnable: PINNABLE } : {},
    },
    manifest: {
      kind: "test",
      display: { name: "test" },
      inputs: [],
      outputs: [],
      parameters: [],
      ...(pinnable ? { metadata: {} } : {}),
    },
    executor: { execute: () => ({}) },
    inputPorts: [],
    outputPorts: [],
    connectionPorts: [],
    metadata: pinnable ? { pinnable: PINNABLE } : {},
  } as unknown as GraphExecutionPlanNode;
}

describe("GraphPinningPolicy", () => {
  const policy = new GraphPinningPolicy();

  it("canPin returns true when metadata.enabled is true and strategy is not disabled", () => {
    expect(policy.canPin(makePlanNode("n1", true))).toBe(true);
  });

  it("canPin returns false when not enabled", () => {
    expect(policy.canPin(makePlanNode("n1", false))).toBe(false);
  });

  it("shouldUsePinnedValue respects enabled and strategy", () => {
    expect(policy.shouldUsePinnedValue(makePlanNode("n1", true))).toBe(true);
    expect(policy.shouldUsePinnedValue(makePlanNode("n1", false))).toBe(false);
  });

  it("shouldAutoPin returns true only for automatic strategy", () => {
    const node = makePlanNode("n1", true);
    (node.metadata as Record<string, unknown>)["pinnable"] = {
      ...PINNABLE,
      strategy: "automatic",
    };
    expect(policy.shouldAutoPin(node)).toBe(true);
    (node.metadata as Record<string, unknown>)["pinnable"] = {
      ...PINNABLE,
      strategy: "manual",
    };
    expect(policy.shouldAutoPin(node)).toBe(false);
  });
});

describe("GraphPinningDependencyResolver", () => {
  it("getDependencies returns upstream nodes excluding boundary", async () => {
    const plan = new GraphExecutionPlanner().plan(
      await resolveDocument(linearDocument())
    );
    const resolver = new GraphPinningDependencyResolver();
    const deps = resolver.getDependencies(plan, "multiplier");
    expect(deps.has("adder")).toBe(true);
  });

  it("getPinSet includes the node itself plus dependencies", async () => {
    const plan = new GraphExecutionPlanner().plan(
      await resolveDocument(linearDocument())
    );
    const resolver = new GraphPinningDependencyResolver();
    const set = resolver.getPinSet(plan, "multiplier");
    expect(set.has("multiplier")).toBe(true);
    expect(set.has("adder")).toBe(true);
  });
});

describe("GraphPinningService", () => {
  async function pinnedLinearPlan() {
    const resolved = await resolveDocument(linearDocument());
    const plan = new GraphExecutionPlanner().plan(resolved);
    // Mark every node pinnable through instance metadata.
    for (const node of plan.nodes) {
      node.metadata = { ...(node.metadata ?? {}), pinnable: PINNABLE };
      node.instance.metadata = {
        ...(node.instance.metadata ?? {}),
        pinnable: PINNABLE,
      };
    }
    return plan;
  }

  function makeService(): GraphPinningService {
    const store = new GraphValueStore(new InMemoryGraphValueStoreAdapter());
    return new GraphPinningService(
      store,
      new GraphPinningPolicy(),
      new GraphPinningDependencyResolver()
    );
  }

  it("computeFingerprint is deterministic for identical inputs", async () => {
    const plan = await pinnedLinearPlan();
    const service = makeService();
    const node = plan.nodes.find((n) => n.id === "adder")!;
    const fp1 = service.computeFingerprint(plan.workflowId, node, { a: 1, b: 2 }, {});
    const fp2 = service.computeFingerprint(plan.workflowId, node, { a: 1, b: 2 }, {});
    expect(fp1).toBe(fp2);
  });

  it("computeFingerprint changes when inputs change", async () => {
    const plan = await pinnedLinearPlan();
    const service = makeService();
    const node = plan.nodes.find((n) => n.id === "adder")!;
    const fp1 = service.computeFingerprint(plan.workflowId, node, { a: 1, b: 2 }, {});
    const fp2 = service.computeFingerprint(plan.workflowId, node, { a: 1, b: 3 }, {});
    expect(fp1).not.toBe(fp2);
  });

  it("computeFingerprint changes when parameters change", async () => {
    const plan = await pinnedLinearPlan();
    const service = makeService();
    const node = plan.nodes.find((n) => n.id === "adder")!;
    const before = service.computeFingerprint(plan.workflowId, node, { a: 1 }, {});
    node.instance.parameters = { precision: 2 };
    const after = service.computeFingerprint(plan.workflowId, node, { a: 1 }, {});
    expect(before).not.toBe(after);
  });

  it("computeFingerprint excludes presentation-only UI state", async () => {
    const plan = await pinnedLinearPlan();
    const service = makeService();
    const node = plan.nodes.find((n) => n.id === "adder")!;
    const before = service.computeFingerprint(plan.workflowId, node, { a: 1 }, {});
    // Canvas position / UI state changes must NOT affect the fingerprint.
    node.instance.ui = {
      position: { x: 999, y: 999 },
      collapsed: true,
    } as never;
    node.metadata = { ...(node.metadata ?? {}), ui: { theme: "dark" } };
    const after = service.computeFingerprint(plan.workflowId, node, { a: 1 }, {});
    expect(after).toBe(before);
  });

  it("computeFingerprint is stable regardless of key ordering in inputs", async () => {
    const plan = await pinnedLinearPlan();
    const service = makeService();
    const node = plan.nodes.find((n) => n.id === "adder")!;
    const fp1 = service.computeFingerprint(plan.workflowId, node, { a: 1, b: 2 }, {});
    const fp2 = service.computeFingerprint(plan.workflowId, node, { b: 2, a: 1 }, {});
    expect(fp1).toBe(fp2);
  });

  it("readPinnedValue returns undefined when nothing is pinned", async () => {
    const plan = await pinnedLinearPlan();
    const service = makeService();
    const node = plan.nodes.find((n) => n.id === "adder")!;
    const result = await service.readPinnedValue(plan.workflowId, node, {}, {});
    expect(result).toBeUndefined();
  });

  it("pinNode writes pinned values and readPinnedValue returns them", async () => {
    const plan = await pinnedLinearPlan();
    const service = makeService();
    const node = plan.nodes.find((n) => n.id === "adder")!;
    const fakeResult = {
      runId: "r1",
      workflowId: "linear-wf",
      status: "succeeded",
      document: plan.resolved.document,
      inputs: { a: 1, b: 2 },
      outputs: {},
      nodeResults: {
        adder: {
          nodeId: "adder",
          status: "succeeded",
          inputs: { a: 1, b: 2 },
          outputs: { sum: 3 },
          startedAt: new Date(),
          events: [],
        },
        multiplier: {
          nodeId: "multiplier",
          status: "succeeded",
          inputs: { x: 3 },
          outputs: { product: 6 },
          startedAt: new Date(),
          events: [],
        },
      },
      events: [],
      startedAt: new Date(),
    } as unknown as GraphExecutionResult;

    await service.pinNode({
      document: plan.resolved.document,
      plan,
      result: fakeResult,
      nodeId: "adder",
      includeDependencies: false,
    });

    const cached = await service.readPinnedValue(plan.workflowId, node, { a: 1, b: 2 }, {});
    expect(cached?.pinned).toBe(true);
    expect(cached?.outputs.sum).toBe(3);
  });

  it("unpinNode removes the pinned value", async () => {
    const plan = await pinnedLinearPlan();
    const service = makeService();
    const node = plan.nodes.find((n) => n.id === "adder")!;
    const fakeResult = {
      runId: "r1",
      workflowId: "linear-wf",
      status: "succeeded",
      document: plan.resolved.document,
      inputs: { a: 1, b: 2 },
      outputs: {},
      nodeResults: {
        adder: {
          nodeId: "adder",
          status: "succeeded",
          inputs: { a: 1, b: 2 },
          outputs: { sum: 3 },
          startedAt: new Date(),
          events: [],
        },
      },
      events: [],
      startedAt: new Date(),
    } as unknown as GraphExecutionResult;

    await service.pinNode({
      document: plan.resolved.document,
      plan,
      result: fakeResult,
      nodeId: "adder",
      includeDependencies: false,
    });

    const fingerprint = service.computeFingerprint(plan.workflowId, node, { a: 1, b: 2 }, {});
    await service.unpinNode({
      document: plan.resolved.document,
      nodeId: "adder",
      fingerprint,
    });

    const cached = await service.readPinnedValue(plan.workflowId, node, { a: 1, b: 2 }, {});
    expect(cached).toBeUndefined();
  });
});
