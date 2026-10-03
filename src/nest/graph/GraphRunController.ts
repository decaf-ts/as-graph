/**
 * @module as-graph/nest/graph/GraphRunController
 * @summary Asynchronous run lifecycle HTTP API (DECAF-50 §4.14–§4.15).
 * @description Creates (`POST /graph/runs`), reads
 * (`GET /graph/runs/:runId`), cancels (`DELETE /graph/runs/:runId`), and
 * replays (`SSE /graph/runs/:runId/events`) graph runs on top of
 * {@link GraphRunService}, enforcing authentication, run limits, and
 * ownership; engine errors surface as `500` with their message while Nest
 * {@link HttpException}s pass through unchanged.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Sse,
  MessageEvent,
  Inject,
  HttpCode,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { NotFoundError, ValidationError } from "@decaf-ts/db-decorators";
import { AuthorizationError, ForbiddenError } from "@decaf-ts/core";
import type { GraphWorkflowDocument } from "../../shared/graph";
import { DecafRequestContext } from "@decaf-ts/for-nest";
import type {
  GraphRunEventEnvelope,
  GraphRunLimits,
  GraphRunModel,
} from "../../shared/graph";
import { isGraphRunTerminalEventType } from "../../shared/graph";
import type {
  GraphExecutionValues,
  GraphRun,
  GraphRunCreateRequest,
} from "../../";
import { GraphRunService } from "../../";
import {
  GraphWorkflowService,
  graphWorkflowOwnerOf,
} from "../../engine/services/GraphWorkflowService";
import { canAccessGraphResourcePayload } from "../../engine/runs/ownership";
import { toIsoDateString } from "./servingDates";

/** DI token for {@link GraphRunControllerOptions}. */
export const GRAPH_RUN_OPTIONS = "GRAPH_RUN_OPTIONS";

/** Options for the run lifecycle HTTP API (DECAF-50 §4.14–§4.15): authentication mode and run limits. */
export interface GraphRunControllerOptions {
  /**
   * Whether an authenticated request context is required (default
   * `"required"`, SAA-595 secure-defaults alignment). `"required"` rejects a
   * request with no request context **and** a request whose context carries no
   * resolved owner user with `401` (SAA-93 F2): in a host that installs the
   * request-context machinery a context exists for every request, so gating on
   * context existence alone would admit unauthenticated callers as anonymous.
   * `"optional"` admits anonymous requests for standalone module runs
   * (DECAF-48 §4.15) — pair it with an explicit `allowAnonymousAccess`
   * decision on the run service options.
   */
  auth?: "required" | "optional";
  /** Run limits forwarded to {@link GraphRunService}. */
  limits?: GraphRunLimits;
}

/** Response of `POST /graph/runs`: the queued run's identity and its event/result URLs. */
export interface GraphRunCreatedResponse {
  runId: string;
  workflowId: string;
  status: "queued";
  eventsUrl: string;
  resultUrl: string;
}

/** Request body for creating a run: an inline workflow document or a saved `workflowId`, plus optional inputs. */
export interface GraphRunRequestBody {
  workflow?: GraphWorkflowDocument;
  workflowId?: string;
  inputs?: GraphExecutionValues;
}

/**
 * Maps a thrown Decaf error to the Nest HTTP equivalent for the run
 * lifecycle API: ownership/authorization failures become `403` (naming the
 * run), missing runs `404`, validation failures `400`, and anything else
 * surfaces as `500` with its message. Nest {@link HttpException}s pass
 * through unchanged.
 */
function graphRunHttpErrorOf(e: unknown, runId?: string): HttpException {
  if (e instanceof ForbiddenError || e instanceof AuthorizationError) {
    return new HttpException(
      runId
        ? `Graph run '${runId}' is owned by another user`
        : e.message,
      HttpStatus.FORBIDDEN
    );
  }
  if (e instanceof NotFoundError) {
    return new NotFoundException(e.message);
  }
  if (e instanceof ValidationError) {
    return new HttpException(e.message, HttpStatus.BAD_REQUEST);
  }
  if (e instanceof HttpException) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
}

