/**
 * @module as-graph/tests/integration/mastra/MastraDefaultStepHandlersHost
 * @summary SAA-820 acceptance: a Mastra host booted through
 * `createGraphBackendHost` with `createMastraDefaultStepHandlers()` executes the
 * runnable non-code fixtures to `succeeded`, while a `core.agent` fixture with no
 * agent runtime fails closed and an unhandled host still fails closed.
 * @description Boots the production host wiring for the `mastra` variant with the
 * default step-handler set and drives the fixtures through the real
 * `MastraGraphExecutionBackend`. `fixture-chat-agent` carries a `core.agent` node;
 * with no agent runtime configured the default handler fails that node closed, so
 * it is asserted as `FAILED` + `WORKFLOW_FAILED` (SAA-858/SAA-859), not a false
 * success. The negative control boots the same host with no `stepHandlers` and
 * asserts a leaf document is still rejected with `GRAPH_MASTRA_UNSUPPORTED_KIND` —
 * the SAA-807 regression the fix must not undo.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph/constants";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { createMastraDefaultStepHandlers } from "../../../src/mastra/MastraDefaultStepHandlers";
import {
  GRAPH_MASTRA_UNSUPPORTED_KIND,
  type MastraBackendConfig,
} from "../../../src/mastra/types";
import type { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import { graphWorkflowFixturesById } from "../../../src/workflows";
import { frameSinkHarness, rejectionGraphCodeOf } from "./helpers";

/**
 * The runnable non-code fixtures (leaf kinds only; no `core.agent`/`core.utility.code`)
 * the default handler set must execute end to end.
 */
const NON_CODE_FIXTURE_IDS = [
  "fixture-manual-log",
  "fixture-boundary-value",
  "fixture-event-map",
  "fixture-webhook-form",
] as const;

/**
 * The `core.agent` fixture. With no agent runtime configured the default handler
 * fails the `core.agent` node closed, so this fixture is honestly asserted as a
 * fail-closed run rather than a false success (real agent execution is covered by
 * `MastraAgentDriverRun.test.ts`).
 */
const FAIL_CLOSED_FIXTURE_ID = "fixture-chat-agent";

/** Boots the mastra host over the supplied backend config. */
async function bootHost(config: MastraBackendConfig) {
  return createGraphBackendHost({ variant: "mastra", mastra: config });
}

describe("Mastra default step handlers — host wiring (SAA-820)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("boots the mastra host carrying the default handler set", async () => {
    const host = await bootHost({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
    });

    expect(host.variant).toBe("mastra");
    expect(host.engineId).toBe("mastra");
    const backend = host.backend as MastraGraphExecutionBackend;
    expect(backend.config?.stepHandlers).toHaveLength(
      createMastraDefaultStepHandlers().length
    );
  });

  it.each(NON_CODE_FIXTURE_IDS)(
    "executes %s to succeeded",
    async (fixtureId) => {
      const host = await bootHost({
        mastra: {},
        stepHandlers: createMastraDefaultStepHandlers(),
      });
      const backend = host.backend!;
      const fixture = graphWorkflowFixturesById[fixtureId];
      expect(fixture).toBeDefined();
      const harness = frameSinkHarness(`saa-820-${fixtureId}`);

      const result = await backend.execute({
        document: fixture.document,
        plan: {} as never,
        inputs: fixture.inputs ?? {},
        options: {} as never,
        events: harness.sink,
      });

      expect({ id: fixtureId, status: result.status }).toEqual({
        id: fixtureId,
        status: GraphExecutionStatus.SUCCEEDED,
      });
    }
  );

  it("fails fixture-chat-agent closed (no agent runtime) with FAILED + WORKFLOW_FAILED", async () => {
    const host = await bootHost({
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
    });
    const backend = host.backend!;
    const fixture = graphWorkflowFixturesById[FAIL_CLOSED_FIXTURE_ID];
    expect(fixture).toBeDefined();
    const harness = frameSinkHarness(`saa-859-${FAIL_CLOSED_FIXTURE_ID}`);

    const result = await backend.execute({
      document: fixture.document,
      plan: {} as never,
      inputs: fixture.inputs ?? {},
      options: {} as never,
      events: harness.sink,
    });

    expect({ id: FAIL_CLOSED_FIXTURE_ID, status: result.status }).toEqual({
      id: FAIL_CLOSED_FIXTURE_ID,
      status: GraphExecutionStatus.FAILED,
    });
    const types = harness.events.map((event) => event.type);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_FAILED);
    expect(types).not.toContain(GraphExecutionEventType.WORKFLOW_COMPLETED);
  });

  it("still fails closed with GRAPH_MASTRA_UNSUPPORTED_KIND when no stepHandlers are wired", async () => {
    const host = await bootHost({ mastra: {} });
    const backend = host.backend!;
    const fixture = graphWorkflowFixturesById["fixture-manual-log"];
    const harness = frameSinkHarness("saa-820-unhandled");

    const code = await rejectionGraphCodeOf(() =>
      backend.execute({
        document: fixture.document,
        plan: {} as never,
        inputs: fixture.inputs ?? {},
        options: {} as never,
        events: harness.sink,
      })
    );

    expect(code).toBe(GRAPH_MASTRA_UNSUPPORTED_KIND);
  });
});
