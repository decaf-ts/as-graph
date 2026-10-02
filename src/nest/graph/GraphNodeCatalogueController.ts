/**
 * @module as-graph/nest/graph/GraphNodeCatalogueController
 * @summary Catalogue HTTP API (DECAF-50 §4.12–§4.13).
 * @description Serves the trusted node catalogue over HTTP — manifest
 * listing (`node-types`), per-kind manifests/icons, parameterized `resolve`,
 * and node-method invocation — with optional authentication and
 * `@nestjs/throttler` request-rate limits on the expensive
 * `resolve`/`methods` operations; non-JSON-safe request bodies are rejected.
 */
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Headers,
  HttpException,
  HttpStatus,
  Optional,
  Inject,
  Res,
} from "@nestjs/common";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import { createHash } from "node:crypto";
import { Context } from "@decaf-ts/core";
import { DecafRequestContext } from "@decaf-ts/for-nest";
import type {
  GraphCredentialReference,
  GraphJsonValue,
  GraphNodeInstance,
  GraphNodeMethodManifest,
  GraphNodeMethodType,
} from "../../shared/graph";
import {
  cloneGraphJsonValue,
  isGraphNodeMethodType,
  isGraphJsonSafeValue,
} from "../../shared/graph";
import { GraphNodeCatalogue } from "../../";
import type {
  GraphNodeResolutionContext,
  GraphResolvedNodeManifest,
} from "../../shared/graph";

/** DI token for {@link GraphCatalogueControllerOptions}. */
export const GRAPH_CATALOGUE_CONTROLLER_OPTIONS =
  "GRAPH_CATALOGUE_CONTROLLER_OPTIONS";

/** Rate-limit configuration for an expensive catalogue operation: sliding window length and request cap. */
export interface GraphCatalogueRateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
}

/**
 * Default rate limit for an expensive catalogue operation, applied when a
 * {@link GraphCatalogueRateLimitOptions} is not configured: 60 requests per
 * 60-second window.
 */
export const DEFAULT_GRAPH_CATALOGUE_RATE_LIMIT: Required<GraphCatalogueRateLimitOptions> =
  {
    windowMs: 60_000,
    maxRequests: 60,
  };

/**
 * Options for the catalogue HTTP API (DECAF-50 §4.13): authentication mode
 * and per-operation rate limits for the expensive `resolve`/`methods`
 * endpoints. The limits are applied by the `@nestjs/throttler` guard that
 * {@link GraphExecutionModule} installs; the routes carry the `@Throttle`
 * selectors, and these options configure the matching named throttlers.
 */
export interface GraphCatalogueControllerOptions {
  /** Whether an authenticated request context is required (default `"required"`). */
  auth?: "required" | "optional";
  /**
   * Rate limit for manifest-resolution requests. Applied to the route by the
   * `@nestjs/throttler` guard; defaults to
   * {@link DEFAULT_GRAPH_CATALOGUE_RATE_LIMIT}.
   */
  resolveRateLimit?: GraphCatalogueRateLimitOptions;
  /**
   * Rate limit for node-method invocations. Applied to the route by the
   * `@nestjs/throttler` guard; defaults to
   * {@link DEFAULT_GRAPH_CATALOGUE_RATE_LIMIT}.
   */
  methodsRateLimit?: GraphCatalogueRateLimitOptions;
}

/** Request body for resolving a node's effective manifest against instance parameters. */
export interface GraphNodeResolveRequest {
  parameters?: Record<string, GraphJsonValue>;
  metadata?: Record<string, GraphJsonValue>;
}

/** Request body for invoking a declared node method. */
export interface GraphNodeMethodRequestDto {
  parameters?: Record<string, GraphJsonValue>;
  payload?: GraphJsonValue;
  credentials?: GraphCredentialReference[];
  methodType?: GraphNodeMethodType;
}

function sanitizeGraphJsonInput<T extends GraphJsonValue>(value: T, scope: string): T {
  if (!isGraphJsonSafeValue(value)) {
    throw new HttpException(
      `${scope} must be JSON-safe: functions, class instances, undefined, NaN/Infinity, symbol keys and unsafe prototype keys (__proto__/prototype/constructor) are not allowed`,
      HttpStatus.UNPROCESSABLE_ENTITY
    );
  }
  return cloneGraphJsonValue(value);
}

function manifestDigest(payload: unknown): string {
  return `"${createHash("sha1")
    .update(JSON.stringify(payload))
    .digest("base64url")}"`;
}

