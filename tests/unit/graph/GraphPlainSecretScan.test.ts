/**
 * @module as-graph/tests/unit/graph/GraphPlainSecretScan
 * @summary SAA-595 F7 regression tests: recursive plain-secret scan
 * (scenario 3 of the SAA-608 review follow-up).
 * @description Pins the recursive plain-secret walk of the stage-8
 * credential validator beyond the TOP-LEVEL `apiKey` case the run-lifecycle
 * suite (test 8b) already covers:
 * - deny-list keys buried in nested objects (`{auth: {apiKey: "sk"}}`), at
 *   depth 3+, and inside arrays (`{list: [{token: "x"}]}`) are flagged with
 *   `credential.plain-secret` and exact nested issue paths — in both node
 *   parameters and node metadata;
 * - clean nested values of the same shapes pass validation untouched;
 * - a self-referencing (cyclic) object value terminates: the depth cap acts
 *   as a cycle guard, and a deny-list key reachable through a cyclic
 *   structure is still found.
 *
 * The engine's fail-fast path is pinned too: executing a document with a
 * nested plain secret throws {@link GraphDocumentValidationError} carrying
 * the same structured issue.
 */
import { jest, describe, beforeAll, it, expect } from "@jest/globals";
import type {
  GraphNodeInstance,
  GraphWorkflowDocument,
} from "../../../src/shared/graph";

import {
  type GraphResolvedNodeManifest,
} from "../../../src/shared/graph";
import {
  GraphCredentialReferenceValidator,
  GraphDocumentValidationError,
  GraphExecutionEngine,
  GraphNodeCatalogue,
  GraphNodeExecutorRegistry,
  GraphWorkflowDocumentValidator,
  type GraphNodeExecutor,
} from "../../../src";
import type { GraphValidationIssue } from "../../../src";
import { documentEdge, documentNode } from "./engine-fixtures";

jest.setTimeout(20000);

/** Builds a single-node document whose node carries the given parameters/metadata. */
function scanDocument(
  workflowId: string,
  parameters?: Record<string, unknown>,
  metadata?: Record<string, unknown>
): GraphWorkflowDocument {
  return {
    id: workflowId,
    name: workflowId,
    inputs: [],
    outputs: [],
    nodes: [
      documentNode(
        `${workflowId}-n1`,
        "test.scan",
        parameters,
        metadata ? { metadata } : {}
      ),
      // a clean sink keeps the scanned node connected: DECAF-50 §4.26
      // R2-3(8) rejects a node that participates in no edge
      documentNode(`${workflowId}-sink`, "test.scan", { sink: true }),
    ],
    edges: [
      documentEdge(
        `${workflowId}-e1`,
        ["node", `${workflowId}-n1`, "out"],
        ["node", `${workflowId}-sink`, "in"]
      ),
    ],
  };
}

function issueOf(
  issues: GraphValidationIssue[],
  code: string
): GraphValidationIssue | undefined {
  return issues.find((candidate) => candidate.code === code);
}

