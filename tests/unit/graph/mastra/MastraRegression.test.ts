/**
 * @module as-graph/tests/unit/graph/mastra/MastraRegression
 * @summary Regression tests for the SAA-196 `./mastra` fixes (SAA-203).
 * @description Covers the three defects reported from the SAA-201 driver suite:
 * (1) `MastraGraphExecutionBackend.initialize` now wires `config.stepHandlers`
 * into its compiler, (2) the C15 resume guard now validates `resumeData` against
 * the suspended node's declared `resumeSchema`, and (3) the `parallel` capability
 * row is declared `NOT-SUPPORTED` (fan-out/fan-in is not translated).
 */
import { MastraGraphExecutionBackend } from "../../../../src/mastra/MastraGraphExecutionBackend";
import {
  MASTRA_FEATURE_CAPABILITIES,
  mastraCapabilityOf,
} from "../../../../src/mastra/MastraCapabilities";
import {
  assertMastraResumeAllowed,
  type MastraResumeGuardOptions,
  type MastraResumeSnapshot,
} from "../../../../src/mastra/MastraResumeGuard";
import {
  GRAPH_MASTRA_RESUME_INVALID,
  GRAPH_MASTRA_UNSUPPORTED_KIND,
  type MastraResumeRequest,
} from "../../../../src/mastra/types";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";
import { frameBoundSink, graphCodeOf, leafHandler, twoLeafDocument } from "./helpers";

describe("SAA-203 regression: Mastra backend stepHandlers wiring", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("translates ordinary leaf nodes when stepHandlers are supplied at initialize", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({
      mastra: {},
      stepHandlers: [leafHandler("test.leaf")],
    });
    const { sink } = frameBoundSink();
    const source = twoLeafDocument();

    const result = await backend.execute({
      document: source,
      plan: {} as never,
      inputs: {},
      options: {} as never,
      events: sink,
    });

    expect(result.workflowId).toBe(source.id);
    const summaries = await backend.listWorkflows();
    expect(summaries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: source.id })])
    );
    const translated = await backend.getWorkflow(source.id);
    expect(translated.id).toBe(source.id);
    expect((translated.nodes ?? []).map((node) => node.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("fails closed with GRAPH_MASTRA_UNSUPPORTED_KIND when stepHandlers are omitted", async () => {
    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {} });
    const { sink } = frameBoundSink();

    await expect(
      backend.execute({
        document: twoLeafDocument(),
        plan: {} as never,
        inputs: {},
        options: {} as never,
        events: sink,
      })
    ).rejects.toMatchObject({ graphCode: GRAPH_MASTRA_UNSUPPORTED_KIND });
  });
});

describe("SAA-203 regression: C15 resume schema validation", () => {
  const snapshot: MastraResumeSnapshot = {
    runId: "run-1",
    workflowId: "wf-1",
    documentFingerprint: "fp-current",
    status: "suspended",
    step: "approve",
    state: { suspended: true },
  };

  const baseOptions: MastraResumeGuardOptions = {
    maxResumeBytes: 1024,
    allowlistedSteps: ["approve"],
    documentFingerprint: "fp-current",
  };

  it("rejects resumeData that fails the declared resume schema", () => {
    const options: MastraResumeGuardOptions = {
      ...baseOptions,
      resumeSchema: { safeParse: () => ({ success: false }) },
    };
    const request: MastraResumeRequest = {
      step: "approve",
      resumeData: { approved: true },
    };

    expect(
      graphCodeOf(() => assertMastraResumeAllowed(request, snapshot, options))
    ).toBe(GRAPH_MASTRA_RESUME_INVALID);
  });

  it("returns the audit when the permissive resume schema accepts resumeData", () => {
    const options: MastraResumeGuardOptions = {
      ...baseOptions,
      resumeSchema: { safeParse: () => ({ success: true }) },
    };
    const request: MastraResumeRequest = {
      step: "approve",
      resumeData: { approved: true },
    };

    const audit = assertMastraResumeAllowed(request, snapshot, options);

    expect(audit.runId).toBe("run-1");
    expect(audit.step).toBe("approve");
    expect(audit.resumeDataHash).toMatch(/^fnv1a:[0-9a-f]{8}:\d+$/);
  });
});

describe("SAA-203 regression: parallel capability row", () => {
  it("declares parallel as NOT-SUPPORTED", () => {
    expect(mastraCapabilityOf("parallel")).toBeDefined();
    expect(mastraCapabilityOf("parallel")!.verdict).toBe("NOT-SUPPORTED");
    expect(
      MASTRA_FEATURE_CAPABILITIES.some(
        (row) => row.feature === "parallel" && row.verdict === "SUPPORTED"
      )
    ).toBe(false);
  });
});
