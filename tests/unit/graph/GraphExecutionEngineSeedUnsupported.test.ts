/**
 * @module as-graph/tests/unit/graph/GraphExecutionEngineSeedUnsupported.test
 * @summary Fail-closed coverage for `GraphExecutionEngine.initialize` workflow
 * seeding (SAA-802, from SAA-799).
 * @description DECAF-50 §4.9: `GraphExecutionEngineConfig.seedWorkflows` asks
 * the facade to seed canonical documents into the active backend's own
 * catalogue at boot. The backend's `seedWorkflows` seam is optional
 * (`GraphExecutionBackend`); when seeds are supplied but the active backend
 * exposes no seeding surface, the engine must fail closed with
 * `GRAPH_BACKEND_SEED_NOT_SUPPORTED` instead of silently dropping the seeds.
 * Only the happy path (a backend that persists the seeds) is covered today.
 */
import type { Context, MaybeContextualArg } from "@decaf-ts/core";
import type {
  GraphBackendExecutionRequest,
  GraphExecutionBackend,
} from "../../../src/engine/execution/GraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import type { GraphExecutionResult } from "../../../src/engine/types";

import { bootEngine, demoCatalogue, linearDocument } from "./engine-fixtures";

/**
 * A local backend that deliberately omits the optional `seedWorkflows` seam —
 * the shape a read-only/translate-only backend presents. It records that the
 * facade did reach `initialize` so a test can prove the seed gate is what
 * aborts the boot, not an earlier failure.
 */
class NoSeedBackend implements GraphExecutionBackend<Record<string, unknown>> {
  readonly local = true;
  readonly codeMode = "hostSide" as const;
  initialized = false;

  async initialize(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _config: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ..._args: MaybeContextualArg<Context>
  ): Promise<void> {
    this.initialized = true;
  }

  async execute(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _request: GraphBackendExecutionRequest,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ..._args: MaybeContextualArg<Context>
  ): Promise<GraphExecutionResult> {
    throw new Error(
      "NoSe// @ts-edBackend.execute must not be reached in this test"
    );
  }
}

describe("GraphExecutionEngine — seed fail-closed (SAA-802)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("throws GRAPH_BACKEND_SEED_NOT_SUPPORTED when seeds are supplied but the backend cannot seed", async () => {
    const backend = new NoSeedBackend();
    const registry = new GraphNodeExecutorRegistry(await demoCatalogue());

    const boot = bootEngine({
      registry,
      backend,
      seedWorkflows: [linearDocument()],
    });

    await expect(boot).rejects.toMatchObject({
      graphCode: "GRAPH_BACKEND_SEED_NOT_SUPPORTED",
    });
  });

  it("names the offending backend constructor in the failure message", async () => {
    const backend = new NoSeedBackend();
    const registry = new GraphNodeExecutorRegistry(await demoCatalogue());

    await expect(
      bootEngine({
        registry,
        backend,
        seedWorkflows: [linearDocument()],
      })
    ).rejects.toThrow(/NoSeedBackend/);
  });

  it("reaches backend initialize but aborts before the engine-created side effect", async () => {
    const backend = new NoSeedBackend();
    const onEngineCreated = jest.fn();
    const registry = new GraphNodeExecutorRegistry(await demoCatalogue());

    await expect(
      bootEngine({
        registry,
        backend,
        seedWorkflows: [linearDocument()],
        onEngineCreated,
      })
    ).rejects.toMatchObject({
      graphCode: "GRAPH_BACKEND_SEED_NOT_SUPPORTED",
    });

    expect(backend.initialized).toBe(true);
    expect(onEngineCreated).not.toHaveBeenCalled();
  });

  it("does not attempt seeding when the seed list is empty (or absent)", async () => {
    const backend = new NoSeedBackend();
    const onEngineCreated = jest.fn();
    const registry = new GraphNodeExecutorRegistry(await demoCatalogue());

    const engine = await bootEngine({
      registry,
      backend,
      seedWorkflows: [],
      onEngineCreated,
    });

    expect(engine).toBeDefined();
    expect(backend.initialized).toBe(true);
    expect(onEngineCreated).toHaveBeenCalledTimes(1);
  });
});
