import { Inject, Optional } from "@nestjs/common";
import { NotFoundError, ValidationError } from "@decaf-ts/db-decorators";
import {
  ModelService,
  service,
  type Context,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import { assertGraphResourceOwnership } from "../../";
import {
  isGraphJsonSafeValue,
  isGraphWorkflowDocumentShape,
  type GraphWorkflowDocument,
  type GraphWorkflowSnapshot,
} from "../../shared/graph";
import { GraphNodeCatalogue } from "../../";
import type { GraphWorkflowValidationResult } from "../../";
import { GraphWorkflowModel } from "./GraphWorkflowModel";
import {
  DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS,
  type GraphWorkflowDocumentLimits,
} from "./GraphWorkflowDocumentLimits";
import { validateGraphWorkflowDocumentAtBoundary } from "./GraphWorkflowBoundaryValidation";
import { GraphWorkflowDocumentRejectedError } from "./GraphWorkflowErrors";

/** DI token for {@link GraphWorkflowServiceOptions}. */
export const GRAPH_WORKFLOW_OPTIONS = "GRAPH_WORKFLOW_OPTIONS";

/** Options for {@link GraphWorkflowService}: backend-enforced document resource limits. */
export interface GraphWorkflowServiceOptions {
  /** Backend-enforced resource limits for submitted documents (§4.16). */
  limits?: GraphWorkflowDocumentLimits;
  /**
   * Explicit DECAF-48 §4.15 standalone tolerance: when `true`, anonymous
   * callers are tolerated on owned workflows. Defaults to `false` —
   * ownership checks fail closed for absent identities (SAA-595 F3).
   */
  allowAnonymousAccess?: boolean;
}

/**
 * Resolves the authenticated user identifier from a request context
 * (DECAF-36 Req-B5: the auth handler accumulates `{ user, roles, organization }`
 * onto the context). Returns `undefined` for anonymous/system callers, which
 * the explicit DECAF-48 §4.15 standalone tolerance
 * (`allowAnonymousAccess`) may admit on owned resources (SAA-595 F3).
 */
export function graphWorkflowOwnerOf(ctx: Context | undefined): string | undefined {
  if (!ctx) return undefined;
  let user: unknown;
  try {
    user = (ctx as unknown as { cache?: Record<string, unknown> }).cache?.["user"];
  } catch {
    user = undefined;
  }
  if (user === undefined || user === null) {
    try {
      user = (ctx as unknown as { get(key: string): unknown }).get("user");
    } catch {
      user = undefined;
    }
  }
  return typeof user === "string" && user.length > 0 ? user : undefined;
}

function isCanonicalSnapshotWrapper(value: unknown): value is GraphWorkflowSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isGraphWorkflowDocumentShape(record["document"]) &&
    !isGraphWorkflowDocumentShape(value)
  );
}

function cloneWorkflowDocument(
  document: GraphWorkflowDocument
): GraphWorkflowDocument {
  return JSON.parse(JSON.stringify(document)) as GraphWorkflowDocument;
}

/**
 * Model-backed persistence for canonical workflow documents (DECAF-50
 * §4.10): saves and reads {@link GraphWorkflowModel} rows, validating every
 * submitted document at the boundary (forbidden fields, resource limits,
 * catalogue-backed nine-stage validation) before persisting, and converting
 * previously persisted legacy snapshots to canonical documents on read.
 * Enforces per-user ownership; absent caller identities are denied on owned
 * workflows unless the explicit DECAF-48 §4.15 standalone tolerance
 * (`allowAnonymousAccess`) is set (SAA-595 F3).
 */
@service(GraphWorkflowModel)
export class GraphWorkflowService extends ModelService<GraphWorkflowModel> {
  protected limits: Required<GraphWorkflowDocumentLimits>;
  protected catalogue: GraphNodeCatalogue | undefined;
  private allowAnonymousAccess: boolean;

  constructor(
    @Optional() @Inject(GRAPH_WORKFLOW_OPTIONS) options?: GraphWorkflowServiceOptions,
    @Optional() catalogue?: GraphNodeCatalogue
  ) {
    super(GraphWorkflowModel);
    this.limits = {
      ...DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS,
      ...options?.limits,
    };
    this.allowAnonymousAccess = options?.allowAnonymousAccess === true;
    this.catalogue = catalogue;
  }

  /**
   * Applies options to this service instance and returns it.
   *
   * `@service` classes resolve through the injectable-decorators singleton
   * registry, which does not forward constructor arguments reliably (Nest
   * provider options included); the module wiring uses this method to apply
   * {@link GRAPH_WORKFLOW_OPTIONS} deterministically (SAA-595 F3).
   */
  configure(options: GraphWorkflowServiceOptions): this {
    if (options.limits) {
      this.limits = { ...this.limits, ...options.limits };
    }
    if (options.allowAnonymousAccess !== undefined) {
      this.allowAnonymousAccess = options.allowAnonymousAccess === true;
    }
    return this;
  }

