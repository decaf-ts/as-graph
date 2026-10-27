/**
 * @module as-graph/tests/integration/mastra/MastraFixtureExecution
 * @summary SAA-1545 §7 execution regression: every Mastra per-kind fixture and
 * every focused composite runs through the real
 * `MastraGraphExecutionBackend` with the deterministic host bundle.
 * @description The backend, compiler, step handlers, node classes, and event
 * bridge are the production implementations. The only injected pieces are
 * `createDeterministicMastraHost()` — in-process host services — and an empty
 * in-process `Mastra` runtime handle, so no provider credential, network,
 * database, or channel is touched. Each fixture's declared
 * `expectations.mastra` is the oracle: `expectedStatus` and
 * `expectedSucceededNodeIds` are asserted against the run.
 * The HITL per-kind fixture and resume composite assert the suspend half via the
 * `workflow.suspended` event (the canonical status enum has no `suspended`
 * member, so the event is the engine's suspended signal). The resume half stays
 * the opt-in live-stack path covered by `MastraHitlRun.test.ts` (it needs a real
 * Mastra runtime + durable store).
 */
import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";

import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph/constants";
import { Mastra } from "@mastra/core/mastra";
import { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { createMastraDefaultStepHandlers } from "../../../src/mastra/MastraDefaultStepHandlers";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import {
  mastraKindFixtures,
  mastraCompositeFixtures,
  mastraWorkflowFixtures,
} from "../../../src/workflows/mastra";
import { createDeterministicMastraHost } from "../../../src/workflows/mastra/host-fakes";
import { frameSinkHarness } from "./helpers";

jest.setTimeout(120000);

const OBSERVABILITY_ENABLED_OVERRIDE = "MASTRA__OBSERVABILITY__ENABLED";
let observabilityEnabledOriginal: string | undefined;

beforeAll(() => {
  observabilityEnabledOriginal = process.env[OBSERVABILITY_ENABLED_OVERRIDE];
  process.env[OBSERVABILITY_ENABLED_OVERRIDE] = "false";
});

afterAll(() => {
  GraphExecutionBackendRegistry.clear();
  if (observabilityEnabledOriginal === undefined) {
    delete process.env[OBSERVABILITY_ENABLED_OVERRIDE];
  } else {
    process.env[OBSERVABILITY_ENABLED_OVERRIDE] = observabilityEnabledOriginal;
  }
});

/** The HITL fixture suspends; it is asserted separately from the run loop. */
const HITL_FIXTURE_ID = "fixture-mastra-hitl";

const EXECUTABLE_KIND_FIXTURES = mastraKindFixtures.filter(
  (fixture) => fixture.id !== HITL_FIXTURE_ID
);

const EXECUTABLE_COMPOSITES = mastraCompositeFixtures.filter(
  (fixture) => fixture.expectations?.mastra?.expectedStatus !== "suspended"
);

/** Boots the production backend with the deterministic host services. */
async function bootBackend(): Promise<MastraGraphExecutionBackend> {
  const { config } = createDeterministicMastraHost({
    // A real in-process Mastra runtime: suspension needs the run lifecycle the
    // runtime owns. No store/network/provider is involved.
    mastra: new Mastra({}),
    // The neutral/leaf kinds (result, map, log, loops, ...) are host-supplied:
    // the backend deliberately registers only Mastra-owned kinds itself.
    stepHandlers: createMastraDefaultStepHandlers(),
  });
  const backend = new MastraGraphExecutionBackend();
  await backend.initialize(config);
  return backend;
}

/** Executes one fixture and returns its result plus recorded events. */
async function runFixture(
  backend: MastraGraphExecutionBackend,
  fixture: (typeof mastraWorkflowFixtures)[number]
) {
  const harness = frameSinkHarness(`mastra-fixture-exec-${fixture.id}`);
  const result = await backend.execute({
    document: fixture.document,
    plan: undefined as never,
    inputs: (fixture.inputs ?? {}) as never,
    options: {} as never,
    events: harness.sink,
  });
  return { result, events: harness.events };
}

/** Node ids the event bridge reported as completed successfully. */
function succeededNodeIds(
  events: Awaited<ReturnType<typeof runFixture>>["events"]
): string[] {
  return events
    .filter(
      (event) =>
        event.type === GraphExecutionEventType.NODE_COMPLETED &&
        event.status === GraphExecutionStatus.SUCCEEDED
    )
    .map((event) => String(event.nodeId));
}

describe("Mastra per-kind fixture execution (SAA-1545 §7)", () => {
  it.each(EXECUTABLE_KIND_FIXTURES.map((fixture) => [fixture.id, fixture]))(
    "executes %s to its expected Mastra status",
    async (_id, fixture) => {
      const backend = await bootBackend();
      const expectation = fixture.expectations?.mastra;
      expect(expectation).toBeDefined();
      const { result, events } = await runFixture(backend, fixture);

      if (expectation!.expectedStatus === "suspended") {
        const types = events.map((event) => event.type);
        expect(types).toContain(GraphExecutionEventType.WORKFLOW_SUSPENDED);
        expect(types).not.toContain(GraphExecutionEventType.WORKFLOW_FAILED);
        return;
      }

      expect({ id: fixture.id, status: result.status }).toEqual({
        id: fixture.id,
        status: expectation!.expectedStatus,
      });
      const succeeded = succeededNodeIds(events);
      for (const nodeId of expectation!.expectedSucceededNodeIds ?? []) {
        expect({ id: fixture.id, nodeId, succeeded }).toEqual({
          id: fixture.id,
          nodeId,
          succeeded: expect.arrayContaining([nodeId]),
        });
      }
    }
  );

  it("suspends the HITL per-kind fixture with the declared suspend event", async () => {
    const backend = await bootBackend();
    const fixture = mastraWorkflowFixtures.find(
      (candidate) => candidate.id === HITL_FIXTURE_ID
    )!;
    expect(fixture).toBeDefined();
    expect(fixture.expectations?.mastra?.expectedStatus).toBe("suspended");

    const { events } = await runFixture(backend, fixture);
    const types = events.map((event) => event.type);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_SUSPENDED);
    expect(types).not.toContain(GraphExecutionEventType.WORKFLOW_FAILED);
  });

  it("suspends the HITL resume composite", async () => {
    const backend = await bootBackend();
    const fixture = mastraCompositeFixtures.find(
      (candidate) => candidate.id === "fixture-mastra-hitl-resume"
    )!;
    expect(fixture).toBeDefined();
    expect(fixture.expectations?.mastra?.expectedStatus).toBe("suspended");

    const { events } = await runFixture(backend, fixture);
    const types = events.map((event) => event.type);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_SUSPENDED);
    expect(types).not.toContain(GraphExecutionEventType.WORKFLOW_FAILED);
  });
});

