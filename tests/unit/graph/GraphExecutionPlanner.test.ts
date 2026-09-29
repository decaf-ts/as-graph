/**
 * @module as-graph/tests/unit/graph/GraphExecutionPlanner.test
 * @summary Unit tests for the graph execution planner (Kahn's algorithm).
 * @description DECAF-50 §4.9 contract: the planner accepts ONLY resolved
 * workflows produced by the nine-stage validation gate. Raw
 * `GraphWorkflowDefinition` objects and inline `GraphNodeDefinition` objects
 * are rejected.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

import { GraphCycleError } from "../../../src/engine/errors/GraphCycleError";
import { GraphTopologyError } from "../../../src/engine/errors/GraphTopologyError";
import { GraphExecutionPlanner } from "../../../src/engine/planning/GraphExecutionPlanner";
import { linearWorkflow } from "./engine-fixtures";

import {
  cyclicDocument,
  handResolvedWorkflow,
  linearDocument,
  resolveDocument,
} from "./engine-fixtures";

describe("GraphExecutionPlanner", () => {
  it("plans a resolved linear workflow into ordered topological layers", async () => {
    const planner = new GraphExecutionPlanner();
    const plan = planner.plan(await resolveDocument(linearDocument()));

    expect(plan.workflowId).toBe("linear-wf");
    expect(plan.nodes).toHaveLength(2);
    expect(plan.edges.length).toBe(4);
    expect(plan.layers.length).toBeGreaterThanOrEqual(2);

    // adder has no executable-node dependencies -> layer 0
    const layer0 = plan.layers[0];
    expect(layer0.nodes.map((n) => n.id)).toContain("adder");

    // multiplier depends on adder -> layer 1
    const layer1 = plan.layers[1];
    expect(layer1.nodes.map((n) => n.id)).toContain("multiplier");
  });

  it("accepts only resolved workflows — raw definitions are rejected (§4.19: raw GraphWorkflowDefinition objects)", () => {
    const planner = new GraphExecutionPlanner();
    const planCall = () => planner.plan(linearWorkflow() as never);
    expect(planCall).toThrow(GraphTopologyError);
    try {
      planCall();
    } catch (error) {
      expect((error as GraphTopologyError).message).toContain(
        "accepts only a GraphResolvedWorkflow"
      );
    }
  });

  it("accepts only resolved workflows — inline raw node definitions are rejected (§4.19: raw GraphNodeDefinition objects)", () => {
    const planner = new GraphExecutionPlanner();
    const raw = {
      nodes: [
        {
          id: "adder",
          kind: "math.add",
          node: {
            name: "adder",
            tag: "adder",
            kind: "math.add",
            labels: [],
            ports: [],
          },
        },
      ],
      relations: [],
    };
    expect(() => planner.plan(raw as never)).toThrow(GraphTopologyError);
  });

  it("accepts only resolved workflows — definition-shaped objects that skip the resolved lookup maps are rejected (§4.20 P3 gate)", () => {
    const planner = new GraphExecutionPlanner();
    // Carries the resolved-workflow report arrays over a canonical document
    // but without the `nodeById`/`incomingByNode`/`outgoingByNode` maps that
    // only the nine-stage resolution produces — the guard must still refuse.
    const notActuallyResolved = {
      document: linearDocument(),
      nodes: [
        { instance: { id: "adder", kind: "math.add", parameters: {} }, manifest: {}, executor: { execute: () => ({}) } },
      ],
      edges: [],
    };
    expect(() => planner.plan(notActuallyResolved as never)).toThrow(GraphTopologyError);
  });

  it("carries the canonical instance, manifest, and executor on plan nodes", async () => {
    const planner = new GraphExecutionPlanner();
    const resolved = await resolveDocument(linearDocument());
    const plan = planner.plan(resolved);

    const adder = plan.nodes.find((n) => n.id === "adder")!;
    expect(adder.instance).toBe(resolved.nodeById.get("adder")!.instance);
    expect(adder.manifest.kind).toBe("math.add");
    expect(adder.executor).toBe(resolved.nodeById.get("adder")!.executor);
  });

  it("builds incoming and outgoing edge maps", async () => {
    const planner = new GraphExecutionPlanner();
    const plan = planner.plan(await resolveDocument(linearDocument()));

    const incoming = plan.incomingByNode.get("adder") ?? [];
    expect(incoming.length).toBe(2);

    const outgoing = plan.outgoingByNode.get("adder") ?? [];
    expect(outgoing.length).toBe(1);
    expect(outgoing[0].targetNodeId).toBe("multiplier");
  });

  it("never routes values along structural connection edges", async () => {
    const planner = new GraphExecutionPlanner();
    const plan = planner.plan(await resolveDocument(linearDocument()));
    for (const edge of plan.edges) {
      expect(edge.type).toBe("data");
    }
  });

  it("throws GraphCycleError for cyclic workflows", () => {
    const planner = new GraphExecutionPlanner();
    const resolved = handResolvedWorkflow(
      cyclicDocument(),
      [
        { id: "adder", kind: "math.add", inputs: ["a"], outputs: ["sum"] },
        { id: "multiplier", kind: "math.multiply", inputs: ["x"], outputs: ["product"] },
      ],
      [
        ["e1", "adder", "sum", "multiplier", "x"],
        ["e2", "multiplier", "product", "adder", "a"],
      ]
    );
    expect(() => planner.plan(resolved)).toThrow(GraphCycleError);
  });

  it("assigns incremental layer indices", async () => {
    const planner = new GraphExecutionPlanner();
    const plan = planner.plan(await resolveDocument(linearDocument()));
    plan.layers.forEach((layer, i) => {
      expect(layer.index).toBe(i);
    });
  });
});

/**
 * DECAF-50 §4.19 "Planner and engine" — named test 1 + item 2/§4.20 P3 gate.
 *
 * The planner's module SURFACE (what a bundler compiles, comments stripped)
 * must contain no `graphDefinitionOf()` reference and no
 * `GraphRelationResolver` (deleted at P3). `graphDefinitionOf()` is the
 * decorated-workflow compiler helper and its only remaining runtime usages
 * live in `ui-decorators/src/graph/nodes/flow-control/switch.ts` (§4.18 decorated path,
 * outside the engine); the planning module keeps exactly one doc-comment
 * mention at source level, which compilation strips — so the compiled
 * surface is the honest observable here.
 */

