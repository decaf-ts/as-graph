/**
 * @module as-graph/tests/integration/graph/workflow-upgrade.test
 * @summary SAA-2115 items 3/4 execution evidence: a `@state()` node hydrates
 * from its persisted state, and the `order-triage` reference workflow executes
 * through the real engine on every authoring path the current src supports.
 * @description Boots the real built-in catalogue + isolated-vm sandbox evaluator,
 * validates each document through the nine-stage gate, and executes it. SAA-3 fixed
 * four of the defects this suite originally documented (switch `defaultPort`,
 * the if→switch diamond merge, code-as-metadata, and undefined loop keys), so
 * those tests now assert the corrected behavior. The built-in node executor
 * re-applies persisted `state` last (merge order `metadata` → `parameters` →
 * `state`), so a `@state()` value wins over a same-named parameter; the
 * state-collision tests below assert that production behavior. The code nodes are
 * driven through the real built-in `core.utility.code` executor, which reads
 * `request.parameters.code` when no literal `code` binding is present.
 */
import { describe, it, expect } from "@jest/globals";

import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { graphNodeManifest } from "../../../src/shared/graph";
import { defineGraphNode } from "../../../src/engine/catalog/GraphNodeRegistration";
import {
  buildOrderTriageWithBuilder,
  buildOrderTriageWithFlowBuilder,
  buildStatefulWithBuilder,
  compileOrderTriage,
  compileStatefulFixture,
  orderTriageDocument,
  ORDER_TRIAGE_TRIAGE_CODE,
  StatefulFixtureNode,
} from "../../fixtures/workflows/order-triage.workflow";
import {
  bootFixtureEngine,
  runFixtureDocument,
} from "../../fixtures/workflows/engine";
import {
  nodeExecutor,
  resolveDocument,
} from "../../unit/graph/engine-fixtures";

async function bootStatefulEngine() {
  const { engine, catalogue } = await bootFixtureEngine();
  await catalogue.register(
    defineGraphNode({
      manifest: graphNodeManifest(StatefulFixtureNode),
      executor: nodeExecutor(StatefulFixtureNode),
    })
  );
  return { engine, catalogue };
}

function statefulDocument(
  state: Record<string, unknown>,
  parameters: Record<string, unknown> = {}
): GraphWorkflowDocument {
  return {
    id: "fixture-stateful-wf",
    name: "StatefulFixtureWorkflow",
    inputs: [{ id: "value" }],
    outputs: [{ id: "result" }],
    nodes: [
      { id: "stateful", kind: "fixture.stateful-node", parameters, state },
    ],
    edges: [
      {
        id: "e1",
        type: "data",
        source: { scope: "workflow", port: "value" },
        target: { scope: "node", nodeId: "stateful", port: "value" },
      },
      {
        id: "e2",
        type: "data",
        source: { scope: "node", nodeId: "stateful", port: "result" },
        target: { scope: "workflow", port: "result" },
      },
    ],
  };
}

/** Returns the validator issues a document fails with, or `[]` when it passes. */
async function validationIssues(
  document: GraphWorkflowDocument
): Promise<{ code: string; path: string }[]> {
  const { catalogue } = await bootFixtureEngine();
  try {
    await resolveDocument(document, catalogue);
    return [];
  } catch (e) {
    const issues = (e as { issues?: { code: string; path: string }[] }).issues;
    if (issues) return issues;
    throw e;
  }
}

