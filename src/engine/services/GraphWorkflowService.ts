/**
 * @module as-graph/engine/services/GraphWorkflowService
 * @summary Model-backed persistence for canonical workflow documents
 * (DECAF-50 §4.10) plus the ownership-filtered workflow serving list (SAA-76).
 * @description Saves, reads, lists, validates, and access-checks
 * {@link GraphWorkflowModel} rows via the Decaf {@link ModelService}:
 * every submitted document passes the boundary validation gate before
 * persisting, legacy snapshots are handled per DECAF-50 §4.18, and all reads
 * and listings are fail-closed ownership-scoped through
 * {@link canAccessGraphResource} / {@link assertGraphResourceOwnership}.
 */
import { NotFoundError, ValidationError } from "@decaf-ts/db-decorators";
import {
  ModelService,
  OrderDirection,
  service,
  type Context,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import {
  assertGraphResourceOwnership,
  canAccessGraphResource,
} from "../runs/ownership";
import {
  isGraphJsonSafeValue,
  isGraphWorkflowDocumentShape,
  type GraphWorkflowDocument,
  type GraphWorkflowSnapshot,
} from "../../shared/graph";
import type { GraphNodeCatalogue } from "../catalog/GraphNodeCatalogue";
import type { GraphWorkflowValidationResult } from "../validation/GraphValidationIssue";
import { GraphWorkflowModel } from "../../shared/graph/GraphWorkflowModel";
import {
  DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS,
  type GraphWorkflowDocumentLimits,
} from "../validation/GraphWorkflowDocumentLimits";
import { validateGraphWorkflowDocumentAtBoundary } from "../validation/GraphWorkflowBoundaryValidation";
import { GraphWorkflowDocumentRejectedError } from "../errors/GraphWorkflowErrors";
import { GraphEnvironment } from "./GraphEnvironment";

/**
 * Resolves the authenticated user identifier from a request context
 * (DECAF-36 Req-B5: the auth handler accumulates `{ user, roles, organization }`
 * onto the context). Returns `undefined` for anonymous/system callers, which
 * the explicit DECAF-48 §4.15 standalone tolerance
 * (`allowAnonymousAccess`) may admit on owned resources (SAA-595 F3).
 */
export function graphWorkflowOwnerOf(
  ctx: Context | undefined
): string | undefined {
  if (!ctx) return undefined;
  let user: unknown;
  try {
    user = (ctx as unknown as { cache?: Record<string, unknown> }).cache?.[
      "user"
    ];
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

function isCanonicalSnapshotWrapper(
  value: unknown
): value is GraphWorkflowSnapshot {
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
  protected catalogue: GraphNodeCatalogue | undefined;

  constructor(catalogue?: GraphNodeCatalogue) {
    super(GraphWorkflowModel);
    this.catalogue = catalogue;
  }

  /**
   * Backend-enforced document resource limits (§4.16), resolved from the
   * {@link GraphEnvironment} (which accumulates `@decaf-ts/logging`'s
   * environment) at call time — no injectable config object.
   */
  protected get limits(): Required<GraphWorkflowDocumentLimits> {
    return {
      ...DEFAULT_GRAPH_WORKFLOW_DOCUMENT_LIMITS,
      ...(GraphEnvironment.graph.workflows.limits ?? {}),
    };
  }

  /**
   * Explicit DECAF-48 §4.15 standalone tolerance, resolved from the
   * {@link GraphEnvironment} — anonymous callers are tolerated on owned
   * workflows only when the environment opts in (SAA-595 F3).
   */
  protected get allowAnonymousAccess(): boolean {
    return GraphEnvironment.graph.workflows.allowAnonymousAccess === true;
  }

  /**
   * Validates and persists a canonical workflow document as the workflow's
   * `document` column, enforcing shape, document-id match, boundary
   * validation, and the DECAF-48 ownership tuple; creates or updates the
   * {@link GraphWorkflowModel} row accordingly.
   *
   * @param {string} workflowId - Workflow id from the request path.
   * @param {GraphWorkflowDocument} document - Canonical document to persist (its `id` must equal `workflowId`).
   * @param args - An optional decaf `Context` carrying the owning principal.
   * @return {Promise<GraphWorkflowModel>} The persisted workflow row.
   * @throws {ValidationError} When the payload shape or the document/path id match is invalid.
   * @throws {GraphWorkflowDocumentRejectedError} When boundary validation fails.
   */
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
      existing = (await this.read(
        workflowId,
        ...ctxArgs
      )) as GraphWorkflowModel;
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

  /**
   * Reads a workflow's canonical document, enforcing the DECAF-48 ownership
   * tuple. Legacy definition/state snapshots are no longer served.
   *
   * @param {string} workflowId - Workflow id to read.
   * @param args - An optional decaf `Context` carrying the requesting principal.
   * @return {Promise<GraphWorkflowDocument>} A clone of the stored canonical document.
   * @throws {NotFoundError} When the workflow does not exist or has no canonical document.
   */
  async getDocument(
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowDocument> {
    const { ctx, ctxArgs } = (await this.logCtx(args, "getDocument", true)).for(
      this.getDocument
    );

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

  /**
   * Lists the workflows visible to the requesting caller, newest update first.
   *
   * The collection is ownership-filtered with
   * {@link canAccessGraphResource}: owner-less system workflows stay visible to
   * everyone, a named caller sees their own plus owner-less workflows, and an
   * anonymous caller without the explicit `allowAnonymousAccess` tolerance sees
   * only owner-less workflows (SAA-595 F3). The full rows are returned so the
   * HTTP boundary can project the serving summary it exposes.
   *
   * @param args - An optional decaf `Context` carrying the requesting principal.
   * @return {Promise<GraphWorkflowModel[]>} Visible workflows, newest first.
   */
  async listWorkflows(
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowModel[]> {
    const { ctx, ctxArgs } = (
      await this.logCtx(args, "listWorkflows", true)
    ).for(this.listWorkflows);

    let models: GraphWorkflowModel[] = [];
    try {
      models = (await this.listBy(
        "workflowId",
        OrderDirection.ASC,
        ...ctxArgs
      )) as GraphWorkflowModel[];
    } catch {
      models = [];
    }

    const owner = graphWorkflowOwnerOf(ctx);
    return models
      .filter((model) =>
        canAccessGraphResource(model, owner, {
          allowAnonymousAccess: this.allowAnonymousAccess,
        })
      )
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  /**
   * Asserts that the workflow exists and is visible to the requesting caller,
   * returning the persisted row. Foreign owners surface as a `ForbiddenError`;
   * unknown workflows as a `NotFoundError` (the read path's own contract).
   *
   * @param {string} workflowId - Workflow id to check.
   * @param args - An optional decaf `Context` carrying the requesting principal.
   * @return {Promise<GraphWorkflowModel>} The accessible workflow row.
   * @throws {NotFoundError} When the workflow does not exist.
   * @throws {ForbiddenError} When the workflow is owned by another user.
   */
  async assertAccess(
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowModel> {
    const { ctx, ctxArgs } = (
      await this.logCtx(args, "assertAccess", true)
    ).for(this.assertAccess);

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
    return model;
  }

  /**
   * Runs the nine-stage boundary validation gate over a canonical document
   * without persisting anything.
   *
   * @param {GraphWorkflowDocument} document - Document to validate.
   * @param args - An optional decaf `Context` forwarded to validation.
   * @return {Promise<GraphWorkflowValidationResult>} Structured validation result (never throws for invalid documents).
   */
  async validateDocument(
    document: GraphWorkflowDocument,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowValidationResult> {
    const { ctx } = (await this.logCtx(args, "validateDocument", true)).for(
      this.validateDocument
    );
    return await validateGraphWorkflowDocumentAtBoundary(
      document,
      {
        limits: this.limits,
        ...(this.catalogue ? { catalogue: this.catalogue } : {}),
      },
      ctx
    );
  }

  /**
   * Persists a DECAF-50 §4.18 legacy-transition snapshot, which must be a
   * JSON-safe canonical wrapper (`{ document, editor?, metadata? }`),
   * enforcing the DECAF-48 ownership tuple and mirroring the wrapper's
   * document onto the row's canonical columns.
   *
   * @param {string} workflowId - Workflow id from the request path.
   * @param {Record<string, unknown>} snapshot - JSON-safe canonical snapshot wrapper.
   * @param args - An optional decaf `Context` carrying the owning principal.
   * @return {Promise<GraphWorkflowModel>} The persisted workflow row.
   * @throws {ValidationError} When the payload is not JSON-safe or is not a canonical snapshot wrapper.
   */
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
      existing = (await this.read(
        workflowId,
        ...ctxArgs
      )) as GraphWorkflowModel;
    } catch {
      existing = null;
    }
    this.assertOwnership(workflowId, existing, owner);

    const now = new Date();
    if (existing) {
      existing.snapshot = snapshot;
      await this.applyCanonicalWrapper(existing, snapshot, ctx);
      existing.updatedAt = now;
      return this.update(existing, ...ctxArgs);
    }

    const model = new GraphWorkflowModel({
      workflowId,
      snapshot,
      ...(owner ? { owner } : {}),
      updatedAt: now,
    });
    await this.applyCanonicalWrapper(model, snapshot, ctx);
    return this.create(model, ...ctxArgs);
  }

  /**
   * Reads a workflow row (legacy-transition snapshot access), enforcing the
   * DECAF-48 ownership tuple.
   *
   * @param {string} workflowId - Workflow id to read.
   * @param args - An optional decaf `Context` carrying the requesting principal.
   * @return {Promise<GraphWorkflowModel | null>} The workflow row, or `null` when it does not exist or ownership fails.
   */
  async loadSnapshot(
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowModel | null> {
    const { ctx, ctxArgs } = (
      await this.logCtx(args, "loadSnapshot", true)
    ).for(this.loadSnapshot);
    try {
      const model = (await this.read(
        workflowId,
        ...ctxArgs
      )) as GraphWorkflowModel;
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

  private async applyCanonicalWrapper(
    model: GraphWorkflowModel,
    snapshot: Record<string, unknown>,
    ctx: Context
  ): Promise<void> {
    if (!isCanonicalSnapshotWrapper(snapshot)) return;
    if (snapshot.document.id !== model.workflowId) {
      throw new ValidationError(
        `Document id '${snapshot.document.id}' does not match the workflow id '${model.workflowId}' from the request path`
      );
    }
    const result = await validateGraphWorkflowDocumentAtBoundary(
      snapshot.document,
      {
        limits: this.limits,
        ...(this.catalogue ? { catalogue: this.catalogue } : {}),
      },
      ctx
    );
    if (!result.valid) {
      throw new GraphWorkflowDocumentRejectedError(result.issues);
    }
    model.document = cloneWorkflowDocument(snapshot.document);
    model.name = snapshot.document.name;
  }
}