/** Locates the planning module TS sources from the test working directory. */
function locatePlanningDir(): string {
  const candidates = ["src/engine/planning", "src/graph/engine/planning"];
  for (const candidate of candidates) {
    const dir = join(process.cwd(), candidate);
    if (existsSync(dir)) return dir;
  }
  throw new Error(
    `§4.19 compiled-surface scan could not locate the planning module sources (cwd=${process.cwd()}; candidates=${candidates.join(", ")})`
  );
}

/**
 * Compiles a planning module file the way a bundler would see it: TypeScript
 * transpiled with comments REMOVED (so the lone doc-comment mention of
 * `graphDefinitionOf` cannot satisfy the gate).
 */
function compilePlanningFile(file: string): string {
  const filePath = join(locatePlanningDir(), file);
  const source = readFileSync(filePath, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      removeComments: true,
      esModuleInterop: true,
    },
    fileName: file,
    reportDiagnostics: true,
  });
  const diagnostics = (result.diagnostics ?? []) as ts.Diagnostic[];
  expect(diagnostics).toEqual([]);
  return result.outputText;
}

describe("DECAF-50 §4.19 planner/engine — planner module surface", () => {
  it("compiled planning module surface contains no graphDefinitionOf (doc-comment mention only at source level) and no GraphRelationResolver", () => {
    const dir = locatePlanningDir();
    const files = readdirSync(dir).filter((file) => file.endsWith(".ts"));
    expect(files).toContain("GraphExecutionPlanner.ts");

    for (const file of files) {
      const compiled = compilePlanningFile(file);
      expect({ file, surface: /graphDefinitionOf/.test(compiled) })
        .toEqual({ file, surface: false });
      expect({ file, surface: /GraphRelationResolver/.test(compiled) })
        .toEqual({ file, surface: false });
    }

    // Non-vacuity: the scan only counts when the compiled planner is real
    // module output (class + resolved-workflow guard present).
    const planner = compilePlanningFile("GraphExecutionPlanner.ts");
    expect(planner).toContain("class GraphExecutionPlanner");
    expect(planner).toContain("plan(workflow");
    expect(planner).toContain("isGraphResolvedWorkflow");
  });

  it("keeps exactly one graphDefinitionOf mention in the planning sources and it is the module doc comment", () => {
    const raw = readFileSync(join(locatePlanningDir(), "GraphExecutionPlanner.ts"), "utf8");
    const occurrences = [...raw.matchAll(/graphDefinitionOf/g)].map((m) => m.index as number);
    expect(occurrences).toHaveLength(1);
    // The single mention sits inside the module JSDoc (before the imports).
    const firstImport = raw.indexOf("import ");
    expect(occurrences[0]).toBeLessThan(firstImport);
  });
});
