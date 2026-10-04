/**
 * @module as-graph/nest/graph/GraphEngineController
 * @summary Engine capability manifest + workflow-catalogue HTTP API (SAA-197,
 * SAA-193 C20/C21).
 * @description Serves the statically-derived engine capability manifest and the
 * engine-scoped workflow listing/lookup over read-only `GET` routes under the
 * `graph/engines` namespace. The routes carry the same authentication posture
 * as the other graph read routes, select engines by allowlisted id only (zero query
 * reflection), are rate-limited on the dedicated `engines` throttler bucket, and
 * map engine errors without ever surfacing `GraphExecutionError.details`.
 */
import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Optional,
  Param,
} from "@nestjs/common";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import { NotFoundError } from "@decaf-ts/db-decorators";
import { DecafRequestContext } from "@decaf-ts/for-nest";
import type { GraphWorkflowDocument } from "../../shared/graph";
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";
import { graphWorkflowOwnerOf } from "../../engine/services/GraphWorkflowService";
import type {
  GraphEngineCapabilityManifest,
  GraphEngineDescriptor,
} from "./GraphEngineCapabilityManifest";
import {
  GRAPH_ENGINE_CAPABILITY_OPTIONS,
  GraphEngineCapabilityService,
  type GraphEngineCapabilityOptions,
} from "./GraphEngineCapabilityService";
import { toIsoDateString } from "./servingDates";
import {
  GRAPH_SERVING_INTERNAL_ERROR_MESSAGE,
  logUnmappedGraphServingError,
  type GraphServingErrorCorrelation,
} from "./servingErrors";

/** One row of the engine workflow list: the serving summary a list binds to. */
export interface GraphEngineWorkflowSummary {
  /** Canonical workflow id. */
  workflowId: string;
  /** Display name mirrored from the document, when present. */
  name?: string;
  /** ISO timestamp of the last update, when the backend exposes one. */
  updatedAt?: string;
}

/**
 * Maps a thrown engine-catalogue error to the Nest HTTP equivalent: a backend
 * that declares no workflow catalogue becomes `501`, and any other unmapped error
 * surfaces as a constant generic `500` with the underlying error logged
 * server-side only. `GraphExecutionError.details` is never surfaced to clients.
 *
 * @param {unknown} e - The caught error from the engine facade.
 * @param {GraphServingErrorCorrelation} [correlation] - Request correlation ids attached to the server-side log.
 * @return {HttpException} The HTTP-mapped error to rethrow.
 */
