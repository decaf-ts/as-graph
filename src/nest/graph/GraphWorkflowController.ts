/**
 * @module as-graph/nest/graph/GraphWorkflowController
 * @summary Canonical workflow document persistence HTTP API (DECAF-50 §4.10)
 * plus the ownership-filtered workflow serving list (SAA-76).
 * @description Serves `PUT`/`GET /graph/workflows/:workflowId`,
 * `POST /graph/workflows/validate`, and `GET /graph/workflows` on top of
 * {@link GraphWorkflowService}, enforcing the configured authentication mode,
 * boundary validation, document resource limits, and fail-closed per-user
 * ownership; engine errors surface as mapped {@link HttpException}s, with any
 * unmapped error served as a constant generic `500` and logged server-side
 * only.
 */
import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Optional,
  Param,
  Put,
  Post,
  Inject,
} from "@nestjs/common";
import { NotFoundError, ValidationError } from "@decaf-ts/db-decorators";
import { AuthorizationError, ForbiddenError } from "@decaf-ts/core";
import type { GraphWorkflowDocument } from "../../shared/graph";
import { DecafRequestContext } from "@decaf-ts/for-nest";
import type { GraphWorkflowValidationResult } from "../../";
import {
  GraphWorkflowService,
  graphWorkflowOwnerOf,
} from "../../engine/services/GraphWorkflowService";
import { GraphWorkflowDocumentRejectedError } from "../../engine/errors/GraphWorkflowErrors";
import type { GraphWorkflowDocumentLimits } from "../../engine/validation/GraphWorkflowDocumentLimits";
import { toIsoDateString } from "./servingDates";
import {
  GRAPH_SERVING_INTERNAL_ERROR_MESSAGE,
  logUnmappedGraphServingError,
  type GraphServingErrorCorrelation,
} from "./servingErrors";

/** DI token for {@link GraphWorkflowControllerOptions}. */
export const GRAPH_WORKFLOW_OPTIONS = "GRAPH_WORKFLOW_OPTIONS";

/** Options for the workflow persistence HTTP API (DECAF-50 §4.10): authentication mode and document resource limits. */
export interface GraphWorkflowControllerOptions {
  /**
   * `"required"` rejects a request with no request context **and** a request
   * whose context carries no resolved owner user with `401` (SAA-93 F2): in a
   * host that installs the request-context machinery a context exists for every
   * request, so gating on context existence alone would admit unauthenticated
   * callers as anonymous. `"optional"` tolerates anonymous/system callers for
   * standalone module runs (DECAF-48 §4.15) while still enforcing ownership
   * between distinct users — pair it with an explicit `allowAnonymousAccess`
   * decision on the workflow service options.
   */
  auth?: "required" | "optional";
  /** Backend-enforced resource limits (DECAF-50 §4.16). */
  limits?: GraphWorkflowDocumentLimits;
}

/** Response of a successful workflow save: persisted identity and timestamp. */
export interface GraphWorkflowSaveResponse {
  workflowId: string;
  name?: string;
  savedAt: string;
}

/** One row of `GET /graph/workflows`: the serving summary a workflow list binds to. */
export interface GraphWorkflowSummary {
  /** Workflow document id (the persistence primary key). */
  workflowId: string;
  /** Display name mirrored from the document, when present. */
  name?: string;
  /** ISO timestamp of the last save/update. */
  updatedAt: string;
}

/**
 * Maps a thrown Decaf error to the Nest HTTP equivalent for the workflow
 * persistence/serving API: boundary rejection becomes `422` with structured
 * issues, ownership/authorization failures `403` (naming the workflow when
 * known), missing workflows `404`, validation failures `400`, and any unmapped
 * error surfaces as a constant generic `500` — the underlying error
 * message/stack is logged server-side only (SAA-116). Nest
 * {@link HttpException}s pass through unchanged.
 *
 * @param {unknown} e - The caught error from the service call.
 * @param {GraphServingErrorCorrelation} [correlation] - Request/workflow correlation ids attached to the server-side log.
 * @return {HttpException} The HTTP-mapped error to rethrow.
 */
