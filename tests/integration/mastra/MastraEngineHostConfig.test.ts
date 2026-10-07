/**
 * @module as-graph/tests/integration/mastra/MastraEngineHostConfig.test
 * @summary SAA-315 regression: a host-configured Mastra backend's config
 * survives `GraphExecutionEngine.initialize` (SAA-312 engine-seam fix).
 * @description The defect: a host wires its Mastra backend directly
 * (`backend.initialize({ mastra, stepHandlers, suspendStateReader })`) before
 * booting the engine, then `GraphExecutionEngine.initialize` re-initializes the
 * backend with only the facade-owned keys, silently dropping the host wiring.
 * The fix merges the backend's retained `config` under the facade-owned keys.
 *
 * **Real**: the production `GraphExecutionEngine` facade, the production
 * `MastraGraphExecutionBackend`, and real `@mastra/core` steps built by the
 * host step handler. Only the suspend-state reader is a host-injected stub
 * (that is the seam under test: whether the host's reader survives boot).
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { GraphExecutionStatus } from "../../../src/shared/graph/constants";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import {
  GRAPH_MASTRA_RESUME_STATE_INVALID,
  GRAPH_MASTRA_UNSUPPORTED_KIND,
  type MastraBackendConfig,
  type MastraSuspendStateReader,
} from "../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { GraphNodeExecutorRegistry } from "../../../src/engine/registry/GraphNodeExecutorRegistry";
import { bootEngine, demoCatalogue } from "../../unit/graph/engine-fixtures";
import {
  integrationTwoLeafDocument,
  realStepHandler,
  type StepCall,
} from "./helpers";

const NODE_KIND = "test.leaf";

/** A host suspend-state reader that reports no snapshot for any run. */
function emptySuspendStateReader(): MastraSuspendStateReader {
  return {
    readRunState: async () => undefined,
  };
}

/** Boots the engine over the supplied backend and catalogue. */
async function bootOverBackend(
  backend: MastraGraphExecutionBackend
): Promise<Awaited<ReturnType<typeof bootEngine>>> {
  const catalogue = await demoCatalogue({ [NODE_KIND]: { execute: () => ({}) } });
  return await bootEngine({
    registry: new GraphNodeExecutorRegistry(catalogue),
    catalogue,
    backend,
  });
}

describe("Mastra host backend config survives GraphExecutionEngine.initialize (SAA-315)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("executes a host-configured backend after boot without dropping stepHandlers", async () => {
    const source = integrationTwoLeafDocument();
    const calls: StepCall[] = [];
    const reader = emptySuspendStateReader();
    const backend = new MastraGraphExecutionBackend();

    // The host wires the backend's Mastra collaborators BEFORE booting the
    // engine; `GraphExecutionEngine.initialize` must preserve them.
    await backend.initialize({
      mastra: {},
      stepHandlers: [realStepHandler(NODE_KIND, undefined, calls)],
      suspendStateReader: reader,
    });

    const engine = await bootOverBackend(backend);

    expect(engine.backend).toBe(backend);
    // The facade re-initialized the backend at boot; the host keys must survive
    // the merge instead of being replaced by the facade-owned keys alone.
    expect(backend.config?.stepHandlers).toHaveLength(1);
    expect(backend.config?.suspendStateReader).toBe(reader);

    const result = await engine.execute(
      source,
      { in: 1 },
      { runId: "mastra-it-host-config" }
    );

    // Execution through the host-translated steps proves the step handlers were
    // retained: a dropped handler set fails closed with UNSUPPORTED_KIND.
    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);
    expect(calls.map((call) => call.stepId)).toEqual(["first", "second"]);
  });

  it("keeps the host suspendStateReader wired through boot", async () => {
    const reader = emptySuspendStateReader();
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: {},
      stepHandlers: [realStepHandler(NODE_KIND)],
      suspendStateReader: reader,
    });

    await bootOverBackend(backend);

    // A retained reader that reports no snapshot fails with STATE_INVALID; a
    // dropped reader fails earlier with UNSUPPORTED_KIND. The code distinguishes
    // survival from the pre-fix behavior.
    await expect(
      backend.resume("mastra-it-host-config-run", { step: "first" })
    ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_RESUME_STATE_INVALID });
  });

  it("negative control: host config is dropped when the engine ignores backend.config", async () => {
    // Simulates the pre-fix engine, which re-initialized the backend with only
    // the facade-owned keys and never read `backend.config`. The call the facade
    // makes is then exactly the pre-fix `{ valueAdapter, engine }`, so the host
    // step handlers are dropped and translation fails closed.
    class PreFixEngineBackend extends MastraGraphExecutionBackend {
      override get config(): MastraBackendConfig | undefined {
        return undefined;
      }
    }

    const calls: StepCall[] = [];
    const backend = new PreFixEngineBackend();
    await backend.initialize({
      mastra: {},
      stepHandlers: [realStepHandler(NODE_KIND, undefined, calls)],
    });

    const engine = await bootOverBackend(backend);

    await expect(
      engine.execute(
        integrationTwoLeafDocument(),
        { in: 1 },
        { runId: "mastra-it-prefix" }
      )
    ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_UNSUPPORTED_KIND });
    expect(calls).toEqual([]);
  });
});
