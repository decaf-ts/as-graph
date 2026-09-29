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

  private requireAuthenticatedContext(): DecafRequestContext | undefined {
    if ((this.options.auth ?? "required") !== "required") {
      return this.requestContext;
    }
    if (!this.requestContext) {
      throw new HttpException(
        "Graph node catalogue access requires an authenticated request context",
        HttpStatus.UNAUTHORIZED
      );
    }
    return this.requestContext;
  }

  @Get("node-types")
  async listNodeTypes(
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true })
    res: { setHeader(name: string, value: string): void; status(code: number): void }
  ): Promise<unknown> {
    this.requireAuthenticatedContext();
    const manifests = this.catalogue.listManifests();
    const etag = manifestDigest(manifests);
    res.setHeader("ETag", etag);
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.status(HttpStatus.NOT_MODIFIED);
      return;
    }
    return manifests;
  }

  @Get("node-types/:kind")
  async getNodeType(@Param("kind") kind: string): Promise<unknown> {
    this.requireAuthenticatedContext();
    this.assertKnownKind(kind);
    return this.catalogue.getManifest(kind);
  }

  @Get("node-types/:kind/icon")
  async getNodeTypeIcon(@Param("kind") kind: string): Promise<unknown> {
    this.requireAuthenticatedContext();
    this.assertKnownKind(kind);
    const manifest = this.catalogue.getManifest(kind);
    return { kind, icon: manifest.display.icon ?? null };
  }

  @SkipThrottle({ default: true, methods: true })
  @Throttle({ resolve: {} })
  @Post("node-types/:kind/resolve")
  async resolveNodeType(
    @Param("kind") kind: string,
    @Body() body: GraphNodeResolveRequest = {}
  ): Promise<GraphResolvedNodeManifest> {
    this.requireAuthenticatedContext();
    this.assertKnownKind(kind);
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
    return this.catalogue.resolveManifest(kind, instance, context);
  }

  @SkipThrottle({ default: true, resolve: true })
  @Throttle({ methods: {} })
  @Post("node-types/:kind/methods/:method")
  async invokeNodeMethod(
    @Param("kind") kind: string,
    @Param("method") method: string,
    @Body() body: GraphNodeMethodRequestDto = {}
  ): Promise<GraphJsonValue> {
    this.requireAuthenticatedContext();
    this.assertKnownKind(kind);
    this.declaredMethod(kind, method, body?.methodType);
    const parameters = body?.parameters
      ? sanitizeGraphJsonInput(body.parameters, "method parameters")
      : {};
    const payload =
      body?.payload !== undefined
        ? sanitizeGraphJsonInput(body.payload as GraphJsonValue, "method payload")
        : undefined;
    const credentials = this.authorizeCredentials(kind, body?.credentials);
    const nodeMethod = this.catalogue.getMethod(kind, method);
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

  private assertKnownKind(kind: string): void {
    if (!this.catalogue.has(kind)) {
      throw new HttpException(
        `No graph node kind '${kind}' is registered in the catalogue`,
        HttpStatus.NOT_FOUND
      );
    }
  }

  private declaredMethod(
    kind: string,
    method: string,
    expectedType: GraphNodeMethodType | undefined
  ): GraphNodeMethodManifest {
    let declaration: GraphNodeMethodManifest;
    try {
      declaration = this.catalogue.getMethodDeclaration(kind, method);
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
    provided: GraphCredentialReference[] | undefined
  ): GraphCredentialReference[] {
    const requirements = this.catalogue.getManifest(kind).credentials ?? [];
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