describe("as-graph integration — workflow upgrade (SAA-2115)", () => {
  it("executes a @state() node hydrated from its persisted state", async () => {
    const { engine, catalogue } = await bootStatefulEngine();
    const document = statefulDocument({ counter: "state-default" });
    await resolveDocument(document, catalogue);

    const result = await engine.execute(document, { value: 5 });

    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toBe("state-default");
    expect(result.nodeResults.stateful.inputs).toEqual({ value: 5 });
    expect(result.nodeResults.stateful.outputs).toEqual({
      result: "state-default",
    });
  });

  it("lets persisted state win over a colliding parameter at execution", async () => {
    // The built-in executor instantiates the node with
    // `{ ...graphNodeConfig(context.node), ...request.parameters, ...state }`,
    // re-applying persisted state last, so a @state() property wins over a
    // same-named parameter (DECAF-50 §4.5 item 3, proven in node-state.test.ts).
    const { engine, catalogue } = await bootStatefulEngine();
    const document = statefulDocument(
      { counter: "state-default" },
      { counter: "param-default" }
    );
    await resolveDocument(document, catalogue);

    const result = await engine.execute(document, { value: 5 });

    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toBe("state-default");
  });

  it("lets a builder-authored state override win over a colliding parameter", async () => {
    const { engine, catalogue } = await bootStatefulEngine();
    const document = buildStatefulWithBuilder({
      state: { counter: "override-state" },
    });
    expect(document.nodes[0].state).toEqual({ counter: "override-state" });
    expect(document.nodes[0].parameters).toEqual({ counter: "param-default" });
    await resolveDocument(document, catalogue);

    const result = await engine.execute(document, { value: 5 });

    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toBe("override-state");
  });

  it("executes the canonical if→switch diamond merge end to end", async () => {
    // SAA-3 fixed the merge: both the escalate (taken) and standard (skipped)
    // branches feed switch.value, the switch routes `high`, the foreach doubles the
    // item, and the workflow yields [5000] instead of the old [{}].
    const result = await runFixtureDocument(orderTriageDocument, { n: 1500 });

    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.escalate.outputs).toEqual({ result: [2500] });
    expect(result.nodeResults.switch.inputs).toEqual({
      result: undefined,
      value: [2500],
    });
    expect(result.outputs.result).toEqual([5000]);
  });

  it("executes every order-triage authoring path to the canonical result", async () => {
    // SAA-2115 items 3/4: all four authoring paths must execute on the real
    // engine with the same result as the canonical JSON document — the raw builder,
    // the decorated compiler, and the chainable flow builder.
    const canonical = await runFixtureDocument(orderTriageDocument, { n: 1500 });
    expect(canonical.status).toBe("succeeded");
    expect(canonical.outputs.result).toEqual([5000]);

    const paths: [string, GraphWorkflowDocument][] = [
      ["raw document builder", buildOrderTriageWithBuilder()],
      ["decorated compiler", compileOrderTriage()],
      ["chainable flow builder", buildOrderTriageWithFlowBuilder()],
    ];

    for (const [, document] of paths) {
      const result = await runFixtureDocument(document, { n: 1500 });
      expect(result.status).toBe("succeeded");
      expect(result.outputs).toEqual(canonical.outputs);
    }
  });

  it("validates the flow builder document now that switch writes no defaultPort parameter", async () => {
    // SAA-3 removed the undeclared `defaultPort` from the switch node's
    // `parameters` (the dual carrier is now `parameters.cases` + `metadata.switch`),
    // so the flow builder document passes the nine-stage validator.
    const issues = await validationIssues(buildOrderTriageWithFlowBuilder());
    expect(issues).toEqual([]);
  });

  it("decorated compiler authors code in parameters and validates", async () => {
    // SAA-3 moved `core.utility.code` code into `parameters.code`, so the
    // compiled document validates with no `parameter.required-missing` issue.
    const document = compileOrderTriage();
    const triage = document.nodes.find((node) => node.id === "triage");
    expect(triage?.parameters).toHaveProperty("code", ORDER_TRIAGE_TRIAGE_CODE);
    const issues = await validationIssues(document);
    expect(issues).toEqual([]);
  });

  it("decorated compiler omits undefined loop keys and validates", async () => {
    // SAA-3 stopped writing `timeoutMs`/`concurrency` when undefined, so the
    // compiled document passes the JSON-safety gate.
    const document = compileOrderTriage();
    const loop = document.nodes.find((node) => node.id === "foreach")?.loop;
    expect(loop).not.toHaveProperty("timeoutMs");
    expect(loop).not.toHaveProperty("concurrency");
    const issues = await validationIssues(document);
    expect(issues).toEqual([]);
  });

  it("executes the compiled stateful fixture through the real engine", async () => {
    const { engine, catalogue } = await bootStatefulEngine();
    const document = compileStatefulFixture();
    await resolveDocument(document, catalogue);

    const result = await engine.execute(document, { value: 5 });

    expect(result.status).toBe("succeeded");
    expect(result.outputs.result).toBe("state-default");
  });
});
