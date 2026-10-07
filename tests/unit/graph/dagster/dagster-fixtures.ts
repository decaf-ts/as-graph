/**
 * @module as-graph/tests/unit/graph/dagster/fixtures
 * @summary Test fixtures for the read-only Dagster driver tests.
 * @description A scripted, in-memory gateway port that stands in for a real
 * Dagster deployment. It only exposes the read-only surface (listing, lookup, run
 * records, run events, termination) — there is no launch method, mirroring the
 * owner mandate.
 */
import type {
  DagsterClient,
  DagsterEventRecord,
  DagsterJobRecord,
  DagsterJobSummary,
  DagsterRunRecord,
  DagsterRunSubscription,
} from "../../../../src/dagster/DagsterTypes";

/**
 * A deployed Dagster job fixture with a real op/dependency/asset structure.
 */
export const DAGSTER_FIXTURE_JOB: DagsterJobRecord = {
  name: "dagsterwf_job",
  description: "fixture job",
  ops: [
    {
      name: "adder",
      nodeId: "adder",
      kind: "core.flow.log",
      inputs: ["value"],
      outputs: ["result"],
    },
    {
      name: "multiplier",
      nodeId: "multiplier",
      kind: "core.utility.map",
      inputs: ["value"],
      outputs: ["result"],
    },
  ],
  dependencies: [{ from: "adder", to: "multiplier" }],
  assetKeys: ["asset_a", "asset_b"],
  schedules: [{ name: "hourly", cron: "0 * * * *", timezone: "UTC" }],
  sensors: [{ name: "hook", kind: "core.trigger.webhook" }],
};

/**
 * A scripted, in-memory Dagster gateway port. Records terminations and
 * replays a preset event sequence on subscription. Listing/lookup are required.
 */
export class FakeDagsterClient implements DagsterClient {
  readonly terminated: { runId: string; reason?: string }[] = [];
  readonly subscribed: string[] = [];
  disposed = false;

  private readonly handlers = new Map<
    string,
    (event: DagsterEventRecord) => void
  >();
  private readonly records = new Map<string, DagsterRunRecord>();

  /**
   * @param events - Events replayed on every subscription.
   * @param terminal - The terminal record returned by `getRun`.
   * @param jobs - Job summaries returned by `listJobs`.
   * @param jobRecords - Full job records returned by `getJob`, keyed by name.
   */
  constructor(
    private readonly events: DagsterEventRecord[] = [],
    private readonly terminal: DagsterRunRecord = {
      runId: "run-1",
      status: "success",
      outputs: {},
    },
    private readonly jobs: DagsterJobSummary[] = [],
    private readonly jobRecords: Record<string, DagsterJobRecord> = {}
  ) {}

  async listJobs(): Promise<DagsterJobSummary[]> {
    return this.jobs;
  }

  async getJob(jobName: string): Promise<DagsterJobRecord> {
    const record = this.jobRecords[jobName];
    if (record) return record;
    if (jobName === DAGSTER_FIXTURE_JOB.name) return DAGSTER_FIXTURE_JOB;
    return { name: jobName };
  }

  async subscribeRun(
    runId: string,
    handler: (event: DagsterEventRecord) => void
  ): Promise<DagsterRunSubscription> {
    this.subscribed.push(runId);
    this.handlers.set(runId, handler);
    for (const event of this.events) {
      handler(event);
    }
    handler({
      type:
        this.terminal.status === "success"
          ? "RUN_SUCCESS"
          : this.terminal.status === "canceled"
            ? "RUN_CANCELED"
            : "RUN_FAILURE",
    });
    return {
      unsubscribe: () => {
        this.handlers.delete(runId);
      },
    };
  }

  async terminateRun(runId: string, reason?: string): Promise<void> {
    this.terminated.push({ runId, reason });
  }

  async getRun(runId: string): Promise<DagsterRunRecord> {
    return { ...this.terminal, runId };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}