/**
 * Projects an engine-side {@link GraphRun} to its HTTP JSON shape via a
 * JSON round-trip (strips `undefined` members and engine-only references).
 *
 * SAA-93 F1: the same payload projection the list path applies is applied
 * here too, so a caller cannot bypass the summary-only list projection by
 * listing the run id and then reading the run directly. The run's `result`/`error`
 * payload is served only when {@link canAccessGraphResourcePayload} confirms
 * the caller owns the run; an owner-less run read by a named caller returns
 * the summary-only record.
 *
 * @param {GraphRun} run - The engine-side run to serve.
 * @param {string | null} callerOwner - The requesting caller's resolved owner, or `null` when anonymous.
 * @return {Record<string, unknown>} The run's plain JSON-safe HTTP shape.
 */
function graphRunToHttp(
  run: GraphRun,
  callerOwner: string | null
): Record<string, unknown> {
  const projected = JSON.parse(JSON.stringify(run)) as Record<string, unknown>;
  if (!canAccessGraphResourcePayload({ owner: run.ownerUser }, callerOwner)) {
    delete projected.result;
    delete projected.error;
  }
  return projected;
}

/**
 * Projects a persisted {@link GraphRunModel} row to its HTTP serving shape
 * (SAA-76): carries the storage-derived members the engine {@link GraphRun}
 * does not have (`owner`, `inputs`), omits unset optional members, and
 * formats every date through {@link toIsoDateString} so served dates are
 * true ISO-8601 strings.
 *
 * SAA-93 F1: the sensitive payload members (`inputs`/`result`/`error`) are
 * projected out unless {@link canAccessGraphResourcePayload} confirms the
 * caller owns the row. A named caller may still *see* an owner-less row (the
 * documented owner-less visibility contract), but only an owner-less caller —
 * the anonymous/standalone identity that created it — receives its payload.
 * Rows whose required date members cannot be projected are skipped per row so a
 * single corrupt row never 500s the whole collection (SAA-93 F4).
 *
 * @param {GraphRunModel} model - The persisted run row to serve.
 * @param {string | null} callerOwner - The requesting caller's resolved owner, or `null` when anonymous.
 * @return {Record<string, unknown> | undefined} The run row's plain JSON-safe HTTP shape, or `undefined` when a required date is unprojectable.
 */
function graphRunModelToHttp(
  model: GraphRunModel,
  callerOwner: string | null
): Record<string, unknown> | undefined {
  const createdAt = toIsoDateString(model.createdAt);
  const updatedAt = toIsoDateString(model.updatedAt);
  if (createdAt === undefined || updatedAt === undefined) return undefined;
  const includePayload = canAccessGraphResourcePayload(
    { owner: model.owner },
    callerOwner
  );
  return {
    runId: model.runId,
    workflowId: model.workflowId,
    ...(model.owner !== undefined ? { owner: model.owner } : {}),
    status: model.status,
    ...(model.documentFingerprint !== undefined
      ? { documentFingerprint: model.documentFingerprint }
      : {}),
    ...(includePayload && model.inputs !== undefined
      ? { inputs: model.inputs }
      : {}),
    ...(includePayload && model.result !== undefined
      ? { result: model.result }
      : {}),
    ...(includePayload && model.error !== undefined
      ? { error: model.error }
      : {}),
    createdAt,
    updatedAt,
    ...(model.startedAt !== undefined
      ? { startedAt: toIsoDateString(model.startedAt) }
      : {}),
    ...(model.finishedAt !== undefined
      ? { finishedAt: toIsoDateString(model.finishedAt) }
      : {}),
  };
}

/**
 * Wraps a run event envelope as a Nest SSE {@link MessageEvent} whose `data`
 * is the JSON-serialized envelope.
 *
 * SAA-93 F1: when `includePayload` is `false` the sensitive `payload`/`error`
 * members are projected out before streaming, so the event stream cannot be used
 * to read an owner-less run's execution payloads that the list and single-read
 * projections already strip.
 *
 * @param {GraphRunEventEnvelope} event - The sequenced envelope to stream.
 * @param {boolean} includePayload - Whether the caller owns the run and may see its payload.
 * @return {MessageEvent} The SSE message to emit.
 */