describe("GraphPlainSecretScan (SAA-595 F7 recursive scan)", () => {
  let validator: GraphWorkflowDocumentValidator;
  let engine: GraphExecutionEngine;

  beforeAll(() => {
    const catalogue = new GraphNodeCatalogue();
    engine = new GraphExecutionEngine({
      registry: new GraphNodeExecutorRegistry(catalogue),
    });
    const executor: GraphNodeExecutor = {
      execute: async () => ({ out: true }),
    };
    // placeholder manifest: undeclared parameters are tolerated, so the
    // nested parameter/metadata values reach the stage-8 scan untouched
    catalogue.registerExecutor("test.scan", executor);
    validator = new GraphWorkflowDocumentValidator({ catalogue });
  });

  it("1. deny-list keys nested inside objects are flagged with exact nested paths (parameters and metadata)", async () => {
    const doc = scanDocument(
      "scan-nested",
      { auth: { apiKey: "sk-nested-secret" } },
      { config: { password: "p" } }
    );
    const result = await validator.validate(doc);

    expect(result.valid).toBe(false);
    const issues = result.issues ?? [];
    const paramIssue = issueOf(issues, "credential.plain-secret");
    expect(paramIssue).toBeDefined();
    expect(paramIssue?.path).toBe("nodes[scan-nested-n1].parameters.auth.apiKey");
    expect(paramIssue?.message).toContain("auth.apiKey");

    const metaIssues = issues.filter(
      (candidate) =>
        candidate.code === "credential.plain-secret" &&
        candidate.path.startsWith("nodes[scan-nested-n1].metadata")
    );
    expect(metaIssues).toHaveLength(1);
    expect(metaIssues[0].path).toBe(
      "nodes[scan-nested-n1].metadata.config.password"
    );
  });

  it("2. deny-list keys at depth 3+ and buried inside arrays are flagged", async () => {
    const doc = scanDocument("scan-deep", {
      l1: { l2: { l3: { accessToken: "deep-token" } } },
      list: [{ token: "array-token" }, { harmless: "x" }],
    });
    const result = await validator.validate(doc);

    expect(result.valid).toBe(false);
    const issues = result.issues ?? [];
    const deep = issueOf(issues, "credential.plain-secret");
    expect(deep).toBeDefined();
    expect(deep?.path).toBe(
      "nodes[scan-deep-n1].parameters.l1.l2.l3.accessToken"
    );

    const arrayBuried = issues.find(
      (candidate) =>
        candidate.code === "credential.plain-secret" &&
        candidate.path.includes("token")
    );
    expect(arrayBuried).toBeDefined();
    expect(arrayBuried?.path).toBe(
      "nodes[scan-deep-n1].parameters.list.[].token"
    );
    expect(issues.filter((i) => i.code === "credential.plain-secret")).toHaveLength(
      2
    );
  });

  it("3. clean nested values of the same shapes pass validation with no secret issues", async () => {
    const doc = scanDocument(
      "scan-clean",
      {
        auth: { username: "alice", profile: { name: "Alice", tier: 2 } },
        list: [{ orderId: "o-1", quantities: [1, 2] }],
      },
      { config: { retries: 3, labels: ["a", "b"] } }
    );
    const result = await validator.validate(doc);

    expect(result.valid).toBe(true);
    expect(result.issues ?? []).toHaveLength(0);
    expect(result.resolved).toBeDefined();
  });

  it("4. the engine fail-fast gate rejects a nested-plain-secret document with the same structured issue", async () => {
    const doc = scanDocument("scan-engine", {
      auth: { apiKey: "sk-engine-secret" },
    });

    let thrown: unknown;
    try {
      await engine.execute(doc, {});
    } catch (e: unknown) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GraphDocumentValidationError);
    const issue = issueOf(
      (thrown as GraphDocumentValidationError).issues,
      "credential.plain-secret"
    );
    expect(issue?.path).toBe("nodes[scan-engine-n1].parameters.auth.apiKey");
  });

  it("5. a self-referencing object value terminates (depth cap acts as cycle guard) and reachable deny-list keys are still found", async () => {
    const cyclic: Record<string, unknown> = { apiKey: "sk-cyclic" };
    cyclic.self = cyclic;

    const node: GraphNodeInstance = {
      id: "cyclic-n1",
      kind: "test.scan",
      parameters: { payload: cyclic },
    } as GraphNodeInstance;
    const manifest = {
      kind: "test.scan",
      display: { name: "test.scan" },
      inputs: [],
      outputs: [],
      parameters: [],
    } as unknown as GraphResolvedNodeManifest;

    const credentialValidator = new GraphCredentialReferenceValidator();
    const issues: GraphValidationIssue[] = [];
    // without the depth cap this call would recurse forever; the Jest
    // timeout is the hang guard, completion is the pin
    await credentialValidator.validate(node, manifest, issues, "nodes[cyclic-n1]");

    const issue = issueOf(issues, "credential.plain-secret");
    expect(issue).toBeDefined();
    expect(issue?.path).toBe("nodes[cyclic-n1].parameters.payload.apiKey");

    // a cycle carrying NO deny-list key completes silently
    const cleanCycle: Record<string, unknown> = { note: "x" };
    cleanCycle.self = cleanCycle;
    const cleanIssues: GraphValidationIssue[] = [];
    await credentialValidator.validate(
      { ...node, parameters: { payload: cleanCycle } } as GraphNodeInstance,
      manifest,
      cleanIssues,
      "nodes[cyclic-n1]"
    );
    expect(cleanIssues).toHaveLength(0);
  });
});