function graphWorkflowHttpErrorOf(
  e: unknown,
  correlation: GraphServingErrorCorrelation = {}
): HttpException {
  if (e instanceof GraphWorkflowDocumentRejectedError) {
    return new HttpException(
      {
        message: "Graph workflow document rejected at the boundary",
        issues: e.issues,
      },
      HttpStatus.UNPROCESSABLE_ENTITY
    );
  }
  if (e instanceof ForbiddenError || e instanceof AuthorizationError) {
    return new HttpException(
      correlation.workflowId
        ? `Graph workflow '${correlation.workflowId}' is owned by another user`
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
  logUnmappedGraphServingError("GraphWorkflowController", e, correlation);
  return new HttpException(
    GRAPH_SERVING_INTERNAL_ERROR_MESSAGE,
    HttpStatus.INTERNAL_SERVER_ERROR
  );
}

/**
 * Canonical workflow document persistence endpoints (DECAF-50 §4.10):
 *
 * - `PUT   /graph/workflows/{workflowId}` — validate and persist a canonical
 *   document (or a `{ document, editor, metadata }` snapshot wrapper, whose
 *   editor state is preserved verbatim for lossless round trips).
 * - `GET  /graph/workflows/{workflowId}` — load the canonical document;
 *   legacy persisted snapshots are converted losslessly on the read path.
 * - `POST /graph/workflows/validate` — run boundary validation and return
 *   structured issues (`code`, `path`, `nodeId`, `edgeId`, `message`,
 * safe `details`).
 */
@Controller("graph")
export class GraphWorkflowController {
  constructor(
    private readonly workflowService: GraphWorkflowService,
    @Optional() @Inject(DecafRequestContext)
    private readonly requestContext?: DecafRequestContext,
    @Optional() @Inject(GRAPH_WORKFLOW_OPTIONS)
    private readonly options: GraphWorkflowControllerOptions = {}
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
        "Graph workflow access requires an authenticated request context",
        HttpStatus.UNAUTHORIZED
      );
    }
    if (graphWorkflowOwnerOf(this.requestContext) === undefined) {
      throw new HttpException(
        "Graph workflow access requires an authenticated user",
        HttpStatus.UNAUTHORIZED
      );
    }
    return this.requestContext;
  }

  /**
   * Saves a workflow: a canonical `{ document, ... }` wrapper body is stored
   * as a legacy-transition snapshot, a bare document body as the canonical
   * document.
   *
   * @param {string} workflowId - Workflow id path parameter.
   * @param {unknown} body - Bare `GraphWorkflowDocument` or canonical snapshot wrapper.
   * @return {Promise<GraphWorkflowSaveResponse>} The saved workflow's id, name, and timestamp.
   * @throws {HttpException} The mapped graph-workflow HTTP error (400/403/409 per the service contract).
   */
  @Put("workflows/:workflowId")
  async saveWorkflow(
    @Param("workflowId") workflowId: string,
    @Body() body: unknown
  ): Promise<GraphWorkflowSaveResponse> {
    const context = this.requireAuthenticatedContext();
    try {
      const model = this.isCanonicalWrapper(body)
        ? await this.workflowService.saveSnapshot(
            workflowId,
            body as Record<string, unknown>,
            context
          )
        : await this.workflowService.saveDocument(
            workflowId,
            body as GraphWorkflowDocument,
            context
          );
      return {
        workflowId,
        ...(model.name ? { name: model.name } : {}),
        savedAt: toIsoDateString(model.updatedAt) as string,
      };
    } catch (e: unknown) {
      throw graphWorkflowHttpErrorOf(e, { workflowId });
    }
  }

  /**
   * Lists the workflows visible to the requesting caller, newest update first.
   *
   * Auth follows the controller's configured `auth` mode (default `"required"`
   * rejects anonymous calls with `401`). The collection is ownership-filtered
   * by {@link GraphWorkflowService.listWorkflows}, so a caller only sees their
   * own plus owner-less (system/standalone) workflows. A row whose `updatedAt`
   * cannot be projected to an ISO string is skipped per row so a single corrupt
   * persisted date never 500s the whole collection (SAA-93 F4).
   *
   * @return {Promise<GraphWorkflowSummary[]>} Visible workflow summaries, newest first.
   * @throws {HttpException} 401 without an authenticated caller.
   */
  @Get("workflows")
  async listWorkflows(): Promise<GraphWorkflowSummary[]> {
    const context = this.requireAuthenticatedContext();
    try {
      const models = await this.workflowService.listWorkflows(context);
      const summaries: GraphWorkflowSummary[] = [];
      for (const model of models) {
        const updatedAt = toIsoDateString(model.updatedAt);
        if (updatedAt === undefined) continue;
        summaries.push({
          workflowId: model.workflowId,
          ...(model.name !== undefined ? { name: model.name } : {}),
          updatedAt,
        });
      }
      return summaries;
    } catch (e: unknown) {
      throw graphWorkflowHttpErrorOf(e);
    }
  }

  /**
   * Returns a workflow's canonical document.
   *
   * @param {string} workflowId - Workflow id path parameter.
   * @return {Promise<GraphWorkflowDocument>} The stored canonical document.
   * @throws {HttpException} The mapped graph-workflow HTTP error (404 for unknown/undocumented workflows, 403 for foreign owners).
   */
  @Get("workflows/:workflowId")
  async getWorkflow(
    @Param("workflowId") workflowId: string
  ): Promise<GraphWorkflowDocument> {
    const context = this.requireAuthenticatedContext();
    try {
      return await this.workflowService.getDocument(workflowId, context);
    } catch (e: unknown) {
      throw graphWorkflowHttpErrorOf(e, { workflowId });
    }
  }

  /**
   * Validates a workflow document against the boundary gate without persisting.
   *
   * @param {unknown} body - Bare `GraphWorkflowDocument` or canonical snapshot wrapper.
   * @return {Promise<GraphWorkflowValidationResult>} Structured validation result.
   * @throws {HttpException} 401 without an authenticated context.
   */
  @Post("workflows/validate")
  async validateWorkflow(
    @Body() body: unknown
  ): Promise<GraphWorkflowValidationResult> {
    this.requireAuthenticatedContext();
    const document = this.documentOf(body);
    return this.workflowService.validateDocument(document, this.requestContext);
  }

  /**
   * Detects a canonical snapshot wrapper body (`{ document, ... }`): an
   * object carrying a `document` member but no bare document `nodes` member.
   *
   * @param {unknown} body - The raw request body.
   * @return {boolean} `true` when the body should be routed to {@link GraphWorkflowService.saveSnapshot}.
   */
  private isCanonicalWrapper(body: unknown): boolean {
    return (
      !!body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>)["document"] !== undefined &&
      (body as Record<string, unknown>)["nodes"] === undefined
    );
  }

  /**
   * Extracts the bare {@link GraphWorkflowDocument} from a request body,
   * unwrapping a canonical snapshot wrapper when present.
   *
   * @param {unknown} body - The raw request body.
   * @return {GraphWorkflowDocument} The document to validate.
   */
  private documentOf(body: unknown): GraphWorkflowDocument {
    if (this.isCanonicalWrapper(body)) {
      return (body as { document: GraphWorkflowDocument }).document;
    }
    return body as GraphWorkflowDocument;
  }
}