function graphEngineHttpErrorOf(
  e: unknown,
  correlation: GraphServingErrorCorrelation = {}
): HttpException {
  if (e instanceof GraphExecutionError) {
    if (e.graphCode === "GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED") {
      return new HttpException(
        "Graph workflow catalogue is not supported by the selected engine",
        HttpStatus.NOT_IMPLEMENTED
      );
    }
    logUnmappedGraphServingError("GraphEngineController", e, correlation);
    return new HttpException(
      GRAPH_SERVING_INTERNAL_ERROR_MESSAGE,
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
  if (e instanceof NotFoundError) {
    return new NotFoundException(e.message);
  }
  if (e instanceof HttpException) return e;
  logUnmappedGraphServingError("GraphEngineController", e, correlation);
  return new HttpException(
    GRAPH_SERVING_INTERNAL_ERROR_MESSAGE,
    HttpStatus.INTERNAL_SERVER_ERROR
  );
}

/**
 * Engine capability manifest and engine-scoped workflow catalogue endpoints:
 *
 * - `GET /graph/engines` — the C20 capability manifest for every available
 *   (registered, allowlisted) engine.
 * - `GET /graph/engines/{engineId}` — one engine descriptor.
 * - `GET /graph/engines/{engineId}/workflows` — the workflows that engine
 *   surfaces through the engine-agnostic facade.
 * - `GET /graph/engines/{engineId}/workflows/{workflowId}` — one canonical
 *   workflow document from that engine.
 *
 * All routes are read-only `GET`s, select engines by allowlisted id only, and
 * never reflect arbitrary query input.
 */
@Controller("graph/engines")
export class GraphEngineController {
  constructor(
    private readonly capabilityService: GraphEngineCapabilityService,
    @Optional()
    @Inject(DecafRequestContext)
    private readonly requestContext?: DecafRequestContext,
    @Optional()
    @Inject(GRAPH_ENGINE_CAPABILITY_OPTIONS)
    private readonly options: GraphEngineCapabilityOptions = {}
  ) {}

  /**
   * Enforces the configured authentication mode: `auth` defaults to `"required"`
   * and rejects a request with no request context, or with a context that carries
   * no resolved owner user, with `401`; `"optional"` admits anonymous requests.
   */
  private requireAuthenticatedContext(): DecafRequestContext | undefined {
    if ((this.options.auth ?? "required") !== "required") {
      return this.requestContext;
    }
    if (!this.requestContext) {
      throw new HttpException(
        "Graph engine access requires an authenticated request context",
        HttpStatus.UNAUTHORIZED
      );
    }
    if (graphWorkflowOwnerOf(this.requestContext) === undefined) {
      throw new HttpException(
        "Graph engine access requires an authenticated user",
        HttpStatus.UNAUTHORIZED
      );
    }
    return this.requestContext;
  }

  private assertKnownEngine(engineId: string): void {
    if (!this.capabilityService.isKnownEngine(engineId)) {
      throw new NotFoundException(
        `No graph engine '${engineId}' is available`
      );
    }
  }

  /**
   * Returns the capability manifest for every available engine.
   *
   * @return {Promise<GraphEngineCapabilityManifest>} The C20 capability manifest.
   * @throws {HttpException} 401 without an authenticated caller.
   */
  @SkipThrottle({ default: true })
  @Throttle({ engines: {} })
  @Get()
  async getManifest(): Promise<GraphEngineCapabilityManifest> {
    this.requireAuthenticatedContext();
    return this.capabilityService.manifestSnapshot();
  }

  /**
   * Returns one allowlisted engine's capability descriptor.
   *
   * @param {string} engineId - Allowlisted engine id path parameter.
   * @return {Promise<GraphEngineDescriptor>} The engine descriptor.
   * @throws {HttpException} 404 when the engine id is not available.
   */
  @SkipThrottle({ default: true })
  @Throttle({ engines: {} })
  @Get(":engineId")
  async getEngine(
    @Param("engineId") engineId: string
  ): Promise<GraphEngineDescriptor> {
    this.requireAuthenticatedContext();
    const engine = this.capabilityService.descriptor(engineId);
    if (!engine) {
      throw new NotFoundException(
        `No graph engine '${engineId}' is available`
      );
    }
    return engine;
  }

  /**
   * Lists the workflows the selected engine surfaces through the
   * engine-agnostic facade.
   *
   * @param {string} engineId - Allowlisted engine id path parameter.
   * @return {Promise<GraphEngineWorkflowSummary[]>} Workflow summaries.
   * @throws {HttpException} 404 for an unknown engine id, 501 when the engine declares no listing support.
   */
  @SkipThrottle({ default: true })
  @Throttle({ engines: {} })
  @Get(":engineId/workflows")
  async listWorkflows(
    @Param("engineId") engineId: string
  ): Promise<GraphEngineWorkflowSummary[]> {
    const context = this.requireAuthenticatedContext();
    this.assertKnownEngine(engineId);
    try {
      const summaries = await this.capabilityService.listWorkflows(
        engineId,
        context
      );
      return summaries.map((summary) => {
        const updatedAt = toIsoDateString(summary.updatedAt);
        return {
          workflowId: summary.id,
          ...(summary.name !== undefined ? { name: summary.name } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
        };
      });
    } catch (e: unknown) {
      throw graphEngineHttpErrorOf(e, { engineId });
    }
  }

  /**
   * Returns one canonical workflow document from the selected engine through the
   * engine-agnostic facade.
   *
   * @param {string} engineId - Allowlisted engine id path parameter.
   * @param {string} workflowId - Canonical workflow id path parameter.
   * @return {Promise<GraphWorkflowDocument>} The canonical workflow document.
   * @throws {HttpException} 404 for an unknown engine id, 501 when the engine declares no lookup support.
   */
  @SkipThrottle({ default: true })
  @Throttle({ engines: {} })
  @Get(":engineId/workflows/:workflowId")
  async getWorkflow(
    @Param("engineId") engineId: string,
    @Param("workflowId") workflowId: string
  ): Promise<GraphWorkflowDocument> {
    const context = this.requireAuthenticatedContext();
    this.assertKnownEngine(engineId);
    try {
      return await this.capabilityService.getWorkflow(
        engineId,
        workflowId,
        context
      );
    } catch (e: unknown) {
      throw graphEngineHttpErrorOf(e, { engineId, workflowId });
    }
  }
}
