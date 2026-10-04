/**
 * @module as-graph/tests/unit/graph/dagster/fixtures
 * @summary Test fixtures for the Dagster backend driver tests (SAA-195).
 */
import type {
  DagsterClient,
  DagsterEventRecord,
  DagsterJobRecord,
  DagsterJobSummary,
  DagsterLaunchRequest,
  DagsterRunHandle,
  DagsterRunRecord,
  DagsterRunSubscription,
} from "../../../../src/dagster/DagsterTypes";

/**
 * A scripted, in-memory Dagster client port. Records launches/terminations and
 * replays a preset event sequence on subscription.
 */
export class FakeDagsterClient implements DagsterClient {
  readonly launched: DagsterLaunchRequest[] = [];
  readonly terminated: { runId: string; reason?: string }[] = [];
  disposed = false;
  listJobs?: () => Promise<DagsterJobSummary[]>;
  getJob?: (jobName: string) => Promise<DagsterJobRecord>;

  private readonly handlers = new Map<
    string,
    (event: DagsterEventRecord) => void
  >();
  private readonly records = new Map<string, DagsterRunRecord>();

  constructor(
    private readonly events: DagsterEventRecord[] = [],
    private readonly terminal: DagsterRunRecord = {
      runId: "run-1",
      status: "success",
      outputs: {},
    },
    jobs?: DagsterJobSummary[]
  ) {
    if (jobs) {
      this.listJobs = async () => jobs;
      this.getJob = async (jobName: string) => ({ name: jobName });
    }
  }

  async launchRun(
    request: DagsterLaunchRequest
  ): Promise<DagsterRunHandle> {
    this.launched.push(request);
    return { runId: `run-${this.launched.length}`, jobName: request.jobName };
  }

  async subscribeRun(
    runId: string,
    handler: (event: DagsterEventRecord) => void
  ): Promise<DagsterRunSubscription> {
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
