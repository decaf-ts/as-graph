/**
 * @module as-graph/tests/unit/graph/mastra/MastraMetricsGateway
 * @summary Unit evidence for the owner-scoped mastra metrics serving gateway
 * (SAA-836 S2).
 * @description Proves the C23 deny contract (unknown and foreign-owner
 * workflows deny with the same constant `NotFoundError`, so a caller cannot
 * probe foreign workflow ids), the owner-less visibility rule, the run→workflow
 * narrowing for score/trace reads, the page envelope metadata, the page-size
 * clamping, and the SAA-93 F1 payload-visibility projection applied to metric
 * rows.
 */
import { NotFoundError } from "@decaf-ts/db-decorators";
import {
  MastraMetricsGateway,
  MASTRA_METRICS_PAGE_SIZE_MAX,
  type MastraMetricsOwnership,
} from "../../../../src/mastra/MastraMetricsGateway";
import {
  MastraRunMetricModel,
  MastraScoreMetricModel,
  MastraTraceMetricModel,
  type MastraStorageRunRow,
  type MastraStorageScoreRow,
  type MastraStorageSpanRow,
} from "../../../../src/mastra/MastraMetricsModels";

/** A fake mastra runtime exposing the given storage domains. */
function fakeMastra(domains: Record<string, unknown>): unknown {
  return {
    getStorage: () => ({
      getStore: (domain: string) => Promise.resolve(domains[domain]),
    }),
  };
}

/** Five deterministic run rows for one workflow, as mastra returns them. */
function runRows(workflowName = "wf-a"): MastraStorageRunRow[] {
  return Array.from({ length: 5 }, (_, index) => ({
    runId: `run-${index + 1}`,
    workflowName,
    snapshot: { status: index === 0 ? "success" : "running" },
    createdAt: new Date(Date.UTC(2026, 0, 1, 10, 0, index)),
  }));
}

/** A gateway over a fake runtime with a map-backed ownership anchor. */
function gatewayOf(
  domains: Record<string, unknown>,
  ownership: Record<string, { known: boolean; owner?: string } | undefined>
): MastraMetricsGateway {
  const anchor: MastraMetricsOwnership = {
    resolveWorkflow: (workflowId) => ownership[workflowId],
  };
  return new MastraMetricsGateway({
    mastra: fakeMastra(domains),
    ownership: anchor,
    alias: `mastra-metrics-gateway-${++GATEWAY_SEQUENCE}`,
  });
}

/** Unique-alias counter: the Decaf adapter registry rejects duplicate flavour aliases. */
let GATEWAY_SEQUENCE = 0;

