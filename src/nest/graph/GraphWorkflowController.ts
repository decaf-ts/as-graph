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
import { GraphWorkflowService } from "../../engine/services/GraphWorkflowService";
import { GraphWorkflowDocumentRejectedError } from "../../engine/errors/GraphWorkflowErrors";
import type { GraphWorkflowDocumentLimits } from "../../engine/validation/GraphWorkflowDocumentLimits";

/** DI token for {@link GraphWorkflowControllerOptions}. */
export const GRAPH_WORKFLOW_OPTIONS = "GRAPH_WORKFLOW_OPTIONS";

/** Options for the workflow persistence HTTP API (DECAF-50 §4.10): authentication mode and document resource limits. */
export interface GraphWorkflowControllerOptions {
  /**
   * `"required"` rejects unauthenticated calls with `401` (default,
   * SAA-595 secure-defaults alignment); `"optional"` tolerates
   * anonymous/system callers for standalone module runs (DECAF-48 §4.15)
   * while still enforcing ownership between distinct users — pair it with an
   * explicit `allowAnonymousAccess` decision.
   */
  auth?: "required" | "optional";
  /**
   * Explicit DECAF-48 §4.15 standalone tolerance: when `true`, anonymous
   * callers are tolerated on owned workflows. Defaults to `false` —
   * ownership checks fail closed for absent identities (SAA-595 F3).
   */
  allowAnonymousAccess?: boolean;
  /** Backend-enforced resource limits (DECAF-50 §4.16). */
  limits?: GraphWorkflowDocumentLimits;
}

/** Response of a successful workflow save: persisted identity and timestamp. */
export interface GraphWorkflowSaveResponse {
  workflowId: string;
  name?: string;
  savedAt: string;
}

function graphWorkflowHttpErrorOf(e: unknown, workflowId?: string): HttpException {
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
      workflowId
        ? `Graph workflow '${workflowId}' is owned by another user`
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
 * Canonical workflow document persistence endpoints (DECAF-50 §4.10):
 *
 * - `PUT   /graph/workflows/{workflowId}` — validate and persist a canonical
 *   document (or a `{ document, editor, metadata }` snapshot wrapper, whose
 *   editor state is preserved verbatim for lossless round trips).
 * - `GET  /graph/workflows/{workflowId}` — load the canonical document;
 *   legacy persisted snapshots are converted losslessly on the read path.
 * - `POST /graph/workflows/validate` — run boundary validation and return
 *   structured issues (`code`, `path`, `nodeId`, `edgeId`, `message`,
 *   safe `details`).
 *
 * @class GraphWorkflowController
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
   * `"required"` (SAA-595 secure-defaults alignment) and rejects
   * unauthenticated calls with `401`; `"optional"` admits anonymous
   * requests for standalone module runs (DECAF-48 §4.15).
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
        savedAt: model.updatedAt.toISOString(),
      };
    } catch (e: unknown) {
      throw graphWorkflowHttpErrorOf(e, workflowId);
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
      throw graphWorkflowHttpErrorOf(e, workflowId);
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

  private isCanonicalWrapper(body: unknown): boolean {
    return (
      !!body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>)["document"] !== undefined &&
      (body as Record<string, unknown>)["nodes"] === undefined
    );
  }

  private documentOf(body: unknown): GraphWorkflowDocument {
    if (this.isCanonicalWrapper(body)) {
      return (body as { document: GraphWorkflowDocument }).document;
    }
    return body as GraphWorkflowDocument;
  }
}