/**
 * Catalogue HTTP API (DECAF-50 §4.13): serves registered node manifests as
 * data (never constructors), resolves effective manifests for node
 * instances, and invokes declared node methods. Enforces configured
 * authentication and `@nestjs/throttler` request-rate limits on the expensive
 * `resolve`/`methods` operations, and rejects non-JSON-safe request bodies.
 */
@Controller("graph")
export class GraphNodeCatalogueController {
  constructor(
    private readonly catalogue: GraphNodeCatalogue,
    @Optional() @Inject(DecafRequestContext)
    private readonly requestContext?: DecafRequestContext,
    @Optional() @Inject(GRAPH_CATALOGUE_CONTROLLER_OPTIONS)
    private readonly options: GraphCatalogueControllerOptions = {}
  ) {}

  private requireAuthenticatedContext(): Context {
    if ((this.options.auth ?? "required") !== "required") {
      return this.requestContext ?? new Context();
    }
    if (!this.requestContext) {
      throw new HttpException(
        "Graph node catalogue access requires an authenticated request context",
        HttpStatus.UNAUTHORIZED
      );
    }
    return this.requestContext;
  }

  /**
   * Lists all registered node-type manifests with ETag/304 caching against
   * the `if-none-match` header. Requires an authenticated request context.
   *
   * @param {string} ifNoneMatch - Client's `If-None-Match` ETag, when supplied.
   * @param res - Passthrough response used to set the `ETag` header and 304 status.
   * @return {Promise<unknown>} The manifest collection, or 304 Not Modified.
   */
  @Get("node-types")
  async listNodeTypes(
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true })
    res: { setHeader(name: string, value: string): void; status(code: number): void }
  ): Promise<unknown> {
    const ctx = this.requireAuthenticatedContext();
    const manifests = this.catalogue.listManifests(undefined, ctx);
    const etag = manifestDigest(manifests);
    res.setHeader("ETag", etag);
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.status(HttpStatus.NOT_MODIFIED);
      return;
    }
    return manifests;
  }

  /**
   * Returns the manifest of a single registered node kind.
   *
   * @param {string} kind - Node kind path parameter.
   * @return {Promise<unknown>} The node's manifest.
   * @throws {HttpException} 404 when the kind is not registered.
   */
  @Get("node-types/:kind")
  async getNodeType(@Param("kind") kind: string): Promise<unknown> {
    const ctx = this.requireAuthenticatedContext();
    this.assertKnownKind(kind, ctx);
    return this.catalogue.getManifest(kind, ctx);
  }

  /**
   * Returns just the display icon reference of a registered node kind.
   *
   * @param {string} kind - Node kind path parameter.
   * @return {Promise<unknown>} `{ kind, icon }` (icon null when the manifest declares none).
   * @throws {HttpException} 404 when the kind is not registered.
   */
  @Get("node-types/:kind/icon")
  async getNodeTypeIcon(@Param("kind") kind: string): Promise<unknown> {
    const ctx = this.requireAuthenticatedContext();
    this.assertKnownKind(kind, ctx);
    const manifest = this.catalogue.getManifest(kind, ctx);
    return { kind, icon: manifest.display.icon ?? null };
  }

  /**
   * Resolves the effective manifest for a node kind against submitted
   * parameters/metadata (rate-limited on the `resolve` bucket).
   *
   * @param {string} kind - Node kind path parameter.
   * @param {GraphNodeResolveRequest} body - Optional `parameters`/`metadata` payload (JSON-sanitized).
   * @return {Promise<GraphResolvedNodeManifest>} The resolved manifest.
   * @throws {HttpException} 404 when the kind is not registered; 400 on invalid payloads.
   */
  @SkipThrottle({ default: true, methods: true })
  @Throttle({ resolve: {} })
  @Post("node-types/:kind/resolve")
  async resolveNodeType(
    @Param("kind") kind: string,
    @Body() body: GraphNodeResolveRequest = {}
  ): Promise<GraphResolvedNodeManifest> {
    const ctx = this.requireAuthenticatedContext();
    this.assertKnownKind(kind, ctx);
    const parameters = body?.parameters
      ? sanitizeGraphJsonInput(body.parameters, "resolve parameters")
      : {};
    const metadata = body?.metadata
      ? sanitizeGraphJsonInput(body.metadata, "resolve metadata")
      : undefined;
    const instance: GraphNodeInstance = {
      id: `resolve:${kind}`,
      kind,
      parameters,
      ...(metadata ? { metadata } : {}),
    };
    const context: GraphNodeResolutionContext = {
      requestContext: this.requestContext,
    };
    return await this.catalogue.resolveManifest(kind, instance, context, ctx);
  }

  /**
   * Invokes a declared node method with sanitized parameters, payload, and
   * credential-authorized context (rate-limited on the `methods` bucket).
   *
   * @param {string} kind - Node kind path parameter.
   * @param {string} method - Declared method name to invoke.
   * @param {GraphNodeMethodRequestDto} body - Method request carrying `methodType`, `parameters`, `payload`, and `credentials`.
   * @return {Promise<GraphJsonValue>} The method's JSON-safe return value.
   * @throws {HttpException} 404 for unknown kinds/methods, 401 without an authenticated context, 400 on invalid payloads.
   */
  @SkipThrottle({ default: true, resolve: true })
  @Throttle({ methods: {} })
  @Post("node-types/:kind/methods/:method")
  async invokeNodeMethod(
    @Param("kind") kind: string,
    @Param("method") method: string,
    @Body() body: GraphNodeMethodRequestDto = {}
  ): Promise<GraphJsonValue> {
    const ctx = this.requireAuthenticatedContext();
    this.assertKnownKind(kind, ctx);
    this.declaredMethod(kind, method, body?.methodType, ctx);
    const parameters = body?.parameters
      ? sanitizeGraphJsonInput(body.parameters, "method parameters")
      : {};
    const payload =
      body?.payload !== undefined
        ? sanitizeGraphJsonInput(body.payload as GraphJsonValue, "method payload")
        : undefined;
    const credentials = this.authorizeCredentials(
      kind,
      body?.credentials,
      ctx
    );
    const nodeMethod = this.catalogue.getMethod(kind, method, ctx);
    return nodeMethod(
      {
        kind,
        method,
        parameters,
        ...(payload !== undefined ? { payload } : {}),
      },
      {
        requestContext: this.requestContext,
        ...(credentials.length ? { credentials } : {}),
      }
    );
  }

  private assertKnownKind(kind: string, ctx: Context): void {
    if (!this.catalogue.has(kind, ctx)) {
      throw new HttpException(
        `No graph node kind '${kind}' is registered in the catalogue`,
        HttpStatus.NOT_FOUND
      );
    }
  }

  private declaredMethod(
    kind: string,
    method: string,
    expectedType: GraphNodeMethodType | undefined,
    ctx: Context
  ): GraphNodeMethodManifest {
    let declaration: GraphNodeMethodManifest;
    try {
      declaration = this.catalogue.getMethodDeclaration(kind, method, ctx);
    } catch {
      throw new HttpException(
        `Graph node kind '${kind}' does not declare method '${method}'`,
        HttpStatus.NOT_FOUND
      );
    }
    if (!isGraphNodeMethodType(declaration.type)) {
      throw new HttpException(
        `Graph node kind '${kind}' declares method '${method}' with an invalid type '${String(declaration.type)}'`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
    if (expectedType && expectedType !== declaration.type) {
      throw new HttpException(
        `Method '${method}' on kind '${kind}' has type '${declaration.type}', not '${expectedType}'`,
        HttpStatus.BAD_REQUEST
      );
    }
    return declaration;
  }

  private authorizeCredentials(
    kind: string,
    provided: GraphCredentialReference[] | undefined,
    ctx: Context
  ): GraphCredentialReference[] {
    const requirements =
      this.catalogue.getManifest(kind, ctx).credentials ?? [];
    const references = provided ?? [];
    for (const reference of references) {
      if (
        !reference ||
        typeof reference.credentialId !== "string" ||
        !reference.credentialId ||
        typeof reference.credentialType !== "string" ||
        !reference.credentialType
      ) {
        throw new HttpException(
          "Credential references must carry a credentialId and a credentialType",
          HttpStatus.BAD_REQUEST
        );
      }
      const declared = requirements.some(
        (requirement) => requirement.type === reference.credentialType
      );
      if (!declared) {
        throw new HttpException(
          `Graph node kind '${kind}' does not accept credentials of type '${reference.credentialType}'`,
          HttpStatus.FORBIDDEN
        );
      }
    }
    for (const requirement of requirements) {
      if (!requirement.required) continue;
      const satisfied = references.some(
        (reference) => reference.credentialType === requirement.type
      );
      if (!satisfied) {
        throw new HttpException(
          `Graph node kind '${kind}' requires a credential of type '${requirement.type}'`,
          HttpStatus.UNAUTHORIZED
        );
      }
    }
    return references;
  }
}
