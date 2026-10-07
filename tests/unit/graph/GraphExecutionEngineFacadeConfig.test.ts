/**
 * @module as-graph/tests/unit/graph/GraphExecutionEngineFacadeConfig.test
 * @summary Unit tests for the fail-closed facade-owned backend-config merge (SAA-318 C2).
 * @description Proves a backend's retained `config` cannot inject a collaborator the
 * facade owns (`engine`, `valueAdapter`, `codeSandboxEvaluator`, `workflowStore`)
 * when the engine config omitted it: `stripFacadeOwnedBackendConfig` removes unowned
 * facade-owned keys while non-facade host keys survive, and a facade-set key still
 * wins over the backend's retained value. Preserves the SAA-315 host-config-survival
 * behaviour (`stepHandlers`/`suspendStateReader`).
 */
import { GraphExecutionEngine } from "../../../src/engine/execution/GraphExecutionEngine";
import {
  stripFacadeOwnedBackendConfig,
} from "../../../src/engine/execution/GraphExecutionEngine";
import type { GraphExecutionBackend } from "../../../src/engine/execution/GraphExecutionBackend";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { bootEngine, demoCatalogue } from "./engine-fixtures";

/** A host-injected evaluator stub used only as an identity marker. */
const HOSTILE_EVALUATOR = { evaluate: async () => "hostile" } as never;
/** A facade-owned evaluator stub used only as an identity marker. */
const FACADE_EVALUATOR = { evaluate: async () => "facade" } as never;
/** A host-injected workflow store stub used only as an identity marker. */
const HOSTILE_STORE = { hostile: true } as never;
/** A facade-owned workflow store stub used only as an identity marker. */
const FACADE_STORE = { facade: true } as never;

/**
 * A backend that retains a host-supplied config and records exactly what the
 * facade passed to its most recent `initialize`.
 */
class CapturingBackend
  implements GraphExecutionBackend<Record<string, unknown>>
{
  readonly local = true;
  readonly codeMode = "hostSide" as const;
  received?: Record<string, unknown>;

  constructor(private readonly retained?: Record<string, unknown>) {}

  get config(): Record<string, unknown> | undefined {
    return this.retained;
  }

  async initialize(config: Record<string, unknown>): Promise<void> {
    this.received = config;
  }

  async execute(): Promise<never> {
    throw new Error("CapturingBackend.execute is unused in this test");
  }
}

/** Boots the facade over a capturing backend backed by a demo catalogue. */
async function bootOver(
  backend: CapturingBackend,
  extra: { codeSandboxEvaluator?: unknown; workflowStore?: unknown } = {}
): Promise<GraphExecutionEngine> {
  const catalogue = await demoCatalogue();
  return await bootEngine({
    registry: new GraphNodeExecutorRegistry(catalogue),
    catalogue,
    backend,
    ...(extra as never),
  });
}

describe("stripFacadeOwnedBackendConfig (SAA-318 C2)", () => {
  it("returns an empty object for undefined host config", () => {
    expect(stripFacadeOwnedBackendConfig(undefined, new Set())).toEqual({});
  });

  it("strips every facade-owned key the facade did not itself set", () => {
    const host = {
      engine: { hostile: true },
      valueAdapter: { hostile: true },
      codeSandboxEvaluator: HOSTILE_EVALUATOR,
      workflowStore: HOSTILE_STORE,
      stepHandlers: [1],
      suspendStateReader: { reader: true },
    };

    const stripped = stripFacadeOwnedBackendConfig(host, new Set());

    expect(stripped).not.toHaveProperty("engine");
    expect(stripped).not.toHaveProperty("valueAdapter");
    expect(stripped).not.toHaveProperty("codeSandboxEvaluator");
    expect(stripped).not.toHaveProperty("workflowStore");
    // Non-facade host keys survive untouched.
    expect(stripped.stepHandlers).toEqual([1]);
    expect(stripped.suspendStateReader).toEqual({ reader: true });
  });

  it("keeps a facade-owned key the facade itself set", () => {
    const host = {
      codeSandboxEvaluator: HOSTILE_EVALUATOR,
      workflowStore: HOSTILE_STORE,
    };

    const stripped = stripFacadeOwnedBackendConfig(
      host,
      new Set(["codeSandboxEvaluator", "workflowStore"])
    );

    expect(stripped.codeSandboxEvaluator).toBe(HOSTILE_EVALUATOR);
    expect(stripped.workflowStore).toBe(HOSTILE_STORE);
  });

  it("returns a copy and never mutates the host config", () => {
    const host = { codeSandboxEvaluator: HOSTILE_EVALUATOR, stepHandlers: [1] };

    const stripped = stripFacadeOwnedBackendConfig(host, new Set());

    expect(stripped).not.toBe(host);
    expect(host).toHaveProperty("codeSandboxEvaluator");
  });
});

describe("GraphExecutionEngine.initialize facade config guard (SAA-318 C2)", () => {
  it("strips a backend-injected codeSandboxEvaluator/workflowStore the facade did not set", async () => {
    const backend = new CapturingBackend({
      codeSandboxEvaluator: HOSTILE_EVALUATOR,
      workflowStore: HOSTILE_STORE,
      stepHandlers: [1],
      suspendStateReader: { reader: true },
    });

    const engine = await bootOver(backend);

    expect(backend.received?.codeSandboxEvaluator).toBeUndefined();
    expect(backend.received?.workflowStore).toBeUndefined();
    // SAA-315 survival: non-facade host keys are preserved.
    expect(backend.received?.stepHandlers).toEqual([1]);
    expect(backend.received?.suspendStateReader).toEqual({ reader: true });
    // The facade always owns and re-sets `engine`/`valueAdapter`.
    expect(backend.received?.engine).toBe(engine);
    expect(backend.received?.valueAdapter).toBeDefined();
  });

  it("lets a facade-set codeSandboxEvaluator/workflowStore win over the backend's retained value", async () => {
    const backend = new CapturingBackend({
      codeSandboxEvaluator: HOSTILE_EVALUATOR,
      workflowStore: HOSTILE_STORE,
    });

    await bootOver(backend, {
      codeSandboxEvaluator: FACADE_EVALUATOR,
      workflowStore: FACADE_STORE,
    });

    expect(backend.received?.codeSandboxEvaluator).toBe(FACADE_EVALUATOR);
    expect(backend.received?.workflowStore).toBe(FACADE_STORE);
  });

  it("strips only the unset facade-owned key when the facade sets the other", async () => {
    const backend = new CapturingBackend({
      codeSandboxEvaluator: HOSTILE_EVALUATOR,
      workflowStore: HOSTILE_STORE,
    });

    await bootOver(backend, { codeSandboxEvaluator: FACADE_EVALUATOR });

    expect(backend.received?.codeSandboxEvaluator).toBe(FACADE_EVALUATOR);
    expect(backend.received?.workflowStore).toBeUndefined();
  });
});
