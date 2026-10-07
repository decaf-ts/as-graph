/**
 * @module as-graph/tests/integration/dagster/DagsterGraphQLClient
 * @summary Real, read-only Dagster GraphQL client for the integration suite
 * (SAA-306).
 * @description A thin transport that implements the production `DagsterClient`
 * port against a real `dagster-webserver` GraphQL endpoint. It is the only piece
 * of the harness that talks to Dagster. It exposes **no authoring method**: it
 * never emits Python and never registers a job/op. It does implement the port's
 * gated execution surface (`launchRun` of an already-deployed job and
 * `replayRun` of an existing run via Dagster's `launchRunReexecution`), exactly as
 * a host would wire its own transport; the production driver only calls those when
 * its explicit `executionEnabled` gate is on.
 *
 * The client maps the raw GraphQL event vocabulary onto the driver's documented
 * `DagsterEventRecord` contract. Dagster emits far more step-scoped telemetry
 * (`STEP_WORKER_STARTING`, `RESOURCE_INIT_STARTED`, `LOADED_INPUT`, ...) than
 * the canonical event map the driver consumes; those non-graph-transition events
 * are engine telemetry and are intentionally not forwarded, matching the driver's
 * allowlist posture. Only the documented graph-transition event types
 * (`STEP_START`/`STEP_SUCCESS`/`STEP_FAILURE`/`STEP_SKIPPED`/`STEP_OUTPUT` and
 * the run-level terminal events) are surfaced.
 */
import type {
  DagsterClient,
  DagsterEventRecord,
  DagsterJobDependency,
  DagsterJobOp,
  DagsterJobRecord,
  DagsterJobSchedule,
  DagsterJobSensor,
  DagsterJobSummary,
  DagsterLaunchedRun,
  DagsterLaunchRunRequest,
  DagsterReplayRunRequest,
  DagsterRunRecord,
  DagsterRunSubscription,
  DagsterRunSubscriptionOptions,
} from "../../../src/dagster";
import { GraphExecutionError } from "../../../src/engine/errors";
import { DAGSTER_ERROR } from "../../../src/dagster/constants";

/**
 * The documented Dagster event types the read-only driver consumes. Raw Dagster
 * telemetry outside this set is filtered by the transport (see module docs).
 */
const DAGSTER_MAPPED_EVENT_TYPES = new Set<string>([
  "STEP_START",
  "STEP_SUCCESS",
  "STEP_FAILURE",
  "STEP_SKIPPED",
  "STEP_OUTPUT",
  "RUN_START",
  "RUN_SUCCESS",
  "RUN_FAILURE",
  "RUN_CANCELED",
]);

/** Default hard cap on the transport's pagination depth. */
const DEFAULT_MAX_PAGES = 100;

/** Default hard cap on the transport's replayed event count. */
const DEFAULT_MAX_EVENTS = 10000;

/** Options for constructing a {@link DagsterGraphQLClient}. */
export interface DagsterGraphQLClientOptions {
  /** Absolute GraphQL endpoint URL, e.g. `http://127.0.0.1:3300/graphql`. */
  url: string;
  /** Fetch implementation; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds. Defaults to `15000`. */
  requestTimeoutMs?: number;
  /** Repository (code location) selector name. Defaults to `__repository__`. */
  repositoryName?: string;
  /** Repository location name. Defaults to `definitions.py`. */
  repositoryLocationName?: string;
}

/** Minimal shape of a GraphQL error body. */
interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message: string }[];
}

/** A raw Dagster run event as returned by the GraphQL `eventConnection`. */
interface RawRunEvent {
  __typename: string;
  eventType?: string | null;
  timestamp?: string | null;
  message?: string | null;
  stepKey?: string | null;
  outputName?: string | null;
}

/** A raw `Run` record as returned by `runOrError`. */
interface RawRun {
  __typename: string;
  runId?: string;
  jobName?: string;
  status?: string;
  startTime?: number | null;
  endTime?: number | null;
  message?: string;
  eventConnection?: {
    cursor: string;
    hasMore: boolean;
    events: RawRunEvent[];
  };
}

