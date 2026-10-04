/**
 * @module as-graph/tests/unit/graph/GraphExecutionBackend.test
 * @summary Unit tests for the pluggable graph execution backend seam.
 * @description DECAF-50 §4.9: the engine is a facade that delegates to a
 * registered {@link GraphExecutionBackend}; the built-in
 * {@link LocalGraphExecutionBackend} is the default. These tests prove the
 * contract, the flavour registry, the facade delegation, the SAA-193 C1
 * code-mode gate, and the engine-agnostic workflow listing/lookup seam.
 */
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { GraphExecutionStatus } from "../../../src/shared/graph";
import type {
  GraphExecutionResult,
} from "../../../src/engine/types";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import type {
  GraphBackendCapabilities,
  GraphBackendExecutionRequest,
  GraphBackendWorkflowRecord,
  GraphBackendWorkflowStore,
  GraphBackendWorkflowSummary,
  GraphCodeMode,
  GraphExecutionBackend,
} from "../../../src/engine/execution/GraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { GraphExecutionError } from "../../../src/engine/errors";
import { LocalGraphExecutionBackend } from "../../../src/engine/execution/LocalGraphExecutionBackend";
import { detectGraphCodeModeSurfaces } from "../../../src/engine/execution/GraphCodeMode";
import type { CodeSandboxEvaluator } from "../../../src/engine/execution/CodeSandboxEvaluator";
import { GRAPH_LOCAL_EXECUTION_BACKEND } from "../../../src/engine/constants";
import {
  bootEngine,
  demoCatalogue,
  documentNode,
  linearDocument,
} from "./engine-fixtures";

/**
 * A non-local backend that records the requests delegated to it.
 */
class StubBackend implements GraphExecutionBackend<Record<string, unknown>> {
  readonly local = false;
  initialized = false;
  readonly calls: GraphBackendExecutionRequest[] = [];
  readonly capabilities?: GraphBackendCapabilities;
  listWorkflows?: () => Promise<GraphBackendWorkflowSummary[]>;
  getWorkflow?: (workflowId: string) => Promise<GraphWorkflowDocument>;

  constructor(readonly codeMode: GraphCodeMode = "unsupported") {}

  async initialize(): Promise<void> {
    this.initialized = true;
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

/** In-memory workflow catalogue port for the local listing/lookup tests. */
class StubWorkflowStore implements GraphBackendWorkflowStore {
  constructor(
    private readonly documents: Record<string, GraphWorkflowDocument> = {}
  ) {}

  async listWorkflows(): Promise<GraphBackendWorkflowRecord[]> {
    return Object.values(this.documents).map((document) => ({
      workflowId: document.id,
      name: document.name,
      updatedAt: new Date(0),
    }));
  }

  async getDocument(workflowId: string): Promise<GraphWorkflowDocument> {
    const document = this.documents[workflowId];
    if (!document) {
      throw new Error(`No workflow '${workflowId}'`);
    }
    return document;
  }
}

/** A catalogue that also registers the `core.utility.code` kind. */
async function codeModeCatalogue() {
  return await demoCatalogue({
    "math.add": {
      execute: (request) => ({
        sum: Number(request.inputs.a) + Number(request.inputs.b),
      }),
    },
    "math.multiply": {
      execute: (request) => ({ product: Number(request.inputs.x) * 2 }),
    },
    "core.utility.code": {
      execute: () => {
        throw new GraphExecutionError(
          "Code node requires a CodeSandboxEvaluator",
          "GRAPH_CODE_SANDBOX_NOT_CONFIGURED"
        );
      },
    },
  });
}

/** Builds a valid document carrying code-mode surfaces on connected nodes. */
function codeModeDocument(): GraphWorkflowDocument {
  const document = linearDocument();
  document.nodes[0].parameters = {
    condition: { type: "code", code: "return $input.a > 0" },
    template: { mode: "expression", expression: "$input.b" },
  };
  document.nodes[1].inputBindings = {
    x: { mode: "expression", expression: "$input.b" },
  };
  return document;
}

/** Builds a document carrying a `core.utility.code` node (detector only). */
function codeNodeDocument(): GraphWorkflowDocument {
  const document = linearDocument();
  document.nodes.push(documentNode("code", "core.utility.code"));
  return document;
}

/** A no-op sandbox evaluator (the gate only checks its presence). */
const stubEvaluator: CodeSandboxEvaluator = {
  evaluate: () => true,
};

describe("GraphExecutionBackend seam", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("registers the local backend under the default flavour", () => {
    const local = new LocalGraphExecutionBackend();
    expect(local.local).toBe(true);
    expect(local.codeMode).toBe("hostSide");
    expect(
      GraphExecutionBackendRegistry.get(GRAPH_LOCAL_EXECUTION_BACKEND)
    ).toBe(local);
  });

  it("resolves backends by flavour, current flavour, and fails loudly", () => {
    const stub = new StubBackend();
    GraphExecutionBackendRegistry.register("stub", stub);
    expect(GraphExecutionBackendRegistry.get("stub")).toBe(stub);
    expect(GraphExecutionBackendRegistry.getOrFail("stub")).toBe(stub);

    GraphExecutionBackendRegistry.setCurrent("stub");
    expect(GraphExecutionBackendRegistry.current).toBe(stub);
    expect(GraphExecutionBackendRegistry.currentFlavour).toBe("stub");

    expect(() =>
      GraphExecutionBackendRegistry.getOrFail("missing")
    ).toThrow(/missing/);

    GraphExecutionBackendRegistry.unregister("stub");
    expect(GraphExecutionBackendRegistry.get("stub")).toBeUndefined();
  });

  it("defaults to a local backend when none is configured", async () => {
    const registry = new GraphNodeExecutorRegistry(await demoCatalogue());
    const engine = await bootEngine({ registry });

    expect(engine.client.backend).toBeInstanceOf(
      LocalGraphExecutionBackend
    );
    expect(engine.client.backend.local).toBe(true);
  });

  it("delegates execute to the configured backend after validation", async () => {
    const backend = new StubBackend();
    const registry = new GraphNodeExecutorRegistry(await demoCatalogue());
    const engine = await bootEngine({ registry, backend });

    const result = await engine.execute(linearDocument(), { a: 1, b: 1 });

    expect(backend.initialized).toBe(true);
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].document.id).toBe("linear-wf");
    expect(backend.calls[0].plan.workflowId).toBe("linear-wf");
    expect(backend.calls[0].options.runId).toBeTruthy();
    expect(result.status).toBe("succeeded");
  });