describe("MastraMetricsGateway (SAA-836 S2)", () => {
  const domains = (workflowName = "wf-a") => ({
    workflows: {
      listWorkflowRuns: async (args: {
        page?: number;
        perPage?: number | false;
      }) => {
        const rows = runRows(workflowName);
        const perPage = args.perPage === undefined ? rows.length : args.perPage;
        const page = args.page ?? 0;
        const sliced =
          perPage === false ? rows : rows.slice(page * perPage, (page + 1) * perPage);
        return { runs: sliced, total: rows.length };
      },
      getWorkflowRunById: async ({ runId }: { runId: string }) =>
        runRows(workflowName).find((row) => row.runId === runId) ?? null,
    },
    scores: {
      listScoresByRunId: async () => ({
        scores: [
          {
            id: "score-1",
            runId: "run-1",
            scorerId: "s",
            score: 0.5,
            input: { prompt: "secret" },
            output: { answer: "secret" },
            createdAt: new Date(),
          } satisfies MastraStorageScoreRow,
        ],
        pagination: { total: 1 },
      }),
    },
    observability: {
      listTraces: async () => ({
        spans: [
          {
            traceId: "trace-1",
            spanId: "span-1",
            runId: "run-1",
            name: "root",
            status: "success",
            // The span summary payload: `mastraSpanRowToModel` builds the
            // served `summary` member from this raw attributes payload.
            attributes: { step: "root" },
          } satisfies MastraStorageSpanRow,
        ],
        pagination: { total: 1 },
      }),
    },
  });

  const ownership = () => ({
    "wf-a": { known: true, owner: "alice" },
    "wf-open": { known: true }, // owner-less (standalone) workflow
  });

  describe("C23 ownership deny", () => {
    it("denies an unknown workflow with NotFoundError", async () => {
      const gateway = gatewayOf(domains(), ownership());
      await expect(gateway.listRuns("wf-unknown", "alice")).rejects.toBeInstanceOf(
        NotFoundError
      );
    });

    it("denies a foreign owner with the same constant NotFoundError", async () => {
      const gateway = gatewayOf(domains(), ownership());
      let unknownError: unknown;
      try {
        await gateway.listRuns("wf-unknown", "alice");
      } catch (error) {
        unknownError = error;
      }
      let foreignError: unknown;
      try {
        await gateway.listRuns("wf-a", "bob");
      } catch (error) {
        foreignError = error;
      }
      expect(foreignError).toBeInstanceOf(NotFoundError);
      // The two denials are indistinguishable in kind: the same constant
      // message shape (the id is the caller's own input), and no details.
      expect((foreignError as Error).message).toBe(
        "[NotFoundError][404] No graph workflow found for workflowId 'wf-a'"
      );
      expect((unknownError as Error).message).toBe(
        "[NotFoundError][404] No graph workflow found for workflowId 'wf-unknown'"
      );
      expect((foreignError as { details?: unknown }).details).toBeUndefined();
    });

    it("denies an anonymous caller on an owned workflow", async () => {
      const gateway = gatewayOf(domains(), ownership());
      await expect(gateway.listRuns("wf-a", null)).rejects.toBeInstanceOf(
        NotFoundError
      );
    });

    it("keeps an owner-less workflow visible to every caller", async () => {
      const gateway = gatewayOf(domains(), ownership());
      for (const caller of [null, "alice", "bob"]) {
        await expect(gateway.listRuns("wf-open", caller)).resolves.toMatchObject({
          current: 1,
          count: 5,
        });
      }
    });

    it("serves the owner and the anonymous caller their own workflow", async () => {
      const gateway = gatewayOf(domains(), ownership());
      await expect(gateway.listRuns("wf-a", "alice")).resolves.toMatchObject({
        current: 1,
        count: 5,
        total: 1,
      });
      await expect(gateway.getRun("wf-a", "run-1", "alice")).resolves.toBeInstanceOf(
        MastraRunMetricModel
      );
    });
  });

  describe("run→workflow narrowing", () => {
    it("denies score and trace reads for a run of another workflow", async () => {
      const gateway = gatewayOf(domains(), ownership());
      await expect(
        gateway.listScores("wf-a", "run-foreign", "alice")
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        gateway.listTraces("wf-a", "run-foreign", "alice")
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        gateway.getRun("wf-a", "run-foreign", "alice")
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("serves score and trace reads for a run of the accessed workflow", async () => {
      const gateway = gatewayOf(domains(), ownership());
      await expect(
        gateway.listScores("wf-a", "run-1", "alice")
      ).resolves.toMatchObject({ count: 1 });
      await expect(
        gateway.listTraces("wf-a", "run-1", "alice")
      ).resolves.toMatchObject({ count: 1 });
    });
  });

  describe("serving shape", () => {
    it("serves paginated rows with one-indexed page metadata and page-size clamping", async () => {
      const gateway = gatewayOf(domains(), ownership());
      const page = await gateway.listRuns("wf-a", "alice", 2, 2);
      expect(page.data).toHaveLength(2);
      expect(page.current).toBe(2);
      expect(page.count).toBe(5);
      expect(page.total).toBe(3);
      expect(page.data[0]).toBeInstanceOf(MastraRunMetricModel);

      // A page size above the maximum degrades to the default, never errors.
      const clamped = await gateway.listRuns(
        "wf-a",
        "alice",
        1,
        MASTRA_METRICS_PAGE_SIZE_MAX + 1
      );
      expect(clamped.data).toHaveLength(5);
    });

    it("never serves nil rows: an empty page is an empty array (R7)", async () => {
      const gateway = gatewayOf(
        {
          workflows: {
            listWorkflowRuns: async () => ({ runs: [], total: 0 }),
            getWorkflowRunById: async () => null,
          },
        },
        ownership()
      );
      const page = await gateway.listRuns("wf-open", null, 1, 5);
      expect(page.data).toEqual([]);
      expect(page.count).toBe(0);
    });

    it("projects score and trace rows into their read-only models", async () => {
      const gateway = gatewayOf(domains(), ownership());
      const scores = await gateway.listScores("wf-a", "run-1", "alice");
      expect(scores.data[0]).toBeInstanceOf(MastraScoreMetricModel);
      const traces = await gateway.listTraces("wf-a", "run-1", "alice");
      expect(traces.data[0]).toBeInstanceOf(MastraTraceMetricModel);
    });
  });

  describe("payload visibility (SAA-93 F1 contract)", () => {
    it("serves the payload only to the recorded owner", () => {
      const gateway = gatewayOf(domains(), ownership());
      expect(gateway.payloadVisibleOf("wf-a", "alice")).toBe(true);
      expect(gateway.payloadVisibleOf("wf-a", "bob")).toBe(false);
      expect(gateway.payloadVisibleOf("wf-a", null)).toBe(false);
    });

    it("applies the owner-less payload rule to owner-less workflows", () => {
      const gateway = gatewayOf(domains(), ownership());
      expect(gateway.payloadVisibleOf("wf-open", null)).toBe(true);
      expect(gateway.payloadVisibleOf("wf-open", "alice")).toBe(false);
    });

    it("returns false for unknown workflows", () => {
      const gateway = gatewayOf(domains(), ownership());
      expect(gateway.payloadVisibleOf("wf-unknown", null)).toBe(false);
    });
  });

  describe("payload-gated score/trace reads (SAA-887 regression, SAA-93 F1)", () => {
    it("gates input/output/summary from a named caller on an owner-less workflow", async () => {
      const gateway = gatewayOf(domains("wf-open"), ownership());
      expect(gateway.payloadVisibleOf("wf-open", "alice")).toBe(false);

      const scores = await gateway.listScores("wf-open", "run-1", "alice");
      const scoreRow = scores.data[0] as unknown as Record<string, unknown>;
      // The payload members are deleted outright, not merely `undefined`.
      expect("input" in scoreRow).toBe(false);
      expect("output" in scoreRow).toBe(false);
      expect(scoreRow).toMatchObject({
        scoreId: "score-1",
        runId: "run-1",
        workflowId: "wf-open",
        scorerId: "s",
        score: 0.5,
      });

      const traces = await gateway.listTraces("wf-open", "run-1", "alice");
      const traceRow = traces.data[0] as unknown as Record<string, unknown>;
      expect("summary" in traceRow).toBe(false);
      expect(traceRow).toMatchObject({
        spanId: "span-1",
        traceId: "trace-1",
        runId: "run-1",
        workflowId: "wf-open",
        name: "root",
        status: "success",
      });
    });

    it("serves input/output/summary to an owner-less caller on an owner-less workflow", async () => {
      const gateway = gatewayOf(domains("wf-open"), ownership());
      expect(gateway.payloadVisibleOf("wf-open", null)).toBe(true);

      const scores = await gateway.listScores("wf-open", "run-1", null);
      expect(scores.data[0].input).toEqual({ prompt: "secret" });
      expect(scores.data[0].output).toEqual({ answer: "secret" });

      const traces = await gateway.listTraces("wf-open", "run-1", null);
      expect(traces.data[0].summary).toEqual({
        attributes: { step: "root" },
      });
    });

    it("serves input/output/summary to the recorded owner of an owned workflow", async () => {
      const gateway = gatewayOf(domains(), ownership());
      expect(gateway.payloadVisibleOf("wf-a", "alice")).toBe(true);

      const scores = await gateway.listScores("wf-a", "run-1", "alice");
      expect(scores.data[0].input).toEqual({ prompt: "secret" });
      expect(scores.data[0].output).toEqual({ answer: "secret" });

      const traces = await gateway.listTraces("wf-a", "run-1", "alice");
      expect(traces.data[0].summary).toEqual({
        attributes: { step: "root" },
      });
    });

    it("gates the payload for a resource-visible named caller that is not the payload owner", async () => {
      // Negative control: `bob` is resource-visible on the owner-less workflow
      // (C23 owner-less branch) but is strictly not its payload owner, so the
      // served rows must still be gated.
      const openGateway = gatewayOf(domains("wf-open"), ownership());
      const scores = await openGateway.listScores("wf-open", "run-1", "bob");
      const scoreRow = scores.data[0] as unknown as Record<string, unknown>;
      expect("input" in scoreRow).toBe(false);
      expect("output" in scoreRow).toBe(false);
      const traces = await openGateway.listTraces("wf-open", "run-1", "bob");
      const traceRow = traces.data[0] as unknown as Record<string, unknown>;
      expect("summary" in traceRow).toBe(false);

      // On an owned workflow the same named foreign caller cannot observe rows
      // at all: C23 denies the read before any payload decision.
      const ownedGateway = gatewayOf(domains(), ownership());
      await expect(
        ownedGateway.listScores("wf-a", "run-1", "bob")
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        ownedGateway.listTraces("wf-a", "run-1", "bob")
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("ownership anchor queries", () => {
    it("resolves known and unknown workflows and their recorded owners", () => {
      const gateway = gatewayOf(domains(), ownership());
      expect(gateway.knowsWorkflowOf("wf-a")).toBe(true);
      expect(gateway.knowsWorkflowOf("wf-open")).toBe(true);
      expect(gateway.knowsWorkflowOf("wf-unknown")).toBe(false);
      expect(gateway.ownerOf("wf-a")).toBe("alice");
      expect(gateway.ownerOf("wf-open")).toBeUndefined();
      expect(gateway.ownerOf("wf-unknown")).toBeUndefined();
    });
  });
});