function graphRunEventMessage(
  event: GraphRunEventEnvelope,
  includePayload: boolean
): MessageEvent {
  if (includePayload) {
    return {
      type: "message",
      data: JSON.stringify(event),
    };
  }
  const projected = { ...event };
  delete projected.payload;
  delete projected.error;
  return {
    type: "message",
    data: JSON.stringify(projected),
  };
}

/**
 * Asynchronous run lifecycle HTTP API (DECAF-50 §4.14–§4.15):
 * `POST /graph/runs` creates and schedules a run (202 Accepted), run
 * read/cancel endpoints expose lifecycle state, and
 * `GET /graph/runs/:runId/events` streams the run's sequenced event
 * envelopes over SSE until a terminal event closes the stream. Every
 * operation is ownership-checked against the requesting user.
 */
@Controller("graph")
export class GraphRunController {
  constructor(
    private readonly runService: GraphRunService,
    private readonly workflowService: GraphWorkflowService,
    @Optional() @Inject(DecafRequestContext)
    private readonly requestContext?: DecafRequestContext,
    @Optional() @Inject(GRAPH_RUN_OPTIONS)
    private readonly options: GraphRunControllerOptions = {}
  ) {}

  /**
   * Enforces the configured authentication mode: `auth` defaults to
   * `"required"` (SAA-595 secure-defaults alignment) and rejects a request
   * with no request context, or with a context that carries no resolved owner
   * user, with `401` (SAA-93 F2); `"optional"` admits anonymous requests
   * for standalone module runs (DECAF-48 §4.15).
   */
  private requireAuthenticatedContext(): DecafRequestContext | undefined {
    if ((this.options.auth ?? "required") !== "required") {
      return this.requestContext;
    }
    if (!this.requestContext) {
      throw new HttpException(
        "Graph run access requires an authenticated request context",
        HttpStatus.UNAUTHORIZED
      );
    }
    if (graphWorkflowOwnerOf(this.requestContext) === undefined) {
      throw new HttpException(
        "Graph run access requires an authenticated user",
        HttpStatus.UNAUTHORIZED
      );
    }
    return this.requestContext;
  }

  /**
   * Resolves the requesting caller's identity from the injected request
   * context via {@link graphWorkflowOwnerOf}; `null` for anonymous callers.
   *
   * @return {string | null} The authenticated owner user, or `null` when absent.
   */
  private ownerUserOf(): string | null {
    return graphWorkflowOwnerOf(this.requestContext) ?? null;
  }

  /**
   * Concurrency-bucket key for the per-caller run cap: the authenticated
   * owner, else a single shared anonymous bucket. The key deliberately does
   * NOT use `request.ip` (SAA-1950 F7): a spoofable proxy IP would let a
   * caller escape their bucket, and the shared bucket fails closed for the
   * anonymous tolerance, which is disabled by default. Request-rate
   * throttling is owned by the `@nestjs/throttler` guard instead.
   */
  private concurrencyKeyOf(owner: string | null): string {
    return owner ?? "anonymous";
  }

  /**
   * Creates and schedules a run (DECAF-50 §4.14): accepts an inline workflow
   * document or a saved `workflowId` plus optional inputs, answers
   * `202 Accepted` with the queued run's identity and its event/result URLs.
   * The per-caller concurrency cap buckets by the authenticated owner user,
   * else a single shared anonymous bucket (SAA-595 F4, SAA-1950 F7).
   */
  @Post("runs")
  @HttpCode(HttpStatus.ACCEPTED)
  async createRun(
    @Body() body: GraphRunRequestBody
  ): Promise<GraphRunCreatedResponse> {
    const context = this.requireAuthenticatedContext();
    const request: GraphRunCreateRequest = {
      ...(body?.workflow !== undefined ? { workflow: body.workflow } : {}),
      ...(body?.workflowId !== undefined
        ? { workflowId: body.workflowId }
        : {}),
      ...(body?.inputs !== undefined ? { inputs: body.inputs } : {}),
    };
    try {
      const owner = this.ownerUserOf();
      const run = await this.runService.createRun(
        request,
        owner,
        this.concurrencyKeyOf(owner),
        context
      );
      return {
        runId: run.runId,
        workflowId: run.workflowId,
        status: "queued",
        eventsUrl: `/graph/runs/${run.runId}/events`,
        resultUrl: `/graph/runs/${run.runId}`,
      };
    } catch (e: unknown) {
      throw graphRunHttpErrorOf(e);
    }
  }

