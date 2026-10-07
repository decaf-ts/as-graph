/**
 * @module as-graph/tests/unit/graph/dagster/fixtures
 * @summary Test fixtures for the Dagster driver tests.
 * @description A scripted, in-memory gateway port that stands in for a real
 * Dagster deployment. By default it only exposes the read-only surface (listing,
 * lookup, run records, run events, termination) — no launch method — mirroring the
 * owner mandate. A test may opt into the gated execution surface by supplying a
 * {@link FakeDagsterExecutionScript}: the port then exposes a scripted
 * `launchRun`/`replayRun` and reports a launched/replayed run as `started` for a
 * configurable number of `getRun` polls before its terminal record.
 */
import type {
  DagsterClient,
  DagsterEventRecord,
  DagsterJobRecord,
  DagsterJobSummary,
  DagsterLaunchedRun,
  DagsterLaunchRunRequest,
  DagsterReplayRunRequest,
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
 * Opt-in script for the fake gateway's gated execution surface. When omitted the
 * fake exposes neither `launchRun` nor `replayRun`, exactly matching the
 * read-only port the owner mandate requires.
 */
export interface FakeDagsterExecutionScript {
  /**
   * When set, the fake exposes `launchRun` and returns this Dagster run id for a
   * launched run.
   */
  launchRunId?: string;
  /**
   * When set, the fake exposes `replayRun` and returns this Dagster run id for a
   * re-executed run.
   */
  replayRunId?: string;
  /** When set, the exposed `launchRun` rejects with this error. */
  launchError?: Error;
  /** When set, the exposed `replayRun` rejects with this error. */
  replayError?: Error;
  /**
   * Number of `getRun` polls a launched/replayed run reports as `started` before
   * its terminal record is returned. Defaults to `0` so the read-only surface is
   * unchanged; execute/replay tests set `1` to prove the terminal wait polls.
   */
  startedPolls?: number;
  /**
   * Raw Dagster run status `getRun` reports during the pending polls before the
   * terminal record. Defaults to `"started"`. Set to a raw non-terminal Dagster
   * status (e.g. `"QUEUED"`) to model a real gateway whose status vocabulary is
   * wider than the canonical `DagsterRunRecord.status` union.
   */
  pendingStatus?: string;
  /**
   * Maps a Dagster run id to the name of the deployed job that owns it. When a
   * run id is present, `getRun` surfaces its owner as both `jobName` and
   * `pipelineName` so a driver can bind a run to the workflow it belongs to.
   */
  runJobNames?: Record<string, string>;
}

/**
 * A scripted, in-memory Dagster gateway port. Records terminations, launch/replay
 * calls, and replays a preset event sequence on subscription. Listing/lookup are
 * required. `launchRun`/`replayRun` exist only when the test supplies a
 * {@link FakeDagsterExecutionScript}, so the default surface stays read-only.
 */
export class FakeDagsterClient implements DagsterClient {
  readonly terminated: { runId: string; reason?: string }[] = [];
  readonly subscribed: string[] = [];
  /** Every `launchRun` request the driver issued, in order. */
  readonly launched: DagsterLaunchRunRequest[] = [];
  /** Every `replayRun` request the driver issued, in order. */
  readonly replayed: DagsterReplayRunRequest[] = [];
  disposed = false;

  /** Scripted launch, present only when the test opted into it. */
  launchRun?: (
    request: DagsterLaunchRunRequest
  ) => Promise<DagsterLaunchedRun>;
  /** Scripted replay, present only when the test opted into it. */
  replayRun?: (
    request: DagsterReplayRunRequest
  ) => Promise<DagsterLaunchedRun>;

  private readonly handlers = new Map<
    string,
    (event: DagsterEventRecord) => void
  >();
  private readonly records = new Map<string, DagsterRunRecord>();
  private readonly startedPolls: number;
  private readonly pendingStatus: string;
  private readonly runJobNames: Record<string, string>;
  private readonly polls = new Map<string, number>();

  /**
   * @param events - Events replayed on every subscription.
   * @param terminal - The terminal record returned by `getRun`.
   * @param jobs - Job summaries returned by `listJobs`.
   * @param jobRecords - Full job records returned by `getJob`, keyed by name.
   * @param script - Optional opt-in for the gated launch/replay surface.
   */
  constructor(
    private readonly events: DagsterEventRecord[] = [],
    private readonly terminal: DagsterRunRecord = {
      runId: "run-1",
      status: "success",
      outputs: {},
    },
    private readonly jobs: DagsterJobSummary[] = [],
    private readonly jobRecords: Record<string, DagsterJobRecord> = {},
    script: FakeDagsterExecutionScript = {}
  ) {
    this.startedPolls = script.startedPolls ?? 0;
    this.pendingStatus = script.pendingStatus ?? "started";
    this.runJobNames = script.runJobNames ?? {};
    if (script.launchRunId !== undefined || script.launchError !== undefined) {
      this.launchRun = async (request) => {
        this.launched.push(request);
        if (script.launchError) throw script.launchError;
        return {
          runId: script.launchRunId ?? "launched-run",
          status: "started",
        };
      };
    }
    if (script.replayRunId !== undefined || script.replayError !== undefined) {
      this.replayRun = async (request) => {
        this.replayed.push(request);
        if (script.replayError) throw script.replayError;
        return {
          runId: script.replayRunId ?? "replayed-run",
          status: "started",
        };
      };
    }
  }

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
    const ownership = this.runOwnership(runId);
    const polls = this.polls.get(runId) ?? 0;
    if (polls < this.startedPolls) {
      this.polls.set(runId, polls + 1);
      return {
        runId,
        status: this.pendingStatus as DagsterRunRecord["status"],
        outputs: {},
        ...ownership,
      } as DagsterRunRecord;
    }
    return { ...this.terminal, runId, ...ownership } as DagsterRunRecord;
  }

  /**
   * The owning-job fields `getRun` attaches when the run id is known to belong to
   * a deployed job. The canonical `DagsterRunRecord` union does not carry run
   * ownership, so the fake surfaces it as the extra `jobName`/`pipelineName`
   * fields a real Dagster run record exposes.
   */
  private runOwnership(runId: string): Record<string, string> {
    const jobName = this.runJobNames[runId];
    return jobName ? { jobName, pipelineName: jobName } : {};
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}