  it("does not delegate when the document fails validation", async () => {
    const backend = new StubBackend();
    const registry = new GraphNodeExecutorRegistry(await demoCatalogue());
    const engine = await bootEngine({ registry, backend });

    await expect(engine.execute(linearDocument(), { a: 1, b: 1 })).resolves.toBeDefined();
    // A second run with a non-catalogue kind must fail validation and never
    // reach the backend.
    const document = linearDocument();
    document.nodes[0].kind = "unknown.kind";
    await expect(engine.execute(document, { a: 1, b: 1 })).rejects.toThrow();
    expect(backend.calls).toHaveLength(1);
  });

  describe("SAA-193 C1 code-mode gate", () => {
    it("detects every code-mode surface", () => {
      const surfaces = detectGraphCodeModeSurfaces(codeModeDocument());
      const kinds = surfaces.map((surface) => surface.kind).sort();
      expect(kinds).toEqual([
        "code-condition",
        "expression-binding",
        "value-template",
      ]);
      expect(detectGraphCodeModeSurfaces(linearDocument())).toEqual([]);
      const codeNodeKinds = detectGraphCodeModeSurfaces(
        codeNodeDocument()
      ).map((surface) => surface.kind);
      expect(codeNodeKinds).toEqual(["code-node"]);
    });

    it("rejects an unsupported non-local backend before launch", async () => {
      const backend = new StubBackend("unsupported");
      const registry = new GraphNodeExecutorRegistry(
        await codeModeCatalogue()
      );
      const engine = await bootEngine({ registry, backend });

      await expect(
        engine.execute(codeModeDocument(), { a: 1, b: 1 })
      ).rejects.toMatchObject({
        graphCode: "GRAPH_CODE_MODE_UNSUPPORTED_BACKEND",
      });
      expect(backend.calls).toHaveLength(0);
    });

    it("rejects a host-side non-local backend with no evaluator", async () => {
      const backend = new StubBackend("hostSide");
      const registry = new GraphNodeExecutorRegistry(
        await codeModeCatalogue()
      );
      const engine = await bootEngine({ registry, backend });

      await expect(
        engine.execute(codeModeDocument(), { a: 1, b: 1 })
      ).rejects.toMatchObject({
        graphCode: "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
      });
      expect(backend.calls).toHaveLength(0);
    });

    it("delegates a host-side non-local backend when an evaluator is configured", async () => {
      const backend = new StubBackend("hostSide");
      const registry = new GraphNodeExecutorRegistry(
        await codeModeCatalogue()
      );
      const engine = await bootEngine({
        registry,
        backend,
        codeSandboxEvaluator: stubEvaluator,
      });

      await engine.execute(codeModeDocument(), { a: 1, b: 1 });
      expect(backend.calls).toHaveLength(1);
    });

    it("does not gate code-mode surfaces for a local backend", async () => {
      const registry = new GraphNodeExecutorRegistry(
        await codeModeCatalogue()
      );
      const engine = await bootEngine({ registry });

      const result = await engine.execute(codeModeDocument(), {
        a: 1,
        b: 1,
      });
      expect(result.status).toBe("failed");
      expect(result.nodeResults.adder.error?.code).toBe(
        "GRAPH_CODE_SANDBOX_NOT_CONFIGURED"
      );
    });
  });

  describe("workflow listing/lookup seam", () => {
    it("reports local capabilities and lists/looks up through the store", async () => {
      const store = new StubWorkflowStore({
        "linear-wf": linearDocument(),
      });
      const registry = new GraphNodeExecutorRegistry(await demoCatalogue());
      const engine = await bootEngine({ registry, workflowStore: store });

      expect(engine.backendCapabilities.workflows).toEqual({
        list: "supported",
        get: "supported",
      });
      expect(engine.backendCapabilities.codeMode).toBe("hostSide");

      const summaries = await engine.listWorkflows();
      expect(summaries).toEqual([
        { id: "linear-wf", name: "linear-wf", updatedAt: new Date(0) },
      ]);
      const document = await engine.getWorkflow("linear-wf");
      expect(document.id).toBe("linear-wf");
    });

    it("reports not_supported and throws when the backend has no catalogue", async () => {
      const backend = new StubBackend();
      const registry = new GraphNodeExecutorRegistry(await demoCatalogue());
      const engine = await bootEngine({ registry, backend });

      expect(engine.backendCapabilities.workflows).toEqual({
        list: "not_supported",
        get: "not_supported",
      });
      await expect(engine.listWorkflows()).rejects.toMatchObject({
        graphCode: "GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED",
      });
      await expect(engine.getWorkflow("linear-wf")).rejects.toMatchObject({
        graphCode: "GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED",
      });
    });
  });
});