/** A raw `Solid` (op) as returned by `Job.solids`. */
interface RawSolid {
  name: string;
  inputs: {
    definition: { name: string };
    dependsOn: { solid: { name: string }; definition: { name: string } }[];
  }[];
  outputs: { definition: { name: string } }[];
}

/** A raw `Job` as returned by `Repository.jobs`. */
interface RawJob {
  name: string;
  description?: string | null;
  solids: RawSolid[];
}

/** A raw `Schedule` as returned by `Repository.schedules`. */
interface RawSchedule {
  name: string;
  cronSchedule?: string | null;
  executionTimezone?: string | null;
  pipelineName?: string | null;
}

/** A raw `Sensor` as returned by `Repository.sensors`. */
interface RawSensor {
  name: string;
  sensorType?: string | null;
  targets: { pipelineName?: string | null }[];
}

/** A raw `AssetNode` as returned by `Repository.assetNodes`. */
interface RawAssetNode {
  assetKey: { path: string[] };
  jobNames: string[];
}

/** A raw `Repository` as returned by `repositoryOrError`. */
interface RawRepository {
  __typename: string;
  name?: string;
  jobs?: RawJob[];
  schedules?: RawSchedule[];
  sensors?: RawSensor[];
  assetNodes?: RawAssetNode[];
  message?: string;
}

const LIST_JOBS_QUERY = /* GraphQL */ `
  query AsGraphListJobs {
    repositoriesOrError {
      __typename
      ... on RepositoryConnection {
        nodes {
          name
          location {
            name
          }
          jobs {
            name
            description
          }
        }
      }
      ... on PythonError {
        message
      }
    }
  }
`;

const REPOSITORY_QUERY = /* GraphQL */ `
  query AsGraphRepository($repositoryName: String!, $repositoryLocationName: String!) {
    repositoryOrError(
      repositorySelector: {
        repositoryName: $repositoryName
        repositoryLocationName: $repositoryLocationName
      }
    ) {
      __typename
      ... on Repository {
        name
        jobs {
          name
          description
          solids {
            name
            inputs {
              definition {
                name
              }
              dependsOn {
                solid {
                  name
                }
                definition {
                  name
                }
              }
            }
            outputs {
              definition {
                name
              }
            }
          }
        }
        schedules {
          name
          cronSchedule
          executionTimezone
          pipelineName
        }
        sensors {
          name
          sensorType
          targets {
            pipelineName
          }
        }
        assetNodes {
          assetKey {
            path
          }
          jobNames
        }
      }
      ... on RepositoryNotFoundError {
        message
      }
      ... on PythonError {
        message
      }
    }
  }
`;

const RUN_QUERY = /* GraphQL */ `
  query AsGraphRun($runId: ID!) {
    runOrError(runId: $runId) {
      __typename
      ... on Run {
        runId
        jobName
        status
        startTime
        endTime
      }
      ... on RunNotFoundError {
        message
      }
      ... on PythonError {
        message
      }
    }
  }
`;

const RUN_EVENTS_QUERY = /* GraphQL */ `
  query AsGraphRunEvents($runId: ID!, $after: String) {
    runOrError(runId: $runId) {
      __typename
      ... on Run {
        runId
        status
        eventConnection(afterCursor: $after, limit: 1000) {
          cursor
          hasMore
          events {
            __typename
            ... on MessageEvent {
              eventType
              timestamp
              message
              stepKey
            }
            ... on ExecutionStepOutputEvent {
              outputName
            }
          }
        }
      }
      ... on RunNotFoundError {
        message
      }
      ... on PythonError {
        message
      }
    }
  }
`;

const RUNS_QUERY = /* GraphQL */ `
  query AsGraphRuns($pipelineName: String) {
    runsOrError(filter: { pipelineName: $pipelineName }, limit: 100) {
      __typename
      ... on Runs {
        results {
          runId
          jobName
          status
        }
      }
      ... on PythonError {
        message
      }
    }
  }
`;

