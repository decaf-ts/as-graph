/**
 * @module as-graph/tests/unit/nest/GraphExecutionLeafPreservation.test
 * @summary Regression tests for SAA-567: `GraphExecutionModule.forRoot` must
 * preserve the sibling `graph.execution` leaf through its environment accumulate.
 * @description A workflows-only accumulate (`GraphEnvironment.accumulate({ graph:
 * { workflows } })`) replaces the whole `graph` property, so the sibling
 * `graph.execution.maxCodeTimeoutMs` leaf is dropped and reads back as a truthy
 * path-composition proxy. Feeding that proxy into the sandbox-timeout clamp
 * produced `Math.min(1000, NaN) === NaN` and surfaced as
 * `GRAPH_CODE_SANDBOX_TIMEOUT`. The fix accumulates `graph.workflows` AND
 * `graph.execution` in the same call; these tests pin both the fixed behaviour
 * and the defect it repairs.
 *
 * `GraphEnvironment` is a process-global singleton, so every test restores the
 * full default leaf set (matching the module's own seed) afterwards.
 */
import { describe, afterEach, it, expect } from "@jest/globals";

import { GraphExecutionModule } from "../../../src/nest/graph";
import { GraphEnvironment } from "../../../src/engine/services/GraphEnvironment";
import { GRAPH_CODE_MAX_TIMEOUT_MS } from "../../../src/engine/constants";
import { DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS } from "../../../src/engine/validation/GraphWorkflowDocumentLimits";

/** Re-accumulates the full default leaf set the module seeds at boot. */
function accumulateDefaultLeaf(): void {
  GraphEnvironment.accumulate({
    graph: {
      workflows: {
        limits: { ...DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS },
        allowAnonymousAccess: false,
      },
      execution: { maxCodeTimeoutMs: GRAPH_CODE_MAX_TIMEOUT_MS },
    },
  } as never);
}

describe("GraphExecutionModule graph.execution leaf preservation (SAA-567)", () => {
  afterEach(() => {
    accumulateDefaultLeaf();
  });

  it("forRoot({ workflows }) accumulates the sibling execution leaf as a number", () => {
    GraphExecutionModule.forRoot({
      workflows: { allowAnonymousAccess: true },
    });

    const ceiling = GraphEnvironment.graph.execution?.maxCodeTimeoutMs;
    expect(typeof ceiling).toBe("number");
    expect(ceiling).toBe(GRAPH_CODE_MAX_TIMEOUT_MS);
  });

  it("a raw forRoot-shaped accumulate preserves graph.workflows and graph.execution together", () => {
    GraphEnvironment.accumulate({
      graph: {
        workflows: {
          limits: { ...DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS },
          allowAnonymousAccess: true,
        },
        execution: { maxCodeTimeoutMs: GRAPH_CODE_MAX_TIMEOUT_MS },
      },
    } as never);

    expect(GraphEnvironment.graph.workflows.allowAnonymousAccess).toBe(true);
    const ceiling = GraphEnvironment.graph.execution?.maxCodeTimeoutMs;
    expect(typeof ceiling).toBe("number");
    expect(ceiling).toBe(GRAPH_CODE_MAX_TIMEOUT_MS);
  });

  it("a workflows-only accumulate clobbers the sibling execution leaf (the SAA-567 defect)", () => {
    // The pre-fix forRoot shape: only the workflows leaf is accumulated.
    GraphEnvironment.accumulate({
      graph: {
        workflows: {
          limits: { ...DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS },
          allowAnonymousAccess: true,
        },
      },
    } as never);

    const clobbered = GraphEnvironment.graph.execution?.maxCodeTimeoutMs as
      | unknown;
    // The dropped leaf resolves to a truthy composition proxy, not a number.
    expect(typeof clobbered).not.toBe("number");
    expect(Number.isFinite(clobbered)).toBe(false);
    // The pre-fix clamp therefore computed Math.min(1000, NaN) === NaN, which
    // surfaced as GRAPH_CODE_SANDBOX_TIMEOUT.
    expect(Number.isNaN(Math.min(1000, clobbered as number))).toBe(true);
  });

  it("re-accumulating the full leaf set after the defect restores the numeric ceiling", () => {
    // Clobber first (defect state)...
    GraphEnvironment.accumulate({
      graph: {
        workflows: {
          limits: { ...DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS },
          allowAnonymousAccess: true,
        },
      },
    } as never);

    // ...then the fixed forRoot re-accumulates the full leaf set.
    GraphExecutionModule.forRoot({
      workflows: { allowAnonymousAccess: true },
    });

    const ceiling = GraphEnvironment.graph.execution?.maxCodeTimeoutMs;
    expect(typeof ceiling).toBe("number");
    expect(ceiling).toBe(GRAPH_CODE_MAX_TIMEOUT_MS);
  });
});