/**
 * Reads one node's completed output values from the run events. The
 * backend-direct harness used here does not populate the workflow-level
 * `result.outputs` map, so the node-completed event is the real observable
 * output surface.
 */
function nodeOutputs(
  events: Awaited<ReturnType<typeof runFixture>>["events"],
  nodeId: string
): Record<string, unknown> {
  const completed = events.find(
    (event) =>
      event.type === GraphExecutionEventType.NODE_COMPLETED &&
      String(event.nodeId) === nodeId
  );
  const payload = completed?.payload as
    | { outputs?: Record<string, unknown> }
    | undefined;
  return payload?.outputs ?? {};
}

describe("Mastra channel discord fixtures — success-path parity (SAA-1590)", () => {
  it("routes the discord trigger conversation binding onto its outputs (null defaults)", async () => {
    const backend = await bootBackend();
    const fixture = mastraWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-mastra-trigger-discord"
    )!;
    expect(fixture).toBeDefined();
    // The per-kind trigger fixture is an entrypoint: it declares no workflow
    // input ports, so the run supplies no routed conversation payload and the
    // trigger emits the documented null defaults.
    expect(fixture.inputs).toEqual({});

    const { events } = await runFixture(backend, fixture);
    expect({ id: fixture.id, outputs: nodeOutputs(events, "target") }).toEqual({
      id: fixture.id,
      outputs: {
        message: null,
        sessionId: null,
        userId: null,
        threadId: null,
        resource: { __fakeChannelAdapter: true, channel: "discord" },
      },
    });
  });

  it("posts the discord response reply through the deterministic host and exposes the posted resource", async () => {
    const backend = await bootBackend();
    const fixture = mastraWorkflowFixtures.find(
      (candidate) => candidate.id === "fixture-mastra-response-discord"
    )!;
    expect(fixture).toBeDefined();
    expect(fixture.inputs).toEqual({
      "in-response": "response-value",
      "in-threadId": "threadId-value",
    });

    const { events } = await runFixture(backend, fixture);
    expect({ id: fixture.id, outputs: nodeOutputs(events, "target") }).toEqual({
      id: fixture.id,
      outputs: {
        resource: {
          __fakeChannelDelivery: true,
          channel: "discord",
          payload: {
            response: "response-value",
            threadId: "threadId-value",
          },
        },
      },
    });
  });
});

describe("Mastra composite fixture execution (SAA-1545 §7)", () => {
  it.each(EXECUTABLE_COMPOSITES.map((fixture) => [fixture.id, fixture]))(
    "executes %s to its expected Mastra status",
    async (_id, fixture) => {
      const backend = await bootBackend();
      const expectation = fixture.expectations?.mastra;
      expect(expectation).toBeDefined();
      const { result, events } = await runFixture(backend, fixture);

      if (expectation!.expectedStatus === "suspended") {
        const types = events.map((event) => event.type);
        expect(types).toContain(GraphExecutionEventType.WORKFLOW_SUSPENDED);
        expect(types).not.toContain(GraphExecutionEventType.WORKFLOW_FAILED);
        return;
      }

      expect({ id: fixture.id, status: result.status }).toEqual({
        id: fixture.id,
        status: expectation!.expectedStatus,
      });
      const succeeded = succeededNodeIds(events);
      for (const nodeId of expectation!.expectedSucceededNodeIds ?? []) {
        expect({ id: fixture.id, nodeId, succeeded }).toEqual({
          id: fixture.id,
          nodeId,
          succeeded: expect.arrayContaining([nodeId]),
        });
      }
    }
  );
});