  /**
   * Lists a workflow's past runs, newest first (DECAF-50 §4.14).
   *
   * The workflow itself is access-checked first (unknown → `404`, foreign
   * owner → `403`), then the persisted `GraphRunModel` rows for that workflow
   * are ownership-filtered and returned as their JSON rows. Each row carries
   * `runId`, `workflowId`, `owner`, `status`, `documentFingerprint`,
   * `inputs`, `result`, `error`, `createdAt`, `updatedAt`, `startedAt` and
   * `finishedAt` (dates as ISO strings; optional members are omitted when
   * unset). The `inputs`/`result`/`error` payload members are served only
   * for rows the caller owns (SAA-93 F1): a caller that may see an
   * owner-less row by the documented owner-less visibility contract but does
   * not own it receives the summary-only projection. Rows whose required
   * dates cannot be projected are skipped per row (SAA-93 F4). Auth follows
   * the controller's configured `auth` mode.
   *
   * @param {string} workflowId - Workflow id path parameter.
   * @return {Promise<Array<Record<string, unknown>>>} The workflow's runs, newest first.
   * @throws {HttpException} The mapped graph-run HTTP error (404 for unknown workflows/runs, 403 for foreign owners, 401 without an authenticated caller).
   */
  @Get("workflows/:workflowId/runs")
  async listRuns(
    @Param("workflowId") workflowId: string
  ): Promise<Record<string, unknown>[]> {
    const context = this.requireAuthenticatedContext();
    const callerOwner = this.ownerUserOf();
    try {
      await this.workflowService.assertAccess(workflowId, context);
      const models = await this.runService.listRunsByWorkflow(
        workflowId,
        callerOwner,
        context
      );
      const rows: Record<string, unknown>[] = [];
      for (const model of models) {
        const row = graphRunModelToHttp(model, callerOwner);
        if (row !== undefined) rows.push(row);
      }
      return rows;
    } catch (e: unknown) {
      throw graphRunHttpErrorOf(e);
    }
  }

  /**
   * Reads a run and maps it to its HTTP representation.
   *
   * The run's `result`/`error` payload is projected out for a caller that
   * does not own the run (SAA-93 F1): the summary-only projection the list
   * path applies cannot be bypassed by reading the run by id.
   *
   * @param {string} runId - Run id path parameter.
   * @return {Promise<Record<string, unknown>>} The run's HTTP shape.
   * @throws {HttpException} The mapped graph-run HTTP error (404 for unknown runs, 403 for foreign owners).
   */
  @Get("runs/:runId")
  async getRun(@Param("runId") runId: string): Promise<Record<string, unknown>> {
    const context = this.requireAuthenticatedContext();
    const callerOwner = this.ownerUserOf();
    try {
      const run = await this.runService.getRun(runId, callerOwner, context);
      return graphRunToHttp(run, callerOwner);
    } catch (e: unknown) {
      throw graphRunHttpErrorOf(e, runId);
    }
  }

  /**
   * Cancels a run (cooperative cancellation) and returns its updated state.
   *
   * @param {string} runId - Run id path parameter.
   * @return {Promise<Record<string, unknown>>} The cancelled run's HTTP shape.
   * @throws {HttpException} The mapped graph-run HTTP error (404 for unknown runs, 403 for foreign owners).
   */
  @Delete("runs/:runId")
  async cancelRun(
    @Param("runId") runId: string
  ): Promise<Record<string, unknown>> {
    const context = this.requireAuthenticatedContext();
    const callerOwner = this.ownerUserOf();
    try {
      const run = await this.runService.cancelRun(
        runId,
        callerOwner,
        context
      );
      return graphRunToHttp(run, callerOwner);
    } catch (e: unknown) {
      throw graphRunHttpErrorOf(e, runId);
    }
  }

