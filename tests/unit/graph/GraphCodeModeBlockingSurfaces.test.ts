/**
 * @module as-graph/tests/unit/graph/GraphCodeModeBlockingSurfaces
 * @summary SAA-1360 D7 regression: the engine's code-mode gate uses the
 * blocking projection, which excludes `value-template` surfaces.
 * @description Proves `detectGraphCodeModeSurfaces` still reports a
 * value-template (the full detection authority), while
 * `detectGraphCodeModeBlockingSurfaces` drops it. The facade therefore lets a
 * value-template-only document run on a non-local `codeMode: "unsupported"`
 * backend, and still rejects a document carrying an executable surface
 * (code node / code condition / expression binding) with
 * `GRAPH_CODE_MODE_UNSUPPORTED_BACKEND` before delegation.
 */
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { GraphExecutionStatus } from "../../../src/shared/graph";
import type { GraphExecutionResult } from "../../../src/engine/types";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import type {
  GraphBackendExecutionRequest,
  GraphCodeMode,
  GraphExecutionBackend,
} from "../../../src/engine/execution/GraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import {
  detectGraphCodeModeBlockingSurfaces,
  detectGraphCodeModeSurfaces,
} from "../../../src/engine/execution/GraphCodeMode";
import { bootEngine, demoCatalogue, linearDocument } from "./engine-fixtures";

/** A non-local backend that records every request delegated to it. */
class RecordingBackend implements GraphExecutionBackend<Record<string, unknown>> {
  readonly local = false;
  readonly calls: GraphBackendExecutionRequest[] = [];

  constructor(readonly codeMode: GraphCodeMode = "unsupported") {}

  async initialize(): Promise<void> {
    // No wired collaborators are needed for the gate probe.
  }

  async execute(
    request: GraphBackendExecutionRequest
  ): Promise<GraphExecutionResult> {
    this.calls.push(request);
    return {
      runId: request.options.runId!,
      workflowId: request.document.id || request.document.name,
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

/** A valid linear document carrying only a value-template parameter. */
function valueTemplateDocument(): GraphWorkflowDocument {
  const source = linearDocument();
  source.nodes[0].parameters = {
    template: { mode: "template", expression: "Hello {{ $input.a }}" },
  };
  return source;
}

/** A valid linear document mixing a value-template with an executable surface. */
function mixedCodeModeDocument(): GraphWorkflowDocument {
  const source = valueTemplateDocument();
  source.nodes[0].parameters = {
    ...source.nodes[0].parameters,
    condition: { type: "code", code: "return $input.a > 0" },
  };
  return source;
}

async function bootOver(backend: RecordingBackend) {
  const catalogue = await demoCatalogue({
    "math.add": {
      execute: (request) => ({
        sum: Number(request.inputs.a) + Number(request.inputs.b),
      }),
    },
    "math.multiply": {
      execute: (request) => ({ product: Number(request.inputs.x) * 2 }),
    },
    "core.utility.code": { execute: () => ({}) },
  });
  const registry = new GraphNodeExecutorRegistry(catalogue);
  return bootEngine({ registry, backend });
}

describe("GraphCodeMode blocking projection (SAA-1360 D7)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("keeps reporting value-template in the full detection", () => {
    const surfaces = detectGraphCodeModeSurfaces(valueTemplateDocument());

    expect(surfaces.map((surface) => surface.kind)).toEqual([
      "value-template",
    ]);
  });

  it("drops value-template from the blocking projection", () => {
    expect(
      detectGraphCodeModeBlockingSurfaces(valueTemplateDocument())
    ).toEqual([]);
  });

  it("keeps executable surfaces in the blocking projection", () => {
    const kinds = detectGraphCodeModeBlockingSurfaces(
      mixedCodeModeDocument()
    ).map((surface) => surface.kind);

    expect(kinds).toContain("code-condition");
    expect(kinds).not.toContain("value-template");
  });

  it("lets a value-template-only document run on an unsupported non-local backend", async () => {
    const backend = new RecordingBackend("unsupported");
    const engine = await bootOver(backend);

    const result = await engine.execute(valueTemplateDocument(), {
      a: 1,
      b: 1,
    });

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(backend.calls).toHaveLength(1);
  });

  it("still rejects a mixed executable document on an unsupported non-local backend", async () => {
    const backend = new RecordingBackend("unsupported");
    const engine = await bootOver(backend);

    await expect(
      engine.execute(mixedCodeModeDocument(), { a: 1, b: 1 })
    ).rejects.toMatchObject({
      graphCode: "GRAPH_CODE_MODE_UNSUPPORTED_BACKEND",
    });
    expect(backend.calls).toHaveLength(0);
  });

  it("still rejects a code node on an unsupported non-local backend", async () => {
    const backend = new RecordingBackend("unsupported");
    const engine = await bootOver(backend);
    const source = linearDocument();
    source.nodes[1].kind = "core.utility.code";
    source.nodes[1].parameters = {};

    await expect(
      engine.execute(source, { a: 1, b: 1 })
    ).rejects.toMatchObject({
      graphCode: "GRAPH_CODE_MODE_UNSUPPORTED_BACKEND",
    });
    expect(backend.calls).toHaveLength(0);
  });

  it("still rejects an expression binding on an unsupported non-local backend", async () => {
    const backend = new RecordingBackend("unsupported");
    const engine = await bootOver(backend);
    const source = linearDocument();
    source.nodes[1].inputBindings = {
      x: { mode: "expression", expression: "$input.b" },
    };

    await expect(
      engine.execute(source, { a: 1, b: 1 })
    ).rejects.toMatchObject({
      graphCode: "GRAPH_CODE_MODE_UNSUPPORTED_BACKEND",
    });
    expect(backend.calls).toHaveLength(0);
  });
});
