/**
 * @module as-graph/tests/unit/graph/GraphLooseNodeValidation
 * @summary DECAF-50 §4.26 R2-3 item 8 regression tests: loose-node
 * validation at both gates, including nested loop bodies.
 * @description Pins {@link collectLooseNodeIssues}: every node instance must
 * participate in at least one edge (data or connection), and the rule is shared
 * by the execution gate ({@link GraphWorkflowDocumentValidator}) and the
 * persistence gate ({@link validateGraphWorkflowDocumentAtBoundary}) so both
 * start and save reject a loose node. Nested loop-body documents are checked
 * recursively.
 */
import { jest, describe, beforeAll, it, expect } from "@jest/globals";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";

import {
  GraphNodeCatalogue,
  GraphWorkflowDocumentValidator,
} from "../../../src";
import { validateGraphWorkflowDocumentAtBoundary } from "../../../src/engine/validation/GraphWorkflowBoundaryValidation";
import { documentEdge, documentNode, freshCatalogue } from "./engine-fixtures";

jest.setTimeout(20000);

/** A single loose node of a registered lenient kind. */
function looseDocument(workflowId: string): GraphWorkflowDocument {
  return {
    id: workflowId,
    name: workflowId,
    inputs: [],
    outputs: [],
    nodes: [documentNode(`${workflowId}-n1`, "test.flow")],
    edges: [],
  };
}

/** Two nodes joined by a data edge: neither is loose. */
function connectedDocument(workflowId: string): GraphWorkflowDocument {
  return {
    id: workflowId,
    name: workflowId,
    inputs: [],
    outputs: [],
    nodes: [
      documentNode(`${workflowId}-n1`, "test.flow"),
      documentNode(`${workflowId}-n2`, "test.flow"),
    ],
    edges: [
      documentEdge(
        `${workflowId}-e1`,
        ["node", `${workflowId}-n1`, "out"],
        ["node", `${workflowId}-n2`, "in"]
      ),
    ],
  };
}

/** An outer loop node whose body contains a single loose node. */
function nestedLooseDocument(workflowId: string): GraphWorkflowDocument {
  return {
    id: workflowId,
    name: workflowId,
    inputs: [],
    outputs: [],
    nodes: [
      documentNode(`${workflowId}-loop`, "test.loop", {}, {
        loop: {
          body: {
            id: `${workflowId}-body`,
            name: `${workflowId}-body`,
            inputs: [],
            outputs: [],
            nodes: [documentNode(`${workflowId}-inner`, "test.flow")],
            edges: [],
          },
        },
      } as never),
      documentNode(`${workflowId}-sink`, "test.flow"),
    ],
    edges: [
      documentEdge(
        `${workflowId}-e1`,
        ["node", `${workflowId}-loop`, "out"],
        ["node", `${workflowId}-sink`, "in"]
      ),
    ],
  };
}

describe("GraphLooseNodeValidation (DECAF-50 §4.26 R2-3(8))", () => {
  let catalogue: GraphNodeCatalogue;
  let validator: GraphWorkflowDocumentValidator;

  beforeAll(async () => {
    catalogue = freshCatalogue();
    for (const kind of ["test.flow", "test.loop"]) {
      await catalogue.registerExecutor(kind, {
        execute: async () => ({ out: true }),
      });
    }
    validator = new GraphWorkflowDocumentValidator({ catalogue });
  });

  it("1. start gate: a single loose node is flagged with topology.loose-node and the document is invalid", async () => {
    const result = await validator.validate(looseDocument("loose-start"));

    expect(result.valid).toBe(false);
    const issue = (result.issues ?? []).find(
      (candidate) => candidate.code === "topology.loose-node"
    );
    expect(issue).toBeDefined();
    expect(issue?.nodeId).toBe("loose-start-n1");
    expect(issue?.path).toBe("$.nodes[loose-start-n1]");
  });

  it("2. start gate: a document whose nodes all participate in an edge has no topology.loose-node issue", async () => {
    const result = await validator.validate(connectedDocument("connected-start"));

    expect(
      (result.issues ?? []).some(
        (candidate) => candidate.code === "topology.loose-node"
      )
    ).toBe(false);
    expect(result.valid).toBe(true);
  });

  it("3. save gate: the persistence boundary flags the same loose node", async () => {
    const result = await validateGraphWorkflowDocumentAtBoundary(
      looseDocument("loose-save"),
      { catalogue }
    );

    expect(result.valid).toBe(false);
    const issue = result.issues.find(
      (candidate) => candidate.code === "topology.loose-node"
    );
    expect(issue).toBeDefined();
    expect(issue?.nodeId).toBe("loose-save-n1");
  });

  it("4. save gate: a fully connected document passes with no topology.loose-node issue", async () => {
    const result = await validateGraphWorkflowDocumentAtBoundary(
      connectedDocument("connected-save"),
      { catalogue }
    );

    expect(
      result.issues.some(
        (candidate) => candidate.code === "topology.loose-node"
      )
    ).toBe(false);
  });

  it("5. nested loop bodies are checked recursively at the exact nested path", async () => {
    const result = await validator.validate(nestedLooseDocument("nested"));

    const issue = (result.issues ?? []).find(
      (candidate) =>
        candidate.code === "topology.loose-node" &&
        candidate.nodeId === "nested-inner"
    );
    expect(issue).toBeDefined();
    expect(issue?.path).toBe(
      "nodes[nested-loop].loop.body.$.nodes[nested-inner]"
    );
  });

  it("6. a connected nested loop body has no topology.loose-node issue", async () => {
    const document = nestedLooseDocument("nested-ok");
    document.nodes[0].loop!.body = connectedDocument("nested-ok-body");

    const result = await validator.validate(document);
    expect(
      (result.issues ?? []).some(
        (candidate) => candidate.code === "topology.loose-node"
      )
    ).toBe(false);
  });
});
