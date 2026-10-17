/**
 * @module as-graph/tests/unit/graph/mastra/MastraConnectionCategoryRule
 * @summary Unit tests for the SAA-836 M3 same-category connection rule and the
 * `allowedPortCategories` port-policy mapping.
 * @description Pins `GraphConnectionPolicyValidator`'s `connection.category-mismatch`
 * rule (when both connection ports declare a category, they must match) between
 * two family nodes (e.g. tool→tool passes, tool→skill is rejected), the
 * `allowedPortCategories` mapping from `@connection` `connectionRules` through the
 * manifest compiler, and its enforcement as `connection.policy`.
 *
 * The per-family agent port zones (categories `memory`/`scorers`/...) are slice
 * M1 (SAA-837) and are not landed here, so family→agent acceptance is exercised
 * only through the same-category rule between family nodes (as scoped by the
 * handoff).
 */
import { describe, it, expect } from "@jest/globals";
import { Context } from "@decaf-ts/core";
import { Model, model } from "@decaf-ts/decorator-validation";
import { graphNodeManifest } from "../../../../src/shared/graph";
import { connection, node } from "../../../../src/shared/graph";
import { GraphWorkflowDocumentValidator } from "../../../../src/engine/validation/GraphWorkflowDocumentValidator";
import { registerBuiltInGraphNodes } from "../../../../src/engine/catalog/GraphBuiltInRegistrations";
import { defineGraphNode } from "../../../../src/engine/catalog/GraphNodeRegistration";
import type { GraphNodeCatalogue } from "../../../../src/engine/catalog/GraphNodeCatalogue";
import type { GraphWorkflowDocument } from "../../../../src/shared/graph";
import {
  documentEdge,
  documentNode,
  freshCatalogue,
} from "../engine-fixtures";

/**
 * A node whose single `tools` connection port additionally restricts its accepted
 * source categories to `memory` — used to isolate the `connection.policy` rule
 * from the same-category rule (the source and target categories are equal).
 */
@node("test.policy.target", { kind: "test.policy.target", category: "Agent" })
@model()
class PolicyTargetNode extends Model {
  @connection({
    category: "tools",
    handle: "tool",
    connectionRules: { allowedPortCategories: ["memory"] },
  })
  tool!: unknown;
}

/** Boots a fresh catalogue with the built-in kinds registered. */
async function builtInCatalogue(): Promise<GraphNodeCatalogue> {
  const catalogue = freshCatalogue();
  await registerBuiltInGraphNodes(catalogue);
  return catalogue;
}

/** Validates a document through the nine-stage gate and returns its issues. */
async function issuesOf(
  doc: GraphWorkflowDocument,
  catalogue: GraphNodeCatalogue
) {
  const validator = new GraphWorkflowDocumentValidator({ catalogue });
  const result = await validator.validate(doc, 0, new Context());
  return result.issues;
}

/** A document with two connection ports wired by a `connection` edge. */
function connectionDocument(
  id: string,
  source: { id: string; kind: string; parameters?: Record<string, unknown> },
  target: { id: string; kind: string; parameters?: Record<string, unknown> },
  sourcePort: string,
  targetPort: string
): GraphWorkflowDocument {
  return {
    id,
    name: id,
    inputs: [],
    outputs: [],
    nodes: [
      documentNode(source.id, source.kind, source.parameters ?? {}),
      documentNode(target.id, target.kind, target.parameters ?? {}),
    ],
    edges: [
      documentEdge(
        "e1",
        ["node", source.id, sourcePort],
        ["node", target.id, targetPort],
        "connection"
      ),
    ],
  };
}

