/**
 * @module as-graph/tests/integration/mastra/MastraDefaultStepHandlersHost
 * @summary SAA-820 acceptance: a Mastra host booted through
 * `createGraphBackendHost` with `createMastraDefaultStepHandlers()` executes the
 * non-code fixtures to `succeeded`, while an unhandled host still fails closed.
 * @description Boots the production host wiring for the `mastra` variant with the
 * default step-handler set and drives the non-code fixtures through the real
 * `MastraGraphExecutionBackend`. The negative control boots the same host with no
 * `stepHandlers` and asserts a leaf document is still rejected with
 * `GRAPH_MASTRA_UNSUPPORTED_KIND` — the SAA-807 regression the fix must not undo.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { GraphExecutionStatus } from "../../../src/shared/graph/constants";
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
 * The non-code fixtures (leaf kinds only; no `core.utility.code`) the default
 * handler set must execute end to end.
 */
const NON_CODE_FIXTURE_IDS = [
  "fixture-manual-log",
  "fixture-boundary-value",
  "fixture-chat-agent",
  "fixture-event-map",
  "fixture-webhook-form",
] as const;

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