const TERMINATE_RUN_MUTATION = /* GraphQL */ `
  mutation AsGraphTerminateRun($runId: String!) {
    terminateRun(runId: $runId) {
      __typename
      ... on TerminateRunSuccess {
        run {
          runId
        }
      }
      ... on TerminateRunFailure {
        message
      }
      ... on RunNotFoundError {
        message
      }
      ... on PythonError {
        message
      }
    }
  }
`;

/**
 * Launches a run of an already-deployed job. This is not authoring: the job must
 * already exist in the deployment; the mutation only selects it and launches a
 * run. The driver never emits Python.
 */
const LAUNCH_RUN_MUTATION = /* GraphQL */ `
  mutation AsGraphLaunchRun($executionParams: ExecutionParams!) {
    launchRun(executionParams: $executionParams) {
      __typename
      ... on LaunchRunSuccess {
        run {
          runId
          status
        }
      }
      ... on RunConfigValidationInvalid {
        errors {
          message
        }
      }
      ... on PipelineNotFoundError {
        message
      }
      ... on RunConflict {
        message
      }
      ... on UnauthorizedError {
        message
      }
      ... on PythonError {
        message
      }
    }
  }
`;

/**
 * Re-executes an existing run from its run id through Dagster's dedicated
 * re-execution mutation (`launchRunReexecution`). Dagster requires exactly one of
 * `executionParams` or `reexecutionParams`; selecting a parent run uses the
 * latter. The parent run must already exist; the driver never authors a job or
 * emits Python.
 */
const REEXECUTE_RUN_MUTATION = /* GraphQL */ `
  mutation AsGraphReexecuteRun($reexecutionParams: ReexecutionParams!) {
    launchRunReexecution(reexecutionParams: $reexecutionParams) {
      __typename
      ... on LaunchRunSuccess {
        run {
          runId
          status
        }
      }
      ... on RunConfigValidationInvalid {
        errors {
          message
        }
      }
      ... on PipelineNotFoundError {
        message
      }
      ... on RunConflict {
        message
      }
      ... on UnauthorizedError {
        message
      }
      ... on PythonError {
        message
      }
    }
  }
`;

/** The `run { runId status }` payload of a successful launch/re-execution. */
interface RawLaunchedRun {
  __typename: string;
  run?: { runId: string; status?: string | null };
  errors?: { message: string }[];
  message?: string;
}

/**
 * Real, read-only Dagster GraphQL client implementing the production
 * `DagsterClient` port. It never authors a workflow or launches a run.
 */