describe("same-category connection rule (SAA-836 M3)", () => {
  it("accepts a tools→tools edge between two family nodes", async () => {
    const catalogue = await builtInCatalogue();
    const issues = await issuesOf(
      connectionDocument(
        "tool-to-tool",
        { id: "toolA", kind: "core.agent.tool" },
        { id: "toolB", kind: "core.agent.tool" },
        "tool",
        "tool"
      ),
      catalogue
    );
    expect(issues.map((issue) => issue.code)).not.toContain(
      "connection.category-mismatch"
    );
  });

  it("accepts a tools→tools edge between different tool-family kinds", async () => {
    const catalogue = await builtInCatalogue();
    const issues = await issuesOf(
      connectionDocument(
        "tool-to-selector",
        { id: "toolA", kind: "core.agent.tool" },
        { id: "selector", kind: "core.agent.toolSelector" },
        "tool",
        "tool"
      ),
      catalogue
    );
    expect(issues.map((issue) => issue.code)).not.toContain(
      "connection.category-mismatch"
    );
  });

  it("rejects a tools→skill edge with connection.category-mismatch", async () => {
    const catalogue = await builtInCatalogue();
    const issues = await issuesOf(
      connectionDocument(
        "tool-to-skill",
        { id: "toolA", kind: "core.agent.tool" },
        { id: "skillB", kind: "core.agent.skill", parameters: { name: "s" } },
        "tool",
        "skill"
      ),
      catalogue
    );
    const mismatch = issues.find(
      (issue) => issue.code === "connection.category-mismatch"
    );
    expect(mismatch).toBeDefined();
    expect(mismatch?.edgeId).toBe("e1");
    expect(mismatch?.details).toEqual({
      sourceCategory: "tools",
      targetCategory: "skill",
    });
  });

  it("rejects a tools→hooks edge (hook zone) with connection.category-mismatch", async () => {
    const catalogue = await builtInCatalogue();
    const issues = await issuesOf(
      connectionDocument(
        "tool-to-hook",
        { id: "toolA", kind: "core.agent.tool" },
        { id: "hookB", kind: "core.agent.hook" },
        "tool",
        "hook"
      ),
      catalogue
    );
    expect(issues.map((issue) => issue.code)).toContain(
      "connection.category-mismatch"
    );
  });

  it("leaves a category-less connection port (tool deny) out of the rule", async () => {
    const catalogue = await builtInCatalogue();
    const issues = await issuesOf(
      connectionDocument(
        "tool-to-deny",
        { id: "toolA", kind: "core.agent.tool" },
        { id: "deny", kind: "core.agent.toolDeny" },
        "tool",
        "tool"
      ),
      catalogue
    );
    // tool deny declares no connection port, so the edge fails at stage 5 and
    // the category rule never sees a pair of categories.
    expect(issues.map((issue) => issue.code)).not.toContain(
      "connection.category-mismatch"
    );
  });
});

describe("allowedPortCategories policy mapping (SAA-836 M3)", () => {
  it("maps @connection connectionRules.allowedPortCategories onto the port policy", () => {
    const manifest = graphNodeManifest(PolicyTargetNode);
    const port = (manifest.connections ?? []).find(
      (candidate) => candidate.id === "tool"
    );
    expect(port?.category).toBe("tools");
    expect(port?.connectionPolicy).toEqual({
      allowedPortCategories: ["memory"],
    });
  });

  it("enforces allowedPortCategories as connection.policy (categories equal)", async () => {
    const catalogue = await builtInCatalogue();
    await catalogue.register(
      defineGraphNode({
        manifest: graphNodeManifest(PolicyTargetNode),
        executor: { execute: () => ({}) },
      })
    );
    const issues = await issuesOf(
      connectionDocument(
        "tool-to-policy",
        { id: "toolA", kind: "core.agent.tool" },
        { id: "target", kind: "test.policy.target" },
        "tool",
        "tool"
      ),
      catalogue
    );
    const policyIssue = issues.find(
      (issue) => issue.code === "connection.policy"
    );
    expect(policyIssue).toBeDefined();
    expect(policyIssue?.details).toEqual({
      allowedPortCategories: ["memory"],
    });
    expect(issues.map((issue) => issue.code)).not.toContain(
      "connection.category-mismatch"
    );
  });
});
