/**
 * @module as-graph/tests/unit/graph/mastra/MastraRunMetricsEndpoint
 * @summary Unit evidence for the editor-endpoint delegation of mastra agent
 * run metrics (SAA-836 S2).
 * @description Proves the same-endpoint delegation contract of
 * `createMastraRunMetricsDelegation`: non-mastra-owned workflows return
 * `undefined` (the endpoint falls back to its local run rows), mastra-owned
 * workflows are served as the flat array shape or the `{ data, current, total,
 * count }` page envelope, the SAA-93 F1 snapshot payload is served only to the
 * recorded owner, dates are projected as ISO-8601, and a foreign owner is
 * denied with the C23 `NotFoundError`. Also proves
 * `mastraRunMetricsDelegationOf` resolves the delegation only for the mastra
 * backend.
 */
import { NotFoundError } from "@decaf-ts/db-decorators";
import {
  createMastraRunMetricsDelegation,
  mastraRunMetricsDelegationOf,
  MASTRA_RUN_METRICS_DELEGATION,
  type MastraRunMetricsPageHttp,
} from "../../../../src/mastra/MastraRunMetricsEndpoint";
import { MastraMetricsGateway } from "../../../../src/mastra/MastraMetricsGateway";
import { MastraGraphExecutionBackend } from "../../../../src/mastra/MastraGraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../../../src/engine/execution/GraphExecutionBackendRegistry";

/** True ISO-8601 rendering the HTTP boundary must serve (SAA-76 contract). */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** A fake mastra runtime exposing the given storage domains. */
function fakeMastra(domains: Record<string, unknown>): unknown {
  return {
    getStorage: () => ({
      getStore: (domain: string) => Promise.resolve(domains[domain]),
    }),
  };
}

function gatewayOf(
  domains: Record<string, unknown>,
  ownership: Record<string, { known: boolean; owner?: string } | undefined>
): MastraMetricsGateway {
  return new MastraMetricsGateway({
    mastra: fakeMastra(domains),
    ownership: { resolveWorkflow: (workflowId) => ownership[workflowId] },
    alias: `mastra-metrics-endpoint-${++GATEWAY_SEQUENCE}`,
  });
}

/** One run row of the served workflow, with a sensitive snapshot payload. */
function runRows(): unknown[] {
  return [
    {
      runId: "run-1",
      workflowName: "wf-a",
      snapshot: { status: "success", secret: "payload" },
      createdAt: new Date("2026-01-01T10:00:00Z"),
      updatedAt: new Date("2026-01-01T10:01:00Z"),
    },
    {
      runId: "run-2",
      workflowName: "wf-a",
      snapshot: { status: "running" },
      createdAt: new Date("2026-01-01T10:02:00Z"),
    },
  ];
}

function domains(): Record<string, unknown> {
  const rows = runRows() as Array<{ runId: string } & Record<string, unknown>>;
  return {
    workflows: {
      listWorkflowRuns: async (args: {
        page?: number;
        perPage?: number | false;
      }) => {
        const perPage = args.perPage === undefined ? rows.length : args.perPage;
        const page = args.page ?? 0;
        const sliced =
          perPage === false ? rows : rows.slice(page * perPage, (page + 1) * perPage);
        return { runs: sliced, total: rows.length };
      },
      getWorkflowRunById: async ({ runId }: { runId: string }) =>
        rows.find((row) => row.runId === runId) ?? null,
    },
  };
}

const OWNERSHIP = {
  "wf-a": { known: true, owner: "alice" },
  "wf-open": { known: true },
};

/** Unique-alias counter: the Decaf adapter registry rejects duplicate flavour aliases. */
let GATEWAY_SEQUENCE = 0;

