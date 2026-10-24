/**
 * @module as-graph/tests/unit/graph/GraphCodeModeDagsterDeployment
 * @summary SAA-1386 D5 regression: the code-mode gate is unchanged for a
 * Dagster-like deployment backend.
 * @description A Dagster-like backend (`local: false`,
 * `codeMode: "unsupported"`, `documentValidation: "deployment"`) must still
 * reject every executable code-mode surface before delegation with
 * `GRAPH_CODE_MODE_UNSUPPORTED_BACKEND` — a code node, a code condition, an
 * expression binding, and a surface nested inside a loop body. A document whose
 * only surface is a declarative `value-template` passes the gate (SAA-1360 D7).
 *
 * The deployment document validation is lenient about unknown kinds by design;
 * this suite proves that leniency does not widen the separate code-mode gate.
 */
import { describe, it, expect, afterEach } from "@jest/globals";

import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { GraphExecutionStatus } from "../../../src/shared/graph";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import type {
  GraphBackendExecutionRequest,
  GraphCodeMode,
  GraphDocumentValidationMode,
  GraphExecutionBackend,
} from "../../../src/engine/execution/GraphExecutionBackend";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import {
  detectGraphCodeModeBlockingSurfaces,
  detectGraphCodeModeSurfaces,
} from "../../../src/engine/execution/GraphCodeMode";
import type { GraphExecutionResult } from "../../../src/engine/types";
import { bootEngine, demoCatalogue, documentNode } from "./engine-fixtures";

const UNKNOWN_KIND = "deployment.projection.unknown";

/** A non-local deployment backend that records every delegated run. */
class RecordingDeploymentBackend implements GraphExecutionBackend<
  Record<string, unknown>
> {
  readonly local = false;
  readonly codeMode: GraphCodeMode = "unsupported";
  readonly documentValidation: GraphDocumentValidationMode = "deployment";
  readonly calls: GraphBackendExecutionRequest[] = [];

  async initialize(): Promise<void> {
    // No collaborators are needed for the code-mode gate probe.
  }

  async execute(
    request: GraphBackendExecutionRequest
  ): Promise<GraphExecutionResult> {
    this.calls.push(request);
    return {
      runId: request.options.runId!,
      workflowId: request.document.id,
      status: GraphExecutionStatus.SUCCEEDED,
      document: request.document,
      inputs: request.inputs,
      outputs: {},
      nodeResults: {},
      events: [],
      startedAt: new Date(),
      finishedAt: new Date(),
    };
  }
}

/** Builds a deployment document whose single node carries the given extras. */
function documentWith(
  id: string,
  node: GraphWorkflowDocument["nodes"][number]
): GraphWorkflowDocument {
  return {
    id,
    name: id,
    inputs: [],
    outputs: [],
    nodes: [node],
    edges: [],
  };
}

/** A value-template-only deployment document. */
function valueTemplateDocument(): GraphWorkflowDocument {
  return documentWith(
    "deployment-value-template",
    documentNode("op_a", UNKNOWN_KIND, {
      template: { mode: "template", expression: "Hello {{ $input.a }}" },
    })
  );
}

/** A deployment document carrying a code node. */
function codeNodeDocument(): GraphWorkflowDocument {
  return documentWith(
    "deployment-code-node",
    documentNode("op_a", "core.utility.code")
  );
}

/** A deployment document carrying a code condition parameter. */
function codeConditionDocument(): GraphWorkflowDocument {
  return documentWith(
    "deployment-code-condition",
    documentNode("op_a", UNKNOWN_KIND, {
      condition: { type: "code", code: "return true" },
    })
  );
}

/** A deployment document carrying an expression input binding. */
function expressionBindingDocument(): GraphWorkflowDocument {
  return documentWith(
    "deployment-expression-binding",
    documentNode(
      "op_a",
      UNKNOWN_KIND,
      {},
      {
        inputBindings: {
          x: { mode: "expression", expression: "$input.a" },
        },
      }
    )
  );
}

/** A deployment document whose loop body carries a code condition. */
function nestedCodeConditionDocument(): GraphWorkflowDocument {
  const body: GraphWorkflowDocument = {
    id: "deployment-nested-body",
    name: "deployment-nested-body",
    inputs: [],
    outputs: [],
    nodes: [
      documentNode("inner", UNKNOWN_KIND, {
        condition: { type: "code", code: "return true" },
      }),
    ],
    edges: [],
  };
  return documentWith(
    "deployment-nested-code-condition",
    documentNode("loop", UNKNOWN_KIND, {}, { loop: { body } } as never)
  );
}

/** Boots a deployment-mode engine over the recording backend. */
async function bootDeploymentEngine(backend: RecordingDeploymentBackend) {
  const registry = new GraphNodeExecutorRegistry(await demoCatalogue());
  return bootEngine({ registry, backend });
}

describe("Dagster-like deployment code-mode gate (SAA-1386 D5)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it.each([
    ["code node", codeNodeDocument, "code-node"],
    ["code condition", codeConditionDocument, "code-condition"],
    ["expression binding", expressionBindingDocument, "expression-binding"],
  ] as Array<[string, () => GraphWorkflowDocument, string]>)(
    "rejects a %s before delegation",
    async (_label, build, expectedKind) => {
      const backend = new RecordingDeploymentBackend();
      const engine = await bootDeploymentEngine(backend);
      const document = build();

      expect(
        detectGraphCodeModeBlockingSurfaces(document).map(
          (surface) => surface.kind
        )
      ).toContain(expectedKind);

      await expect(engine.execute(document, {})).rejects.toMatchObject({
        graphCode: "GRAPH_CODE_MODE_UNSUPPORTED_BACKEND",
      });
      expect(backend.calls).toHaveLength(0);
    }
  );

  it("rejects a code condition nested inside a loop body before delegation", async () => {
    const backend = new RecordingDeploymentBackend();
    const engine = await bootDeploymentEngine(backend);
    const document = nestedCodeConditionDocument();

    const surfaces = detectGraphCodeModeSurfaces(document);
    expect(surfaces.map((surface) => surface.kind)).toContain("code-condition");
    expect(
      surfaces.find((surface) => surface.kind === "code-condition")?.nodeId
    ).toBe("inner");

    await expect(engine.execute(document, {})).rejects.toMatchObject({
      graphCode: "GRAPH_CODE_MODE_UNSUPPORTED_BACKEND",
    });
    expect(backend.calls).toHaveLength(0);
  });

  it("allows a value-template-only deployment document through the gate", async () => {
    const backend = new RecordingDeploymentBackend();
    const engine = await bootDeploymentEngine(backend);
    const document = valueTemplateDocument();

    expect(
      detectGraphCodeModeSurfaces(document).map((surface) => surface.kind)
    ).toEqual(["value-template"]);
    expect(detectGraphCodeModeBlockingSurfaces(document)).toEqual([]);

    const result = await engine.execute(document, {});
    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(backend.calls).toHaveLength(1);
  });
});
