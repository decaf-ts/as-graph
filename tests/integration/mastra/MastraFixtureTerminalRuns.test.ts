/**
 * @module as-graph/tests/integration/mastra/MastraFixtureTerminalRuns
 * @summary SAA-1360 integration: the human-approval and value-template demo
 * fixtures run through the production Mastra backend to a succeeded terminal,
 * with no resume.
 * @description Real: the production `MastraGraphExecutionBackend` booted through
 * the `mastra` graph backend host, the production default step-handler set, the
 * production compiler translating both canonical fixtures, and a real
 * `@mastra/core` runtime executing the runs. The only host-injected piece is the
 * frame-bound event sink `GraphExecutionEngine` normally supplies.
 */
import {
  describe,
  it,
  expect,
  afterEach,
  beforeAll,
  afterAll,
} from "@jest/globals";
import { Mastra } from "@mastra/core/mastra";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../../src/shared/graph/constants";
import { createGraphBackendHost } from "../../../src/nest/graph/GraphBackendHost";
import { createMastraDefaultStepHandlers } from "../../../src/mastra/MastraDefaultStepHandlers";
import type { MastraGraphExecutionBackend } from "../../../src/mastra/MastraGraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../src/engine/execution/GraphExecutionBackendRegistry";
import type { GraphWorkflowDocument } from "../../../src/shared/graph";
import { humanApprovalDocument } from "../../../src/workflows/human-approval.workflow";
import { valueTemplatesDocument } from "../../../src/workflows/value-templates.workflow";
import { frameSinkHarness } from "./helpers";

const OBSERVABILITY_ENABLED_OVERRIDE = "MASTRA__OBSERVABILITY__ENABLED";
let observabilityEnabledOriginal: string | undefined;
let backend: MastraGraphExecutionBackend;

/** Boots the production mastra host over a real `@mastra/core` runtime. */
async function bootBackend(): Promise<MastraGraphExecutionBackend> {
  const host = await createGraphBackendHost({
    variant: "mastra",
    mastra: {
      mastra: new Mastra({}),
      stepHandlers: createMastraDefaultStepHandlers(),
    },
  });
  return host.backend as MastraGraphExecutionBackend;
}

beforeAll(async () => {
  observabilityEnabledOriginal = process.env[OBSERVABILITY_ENABLED_OVERRIDE];
  process.env[OBSERVABILITY_ENABLED_OVERRIDE] = "false";
  backend = await bootBackend();
});

afterAll(() => {
  GraphExecutionBackendRegistry.clear();
  if (observabilityEnabledOriginal === undefined) {
    delete process.env[OBSERVABILITY_ENABLED_OVERRIDE];
  } else {
    process.env[OBSERVABILITY_ENABLED_OVERRIDE] = observabilityEnabledOriginal;
  }
});

/** Runs a fixture document through the backend and returns its result + events. */
async function runFixture(
  backend: MastraGraphExecutionBackend,
  document: GraphWorkflowDocument,
  inputs: Record<string, unknown>,
  runId: string
) {
  const harness = frameSinkHarness(runId);
  const result = await backend.execute({
    document,
    plan: {} as never,
    inputs,
    options: {} as never,
    events: harness.sink,
  });
  return { result, harness };
}

describe("mastra fixture terminal runs (SAA-1360 D6)", () => {
  it("runs fixture-human-approval without suspension and emits the approved branch", async () => {
    const { result, harness } = await runFixture(
      backend,
      humanApprovalDocument,
      { n: "ticket-42" },
      "mastra-fixture-human-approval-run"
    );

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);

    const types = harness.events.map((event) => event.type);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_COMPLETED);
    expect(types).not.toContain(GraphExecutionEventType.WORKFLOW_SUSPENDED);

    const approval = harness.events.find(
      (event) =>
        event.type === GraphExecutionEventType.NODE_COMPLETED &&
        event.nodeId === "approval"
    );
    expect(approval?.status).toBe(GraphExecutionStatus.SUCCEEDED);
    const approvalOutputs = (
      approval?.payload as { outputs?: Record<string, unknown> } | undefined
    )?.outputs;
    expect(approvalOutputs).toHaveProperty("approved");
    expect(approvalOutputs).not.toHaveProperty("rejected");
  }, 30_000);

  it("runs fixture-value-templates to a succeeded terminal", async () => {
    const { result, harness } = await runFixture(
      backend,
      valueTemplatesDocument,
      { name: "warn" },
      "mastra-fixture-value-templates-run"
    );

    expect(result.status).toBe(GraphExecutionStatus.SUCCEEDED);

    const types = harness.events.map((event) => event.type);
    expect(types).toContain(GraphExecutionEventType.WORKFLOW_COMPLETED);
    expect(types).not.toContain(GraphExecutionEventType.WORKFLOW_SUSPENDED);

    const completed = harness.events.filter(
      (event) => event.type === GraphExecutionEventType.NODE_COMPLETED
    );
    expect(completed.map((event) => event.nodeId)).toEqual(
      expect.arrayContaining(["expressionLog", "templateLog"])
    );
    expect(
      completed.every((event) => event.status === GraphExecutionStatus.SUCCEEDED)
    ).toBe(true);
  }, 30_000);
});