  async saveDocument(
    workflowId: string,
    document: GraphWorkflowDocument,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowModel> {
    const { ctx, ctxArgs } = (
      await this.logCtx(args, "saveDocument", true)
    ).for(this.saveDocument);

    if (!isGraphWorkflowDocumentShape(document)) {
      throw new ValidationError(
        "Payload is not a canonical GraphWorkflowDocument: id and name must be strings and inputs, outputs, nodes and edges must be arrays"
      );
    }
    if (document.id !== workflowId) {
      throw new ValidationError(
        `Document id '${document.id}' does not match the workflow id '${workflowId}' from the request path`
      );
    }

    const result = await this.validateDocument(document, ctx);
    if (!result.valid) {
      throw new GraphWorkflowDocumentRejectedError(result.issues);
    }

    const owner = graphWorkflowOwnerOf(ctx);

    let existing: GraphWorkflowModel | null;
    try {
      existing = (await this.read(workflowId, ...ctxArgs)) as GraphWorkflowModel;
    } catch {
      existing = null;
    }
    this.assertOwnership(workflowId, existing, owner);

    const now = new Date();
    if (existing) {
      existing.name = document.name;
      existing.document = cloneWorkflowDocument(document);
      existing.updatedAt = now;
      return this.update(existing, ...ctxArgs);
    }

    const model = new GraphWorkflowModel({
      workflowId,
      name: document.name,
      document: cloneWorkflowDocument(document),
      ...(owner ? { owner } : {}),
      updatedAt: now,
    });
    return this.create(model, ...ctxArgs);
  }

  async getDocument(
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowDocument> {
    const { ctx, ctxArgs } = (
      await this.logCtx(args, "getDocument", true)
    ).for(this.getDocument);

    let model: GraphWorkflowModel | null;
    try {
      model = (await this.read(workflowId, ...ctxArgs)) as GraphWorkflowModel;
    } catch {
      model = null;
    }
    if (!model) {
      throw new NotFoundError(
        `No graph workflow found for workflowId '${workflowId}'`
      );
    }
    this.assertOwnership(workflowId, model, graphWorkflowOwnerOf(ctx));

    if (model.document) {
      return cloneWorkflowDocument(model.document);
    }
    throw new NotFoundError(
      `Graph workflow '${workflowId}' has no canonical document; legacy definition/state snapshots are no longer supported (DECAF-50 §4.26 R2-2)`
    );
  }

  async validateDocument(
    document: GraphWorkflowDocument,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowValidationResult> {
    (await this.logCtx(args, "validateDocument", true)).for(
      this.validateDocument
    );
    return validateGraphWorkflowDocumentAtBoundary(document, {
      limits: this.limits,
      ...(this.catalogue ? { catalogue: this.catalogue } : {}),
    });
  }

  async saveSnapshot(
    workflowId: string,
    snapshot: Record<string, unknown>,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowModel> {
    const { ctx, ctxArgs } = (
      await this.logCtx(args, "saveSnapshot", true)
    ).for(this.saveSnapshot);

    if (!isGraphJsonSafeValue(snapshot)) {
      throw new ValidationError(
        "Workflow snapshot payload must be JSON-safe: functions, class instances, undefined, NaN/Infinity, symbol keys and unsafe prototype keys (__proto__/prototype/constructor) are rejected"
      );
    }

    if (!isCanonicalSnapshotWrapper(snapshot)) {
      throw new ValidationError(
        "Workflow snapshots must wrap a canonical GraphWorkflowDocument ({ document, editor?, metadata? }): legacy definition/state snapshots are no longer accepted; save canonical documents via PUT /graph/workflows/{workflowId}"
      );
    }

    const owner = graphWorkflowOwnerOf(ctx);

    let existing: GraphWorkflowModel | null;
    try {
      existing = (await this.read(workflowId, ...ctxArgs)) as GraphWorkflowModel;
    } catch {
      existing = null;
    }
    this.assertOwnership(workflowId, existing, owner);

    const now = new Date();
    if (existing) {
      existing.snapshot = snapshot;
      this.applyCanonicalWrapper(existing, snapshot);
      existing.updatedAt = now;
      return this.update(existing, ...ctxArgs);
    }

    const model = new GraphWorkflowModel({
      workflowId,
      snapshot,
      ...(owner ? { owner } : {}),
      updatedAt: now,
    });
    this.applyCanonicalWrapper(model, snapshot);
    return this.create(model, ...ctxArgs);
  }

  async loadSnapshot(
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowModel | null> {
    const { ctx, ctxArgs } = (
      await this.logCtx(args, "loadSnapshot", true)
    ).for(this.loadSnapshot);
    try {
      const model = (await this.read(workflowId, ...ctxArgs)) as GraphWorkflowModel;
      this.assertOwnership(workflowId, model, graphWorkflowOwnerOf(ctx));
      return model;
    } catch {
      return null;
    }
  }

  /**
   * Guards a persisted workflow record with the centralized
   * {@link assertGraphResourceOwnership} check, honouring this service's
   * configured `allowAnonymousAccess` tolerance (SAA-595 F3).
   */
  private assertOwnership(
    workflowId: string,
    model: GraphWorkflowModel | null | undefined,
    user: string | undefined
  ): void {
    assertGraphResourceOwnership(model ?? null, user ?? null, {
      allowAnonymousAccess: this.allowAnonymousAccess,
      resourceKind: "Graph workflow",
      resourceId: workflowId,
    });
  }

  private applyCanonicalWrapper(
    model: GraphWorkflowModel,
    snapshot: Record<string, unknown>
  ): void {
    if (!isCanonicalSnapshotWrapper(snapshot)) return;
    if (snapshot.document.id !== model.workflowId) {
      throw new ValidationError(
        `Document id '${snapshot.document.id}' does not match the workflow id '${model.workflowId}' from the request path`
      );
    }
    const result = validateGraphWorkflowDocumentAtBoundary(snapshot.document, {
      limits: this.limits,
      ...(this.catalogue ? { catalogue: this.catalogue } : {}),
    });
    if (!result.valid) {
      throw new GraphWorkflowDocumentRejectedError(result.issues);
    }
    model.document = cloneWorkflowDocument(snapshot.document);
    model.name = snapshot.document.name;
  }
}