  /**
   * SSE stream of a run's event envelopes: replays buffered events after
   * `afterSequence`, then streams live events until the terminal event type
   * completes the stream.
   *
   * SAA-93 F1: a caller that may see an owner-less run by the documented
   * owner-less visibility contract but does not own it receives envelopes with
   * the `payload`/`error` members projected out, matching the list and
   * single-read projections.
   *
   * @param {string} runId - Run id path parameter.
   * @param {string} [afterSequence] - Sequence number to replay events after.
   * @return {Promise<Observable<MessageEvent>>} The SSE event stream.
   * @throws {HttpException} The mapped graph-run HTTP error (404 for unknown runs, 403 for foreign owners).
   */
  @Sse("runs/:runId/events")
  async events(
    @Param("runId") runId: string,
    @Query("afterSequence") afterSequence?: string
  ): Promise<Observable<MessageEvent>> {
    const context = this.requireAuthenticatedContext();
    const owner = this.ownerUserOf();
    const after = this.parseAfterSequence(afterSequence);

    let run: GraphRun;
    try {
      run = await this.runService.getRun(runId, owner, context);
    } catch (e: unknown) {
      throw graphRunHttpErrorOf(e, runId);
    }
    const includePayload = canAccessGraphResourcePayload(
      { owner: run.ownerUser },
      owner
    );

    const buffered: GraphRunEventEnvelope[] = [];
    let streaming = false;
    let completed = false;
    let sink: {
      next: (message: MessageEvent) => void;
      complete: () => void;
    } | undefined;

    const emit = (event: GraphRunEventEnvelope): void => {
      if (completed || !sink) return;
      sink.next(graphRunEventMessage(event, includePayload));
      if (isGraphRunTerminalEventType(event.type)) {
        completed = true;
        unsubscribe();
        sink.complete();
      }
    };

    const unsubscribe = this.runService.subscribeRunEvents(run, (event) => {
      if (completed) return;
      if (streaming) emit(event);
      else buffered.push(event);
    });

    const replay = await this.runService.listEvents(
      runId,
      after,
      owner,
      context
    );
    const replayTerminal =
      replay.length > 0 &&
      isGraphRunTerminalEventType(replay[replay.length - 1].type);

    return new Observable<MessageEvent>((subscriber) => {
      sink = subscriber;
      let last = after;
      for (const event of replay) {
        if (completed) break;
        emit(event);
        last = Math.max(last, event.sequence);
      }

      if (!completed) {
        while (buffered.length > 0 && buffered[0].sequence <= last) {
          buffered.shift();
        }
        streaming = true;
        while (buffered.length > 0 && !completed) {
          emit(buffered.shift() as GraphRunEventEnvelope);
        }
      }

      if (replayTerminal && !completed) {
        completed = true;
        unsubscribe();
        subscriber.complete();
      }

      return () => {
        completed = true;
        unsubscribe();
      };
    });
  }

  /**
   * Parses the SSE replay cursor: `0` for absent/empty values, otherwise the
   * parsed non-negative integer.
   *
   * @param {string | undefined} afterSequence - Raw `afterSequence` query parameter.
   * @return {number} The sequence number to replay events after.
   * @throws {HttpException} `400` when the value is not a non-negative integer.
   */
  private parseAfterSequence(afterSequence: string | undefined): number {
    if (afterSequence === undefined || afterSequence === "") return 0;
    if (!/^\d+$/.test(afterSequence)) {
      throw new HttpException(
        `Invalid afterSequence '${afterSequence}': must be a non-negative integer`,
        HttpStatus.BAD_REQUEST
      );
    }
    return Number.parseInt(afterSequence, 10);
  }
}