describe("MastraRunMetricsEndpoint delegation (SAA-836 S2)", () => {
  afterEach(() => {
    GraphExecutionBackendRegistry.clear();
  });

  it("exports the provider injection token", () => {
    expect(MASTRA_RUN_METRICS_DELEGATION).toBe("MASTRA_RUN_METRICS_DELEGATION");
  });

  it("returns undefined for a workflow the gateway does not know (fallback path)", async () => {
    const delegation = createMastraRunMetricsDelegation(
      gatewayOf(domains(), OWNERSHIP)
    );
    await expect(delegation.listRuns("wf-unknown", "alice", undefined, undefined)).resolves.toBeUndefined();
  });

  it("serves a mastra-owned workflow as the flat array shape without paging", async () => {
    const delegation = createMastraRunMetricsDelegation(
      gatewayOf(domains(), OWNERSHIP)
    );
    const rows = (await delegation.listRuns(
      "wf-a",
      "alice",
      undefined,
      undefined
    )) as Record<string, unknown>[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.map((row) => row.runId)).toEqual(["run-1", "run-2"]);
    expect(rows[0]).toMatchObject({
      runId: "run-1",
      workflowId: "wf-a",
      status: "success",
      owner: "alice",
    });
  });

  it("serves the page envelope when paging is requested", async () => {
    const delegation = createMastraRunMetricsDelegation(
      gatewayOf(domains(), OWNERSHIP)
    );
    const page = (await delegation.listRuns(
      "wf-a",
      "alice",
      2,
      1
    )) as MastraRunMetricsPageHttp;
    expect(Object.keys(page).sort()).toEqual(["count", "current", "data", "total"]);
    expect(page.current).toBe(2);
    expect(page.total).toBe(2);
    expect(page.count).toBe(2);
    expect(page.data.map((row) => row.runId)).toEqual(["run-2"]);
  });

  it("serves the snapshot payload only to the recorded owner (SAA-93 F1)", async () => {
    const delegation = createMastraRunMetricsDelegation(
      gatewayOf(domains(), OWNERSHIP)
    );
    const owned = (await delegation.listRuns(
      "wf-a",
      "alice",
      undefined,
      undefined
    )) as Record<string, unknown>[];
    expect(owned[0].snapshot).toEqual({ status: "success", secret: "payload" });

    // A named non-owner cannot even reach the rows: C23 denies first.
    await expect(
      delegation.listRuns("wf-a", "bob", undefined, undefined)
    ).rejects.toBeInstanceOf(NotFoundError);

    // Owner-less workflows keep the payload open to an owner-less caller only.
    const openDelegation = createMastraRunMetricsDelegation(
      gatewayOf(domains(), { "wf-open": OWNERSHIP["wf-open"] })
    );
    const openRows = (await openDelegation.listRuns(
      "wf-open",
      null,
      undefined,
      undefined
    )) as Record<string, unknown>[];
    expect(openRows[0].snapshot).toEqual({ status: "success", secret: "payload" });

    const namedOnOpen = (await openDelegation.listRuns(
      "wf-open",
      "alice",
      undefined,
      undefined
    )) as Record<string, unknown>[];
    expect(namedOnOpen[0].snapshot).toBeUndefined();
  });

  it("projects every served date as ISO-8601", async () => {
    const delegation = createMastraRunMetricsDelegation(
      gatewayOf(domains(), OWNERSHIP)
    );
    const rows = (await delegation.listRuns(
      "wf-a",
      "alice",
      undefined,
      undefined
    )) as Record<string, unknown>[];
    for (const row of rows) {
      expect(row.createdAt).toMatch(ISO_8601);
      expect(row.updatedAt).toMatch(ISO_8601);
    }
  });

  it("resolves the delegation only for the mastra backend", async () => {
    expect(mastraRunMetricsDelegationOf({})).toBeUndefined();
    expect(mastraRunMetricsDelegationOf(undefined)).toBeUndefined();

    const backend = new MastraGraphExecutionBackend();
    await backend.initialize({ mastra: {} });
    const delegation = mastraRunMetricsDelegationOf(backend);
    expect(delegation).toBeDefined();
    // Non-mastra-owned workflows still fall back through the resolved delegation.
    await expect(
      delegation!.listRuns("wf-unknown", null, undefined, undefined)
    ).resolves.toBeUndefined();
  });
});