export class DagsterGraphQLClient implements DagsterClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly repositoryName: string;
  private readonly repositoryLocationName: string;

  /**
   * @param options - Endpoint URL, fetch implementation, timeout, and repository
   *   selector.
   */
  constructor(options: DagsterGraphQLClientOptions) {
    this.url = options.url;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15000;
    this.repositoryName = options.repositoryName ?? "__repository__";
    this.repositoryLocationName =
      options.repositoryLocationName ?? "definitions.py";
  }

  /**
   * Sends a GraphQL operation and unwraps the `data` envelope, failing loudly
   * on transport, HTTP, or GraphQL errors.
   *
   * @typeParam T - The expected `data` shape.
   * @param query - The GraphQL document.
   * @param variables - Optional operation variables.
   * @param signal - Optional caller signal composed with the request timeout.
   * @returns The response `data`.
   */
  private async request<T>(
    query: string,
    variables?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const effectiveSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: effectiveSignal,
    });
    if (!response.ok) {
      throw new Error(
        `Dagster GraphQL request failed with HTTP ${response.status}`
      );
    }
    const body = (await response.json()) as GraphQLResponse<T>;
    if (body.errors?.length) {
      throw new Error(
        `Dagster GraphQL errors: ${body.errors
          .map((error) => error.message)
          .join("; ")}`
      );
    }
    if (!body.data) {
      throw new Error("Dagster GraphQL response carried no data");
    }
    return body.data;
  }

  /**
   * Lists every already-deployed Dagster job across the served repositories.
   *
   * @returns The deployed job summaries.
   */
  async listJobs(): Promise<DagsterJobSummary[]> {
    const data = await this.request<{
      repositoriesOrError: {
        __typename: string;
        nodes?: {
          name: string;
          jobs: { name: string; description?: string | null }[];
        }[];
        message?: string;
      };
    }>(LIST_JOBS_QUERY);
    const connection = data.repositoriesOrError;
    if (connection.__typename !== "RepositoryConnection") {
      throw new Error(
        `Dagster repository listing failed: ${connection.message ?? connection.__typename}`
      );
    }
    const summaries: DagsterJobSummary[] = [];
    for (const repository of connection.nodes ?? []) {
      for (const job of repository.jobs) {
        summaries.push({
          name: job.name,
          ...(job.description ? { description: job.description } : {}),
        });
      }
    }
    return summaries;
  }

  /**
   * Reads a single already-deployed Dagster job, including its real graph
   * structure (ops, dependencies, asset keys, schedules, sensors).
   *
   * @param jobName - The Dagster job name.
   * @returns The inspected job record.
   */
  async getJob(jobName: string): Promise<DagsterJobRecord> {
    const data = await this.request<{
      repositoryOrError: RawRepository;
    }>(REPOSITORY_QUERY, {
      repositoryName: this.repositoryName,
      repositoryLocationName: this.repositoryLocationName,
    });
    const repository = data.repositoryOrError;
    if (repository.__typename !== "Repository") {
      throw new Error(
        `Dagster repository lookup failed: ${repository.message ?? repository.__typename}`
      );
    }
    const job = (repository.jobs ?? []).find(
      (candidate) => candidate.name === jobName
    );
    if (!job) {
      throw new Error(`Dagster job '${jobName}' was not found in the deployment`);
    }
    return this.toJobRecord(job, repository);
  }

  /**
   * Replays the recorded event stream of an EXISTING Dagster run and invokes the
   * handler for every documented graph-transition event. The client never launches
   * a run; it only reads a run that already exists.
   *
   * @param runId - The Dagster run id.
   * @param handler - The per-event callback.
   * @param options - Optional signal/event/page bounds.
   * @returns A subscription handle.
   * @throws {GraphExecutionError} `GRAPH_DAGSTER_OBSERVE_ABORTED` when the signal
   *   is already aborted before or during the event replay,
   *   `GRAPH_DAGSTER_PAGE_LIMIT_EXCEEDED` when the page cap is hit, or
   *   `GRAPH_DAGSTER_EVENT_LIMIT_EXCEEDED` when the event cap is hit.
   */
  async subscribeRun(
    runId: string,
    handler: (event: DagsterEventRecord) => void,
    options: DagsterRunSubscriptionOptions = {}
  ): Promise<DagsterRunSubscription> {
    let closed = false;
    const raw = await this.fetchRunEvents(runId, options);
    for (const event of raw) {
      if (closed || options.signal?.aborted) break;
      const record = this.toEventRecord(event);
      if (record) handler(record);
    }
    return {
      unsubscribe: () => {
        closed = true;
      },
    };
  }

  /**
   * Terminates an EXISTING Dagster run through the GraphQL mutation.
   *
   * @param runId - The Dagster run id.
   * @param reason - Optional termination reason (unused by Dagster).
   */
  async terminateRun(runId: string, reason?: string): Promise<void> {
    void reason;
    const data = await this.request<{
      terminateRun: { __typename: string; message?: string };
    }>(TERMINATE_RUN_MUTATION, { runId });
    const result = data.terminateRun;
    if (result.__typename !== "TerminateRunSuccess") {
      throw new Error(
        `Dagster run termination failed: ${result.message ?? result.__typename}`
      );
    }
  }

  /**
   * Launches a run of an ALREADY-DEPLOYED Dagster job through the real GraphQL
   * `launchRun` mutation. The job must already exist in the deployment; no job or
   * op is authored and no Python is emitted.
   *
   * @param request - The job name, optional raw run config, and optional tags.
   * @returns The launched run's id and initial status.
   */
  async launchRun(request: DagsterLaunchRunRequest): Promise<DagsterLaunchedRun> {
    const data = await this.request<{ launchRun: RawLaunchedRun }>(
      LAUNCH_RUN_MUTATION,
      {
        executionParams: this.executionParams(
          request.jobName,
          request.runConfig,
          request.tags
        ),
      }
    );
    return this.toLaunchedRun(data.launchRun, request.jobName);
  }

  /**
   * Re-executes an EXISTING Dagster run from its run id through the real GraphQL
   * `launchRunReexecution` mutation (Dagster's re-execution surface). The parent
   * run must already exist; no job or op is authored and no Python is emitted.
   *
   * @param request - The parent run id, its job name, and optional tags.
   * @returns The re-executed run's id and initial status.
   */
  async replayRun(
    request: DagsterReplayRunRequest
  ): Promise<DagsterLaunchedRun> {
    const reexecutionParams: Record<string, unknown> = {
      parentRunId: request.dagsterRunId,
      strategy: "ALL_STEPS",
    };
    if (request.tags && Object.keys(request.tags).length > 0) {
      reexecutionParams["extraTags"] = Object.entries(request.tags).map(
        ([key, value]) => ({ key, value })
      );
    }
    const data = await this.request<{ launchRunReexecution: RawLaunchedRun }>(
      REEXECUTE_RUN_MUTATION,
      { reexecutionParams }
    );
    return this.toLaunchedRun(
      data.launchRunReexecution,
      request.jobName ?? request.dagsterRunId
    );
  }

  /**
   * Builds the GraphQL `ExecutionParams` for a launch/re-execution: the job
   * selector, optional raw run config, and optional run tags.
   *
   * @param jobName - The already-deployed job name.
   * @param runConfig - Optional raw Dagster run config (forwarded verbatim).
   * @param tags - Optional run tags.
   * @returns The `ExecutionParams` input object.
   */
  private executionParams(
    jobName: string,
    runConfig?: Record<string, unknown>,
    tags?: Record<string, string>
  ): Record<string, unknown> {
    const executionMetadata: Record<string, unknown> = {};
    if (tags && Object.keys(tags).length > 0) {
      executionMetadata["tags"] = Object.entries(tags).map(([key, value]) => ({
        key,
        value,
      }));
    }
    return {
      selector: {
        pipelineName: jobName,
        repositoryName: this.repositoryName,
        repositoryLocationName: this.repositoryLocationName,
      },
      ...(runConfig ? { runConfigData: runConfig } : {}),
      ...(Object.keys(executionMetadata).length > 0
        ? { executionMetadata }
        : {}),
    };
  }

  /**
   * Unwraps a launch/re-execution result union into a run handle, failing loudly
   * on a launch error.
   *
   * @param result - The raw launch result union.
   * @param jobName - The job name, for error context.
   * @returns The launched run's id and initial status.
   */
  private toLaunchedRun(
    result: RawLaunchedRun,
    jobName: string
  ): DagsterLaunchedRun {
    if (result.__typename !== "LaunchRunSuccess" || !result.run) {
      const detail =
        result.errors?.map((error) => error.message).join("; ") ??
        result.message ??
        result.__typename;
      throw new Error(`Dagster launch of job '${jobName}' failed: ${detail}`);
    }
    return {
      runId: result.run.runId,
      status: this.toRunStatus(result.run.status),
    };
  }

  /**
   * Reads an EXISTING Dagster run's terminal record.
   *
   * @param runId - The Dagster run id.
   * @returns The terminal run record.
   */
  async getRun(runId: string): Promise<DagsterRunRecord> {
    const data = await this.request<{ runOrError: RawRun }>(RUN_QUERY, {
      runId,
    });
    return this.toRunRecord(data.runOrError);
  }

  /**
   * Harness-only helper: lists the runs for a job (or every run when no job name
   * is given) with their raw Dagster status. Not part of the `DagsterClient` port;
   * it exists so the suite can discover a pre-existing terminal run (e.g. the
   * `etl_pipeline` run materialized at startup) without launching one, and can
   * count runs before/after an operation to prove no run was created.
   *
   * @param jobName - Optional Dagster job name filter.
   * @returns The runs, with raw Dagster run status.
   */
  async listRuns(
    jobName?: string
  ): Promise<{ runId: string; jobName: string; status: string }[]> {
    const data = await this.request<{
      runsOrError: {
        __typename: string;
        results?: { runId: string; jobName: string; status: string }[];
        message?: string;
      };
    }>(RUNS_QUERY, jobName ? { pipelineName: jobName } : {});
    const runs = data.runsOrError;
    if (runs.__typename !== "Runs") {
      throw new Error(
        `Dagster run listing failed: ${runs.message ?? runs.__typename}`
      );
    }
    return (runs.results ?? []).map((run) => ({
      runId: run.runId,
      jobName: run.jobName,
      status: run.status,
    }));
  }

  /**
   * Harness-only helper: lists the ids of runs for a job (or every run when no
   * job name is given). Not part of the `DagsterClient` port; it exists so the
   * suite can discover a pre-existing run without launching one.
   *
   * @param jobName - Optional Dagster job name filter.
   * @returns The run ids.
   */
  async listRunIds(jobName?: string): Promise<string[]> {
    const runs = await this.listRuns(jobName);
    return runs.map((run) => run.runId);
  }

  /** Disposes the client; the fetch transport holds no resources. */
  dispose(): void {
    return;
  }

  /**
   * Paginates the run's recorded event stream, bounded by `maxPages` and
   * `maxEvents` so a gateway whose `eventConnection` never reports
   * `hasMore: false` cannot page or buffer without limit.
   *
   * @param runId - The Dagster run id.
   * @param options - Optional signal/event/page bounds.
   * @returns The raw events, in order.
   * @throws {GraphExecutionError} `GRAPH_DAGSTER_PAGE_LIMIT_EXCEEDED` when the
   *   page cap is hit, or `GRAPH_DAGSTER_EVENT_LIMIT_EXCEEDED` when the event cap
   *   is hit.
   */
  private async fetchRunEvents(
    runId: string,
    options: DagsterRunSubscriptionOptions = {}
  ): Promise<RawRunEvent[]> {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    const events: RawRunEvent[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      if (options.signal?.aborted) {
        throw new GraphExecutionError(
          `Dagster run '${runId}' event replay was aborted by the caller`,
          DAGSTER_ERROR.OBSERVE_ABORTED,
          { runId }
        );
      }
      if (pages >= maxPages) {
        throw new GraphExecutionError(
          `Dagster run '${runId}' event replay exceeded the ${maxPages}-page cap`,
          DAGSTER_ERROR.PAGE_LIMIT_EXCEEDED,
          { runId, maxPages }
        );
      }
      const data = await this.request<{ runOrError: RawRun }>(
        RUN_EVENTS_QUERY,
        after ? { runId, after } : { runId },
        options.signal
      );
      pages += 1;
      const run = data.runOrError;
      if (run.__typename !== "Run") {
        throw new Error(
          `Dagster run event lookup failed: ${run.message ?? run.__typename}`
        );
      }
      const connection = run.eventConnection;
      if (!connection) break;
      events.push(...connection.events);
      if (events.length > maxEvents) {
        throw new GraphExecutionError(
          `Dagster run '${runId}' event replay exceeded the ${maxEvents}-event cap`,
          DAGSTER_ERROR.EVENT_LIMIT_EXCEEDED,
          { runId, maxEvents }
        );
      }
      if (!connection.hasMore) break;
      after = connection.cursor;
    }
    return events;
  }

  /**
   * Maps a raw Dagster event onto the driver's documented `DagsterEventRecord`
   * contract, filtering out non-graph-transition telemetry.
   *
   * @param event - The raw event.
   * @returns The driver event record, or `undefined` when the event is engine
   *   telemetry the read-only driver does not consume.
   */
  private toEventRecord(event: RawRunEvent): DagsterEventRecord | undefined {
    const type = event.eventType;
    if (!type || !DAGSTER_MAPPED_EVENT_TYPES.has(type)) return undefined;
    const record: DagsterEventRecord = { type };
    if (event.stepKey) record.stepKey = event.stepKey;
    if (event.timestamp) {
      record.timestamp = new Date(Number(event.timestamp)).toISOString();
    }
    if (event.message) record.message = event.message;
    if (type === "STEP_OUTPUT" && event.outputName) {
      record.payload = { outputs: { [event.outputName]: event.outputName } };
    }
    return record;
  }

  /**
   * Maps a raw `Run` onto the driver's `DagsterRunRecord` contract.
   *
   * @param run - The raw run.
   * @returns The driver run record.
   */
  private toRunRecord(run: RawRun): DagsterRunRecord {
    if (run.__typename !== "Run") {
      throw new Error(
        `Dagster run lookup failed: ${run.message ?? run.__typename}`
      );
    }
    const record: DagsterRunRecord = {
      runId: run.runId ?? "",
      status: this.toRunStatus(run.status),
      outputs: {},
      ...(run.jobName ? { jobName: run.jobName } : {}),
    };
    if (run.startTime) {
      record.startedAt = new Date(run.startTime * 1000).toISOString();
    }
    if (run.endTime) {
      record.finishedAt = new Date(run.endTime * 1000).toISOString();
    }
    return record;
  }

  /**
   * Maps a Dagster `RunStatus` onto the driver's terminal run status.
   *
   * @param status - The raw Dagster run status.
   * @returns The driver run status.
   */
  private toRunStatus(
    status?: string
  ): DagsterRunRecord["status"] {
    switch (status) {
      case "SUCCESS":
        return "success";
      case "FAILURE":
        return "failure";
      case "CANCELED":
        return "canceled";
      case "QUEUED":
        return "QUEUED";
      case "STARTING":
        return "STARTING";
      default:
        return "started";
    }
  }

  /**
   * Maps a raw job plus its repository context onto the driver's
   * `DagsterJobRecord` contract.
   *
   * @param job - The raw job.
   * @param repository - The raw repository the job belongs to.
   * @returns The inspected job record.
   */
  private toJobRecord(
    job: RawJob,
    repository: RawRepository
  ): DagsterJobRecord {
    const assetKeys = this.assetKeysFor(job.name, repository.assetNodes ?? []);
    const ops: DagsterJobOp[] = job.solids.map((solid) => {
      const op: DagsterJobOp = {
        name: solid.name,
        inputs: solid.inputs.map((input) => input.definition.name),
        outputs: solid.outputs.map((output) => output.definition.name),
      };
      const keys = assetKeys.filter(
        (key) => key.split(".").pop() === solid.name
      );
      if (keys.length) op.assetKeys = keys;
      return op;
    });
    const dependencies: DagsterJobDependency[] = [];
    for (const solid of job.solids) {
      for (const input of solid.inputs) {
        for (const upstream of input.dependsOn) {
          dependencies.push({
            from: upstream.solid.name,
            to: solid.name,
          });
        }
      }
    }
    const schedules: DagsterJobSchedule[] = (
      repository.schedules ?? []
    )
      .filter((schedule) => schedule.pipelineName === job.name)
      .map((schedule) => ({
        name: schedule.name,
        ...(schedule.cronSchedule ? { cron: schedule.cronSchedule } : {}),
        ...(schedule.executionTimezone
          ? { timezone: schedule.executionTimezone }
          : {}),
      }));
    const sensors: DagsterJobSensor[] = (repository.sensors ?? [])
      .filter((sensor) =>
        sensor.targets.some((target) => target.pipelineName === job.name)
      )
      .map((sensor) => ({
        name: sensor.name,
        ...(sensor.sensorType ? { kind: sensor.sensorType } : {}),
      }));
    return {
      name: job.name,
      ...(job.description ? { description: job.description } : {}),
      ops,
      dependencies,
      ...(assetKeys.length ? { assetKeys } : {}),
      ...(schedules.length ? { schedules } : {}),
      ...(sensors.length ? { sensors } : {}),
    };
  }

  /**
   * Resolves the asset keys a job produces from the repository's asset nodes.
   *
   * @param jobName - The Dagster job name.
   * @param assetNodes - The repository asset nodes.
   * @returns The dotted asset keys.
   */
  private assetKeysFor(
    jobName: string,
    assetNodes: RawAssetNode[]
  ): string[] {
    const keys: string[] = [];
    for (const node of assetNodes) {
      if (!node.jobNames.includes(jobName)) continue;
      keys.push(node.assetKey.path.join("."));
    }
    return keys;
  }
}
