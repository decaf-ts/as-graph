/**
 * @module as-graph/mastra/MastraWorkflowManager
 * @summary Management surface over real `@mastra/core` workflows (SAA-346).
 * @description The Mastra analogue of a workflow-authoring/management surface:
 * it translates a canonical document into a real committed Mastra workflow (through
 * {@link MastraWorkflowCompiler}) and registers, updates, deletes, lists, reads,
 * and serializes it through the **real** `Mastra` instance methods
 * (`addWorkflow`/`removeWorkflow`/`getWorkflow`/`listWorkflows`/
 * `getWorkflowOrigin`). Every operation fails closed when the wired runtime does
 * not expose the real method, and the operations the pinned library does not back
 * are declared honestly: persistence is `NOT-SUPPORTED` (the real
 * `addDynamicWorkflow` persists only agent/tool-referenced steps, while the
 * canonical translation emits host code steps) and revision is an
 * `EXTENSION-POINT` (Mastra has no native workflow version; the wrapper tracks
 * the canonical document fingerprint).
 */
import type { Context, MaybeContextualArg } from "@decaf-ts/core";
import type { GraphWorkflowDocument } from "../shared/graph/document/GraphWorkflowDocument";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import { graphRunDocumentFingerprint } from "../engine/runs/GraphRunFingerprint";
import { canAccessGraphResourcePayload } from "../engine/runs/ownership";
import { graphWorkflowOwnerOf } from "../engine/services/GraphWorkflowService";
import { MastraWorkflowCompiler } from "./MastraWorkflowCompiler";
import {
  GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
  GRAPH_MASTRA_PERSIST_NOT_SUPPORTED,
  GRAPH_MASTRA_SERIALIZE_NOT_SUPPORTED,
  GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
  GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
  type MastraSerializedWorkflow,
  type MastraWorkflowDescriptor,
  type MastraWorkflowManagementRuntime,
  type MastraWorkflowManagerOptions,
  type MastraWorkflowOrigin,
} from "./types";

/** The real `@mastra/core` `Mastra` workflow-management method names. */
type MastraManagementMethod = keyof MastraWorkflowManagementRuntime;

/**
 * Whether a runtime `getWorkflow` failure is the real library's structured
 * not-found error — the only failure the provenance gate may interpret as
 * "unregistered" (SAA-911 F3). A structured 404 (`details.status === 404`)
 * or a not-found error id is the library's honest absence report; any other
 * throw is an indeterminate runtime failure and must fail closed.
 *
 * @param error - The error a runtime `getWorkflow` call threw.
 * @returns `true` when the error is the structured not-found report.
 */
function isMastraWorkflowNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as {
    details?: { status?: unknown };
    id?: unknown;
    message?: unknown;
  };
  if (
    record.details &&
    typeof record.details === "object" &&
    record.details["status"] === 404
  ) {
    return true;
  }
  if (typeof record.id === "string" && record.id.includes("NOT_FOUND")) {
    return true;
  }
  return (
    typeof record.message === "string" && /not found/i.test(record.message)
  );
}

/**
 * Structural check for a Decaf execution {@link Context} inside a
 * {@link MaybeContextualArg} argument list. Mirrors `@decaf-ts/core`'s own
 * realm-safe duck-typing (multiple linked core builds defeat `instanceof`).
 *
 * @param value - A candidate argument.
 * @returns `true` when the value is a Decaf execution context.
 */
function isMastraManagerContextLike(value: unknown): value is Context {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.get === "function" &&
    typeof candidate.accumulate === "function" &&
    typeof candidate.override === "function" &&
    typeof candidate.toOverrides === "function" &&
    candidate.cache !== undefined
  );
}

/**
 * Resolves the caller owner from the forwarded contextual arguments, matching the
 * backend's C23 resolution. The trailing context, when present, carries the
 * authenticated principal resolved with {@link graphWorkflowOwnerOf}.
 *
 * @param args - The forwarded contextual arguments.
 * @returns The caller owner, or `undefined` for owner-less callers.
 */
function mastraManagerCallerOwnerOf(
  args: readonly unknown[]
): string | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const candidate = args[index];
    if (isMastraManagerContextLike(candidate)) {
      return graphWorkflowOwnerOf(candidate);
    }
  }
  return undefined;
}

/**
 * Management surface over real `@mastra/core` workflows (SAA-346). Holds only the
 * wired runtime reference and the canonical-document compiler; it never constructs a
 * Mastra primitive itself and never synthesizes a method the pinned library does not
 * expose. Every method validates the runtime surface it needs first and fails
 * closed with {@link GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE} otherwise.
 *
 * Write ownership (SAA-911 F1–F3): every management mutation is write-mediated —
 * an overwrite of an already wrapper-managed id requires the caller to own the
 * existing registration, ownership is strict owner equality (the owner-less
 * read-visibility branch never authorizes a write), and a mutation whose
 * provenance cannot be determined is refused rather than trusted onto a
 * possibly foreign registration.
 */
export class MastraWorkflowManager {
  /** Canonical document revision (fingerprint) by managed workflow id. */
  private readonly revisions = new Map<string, string>();
  /**
   * Wrapper-managed provenance: the owner recorded when the wrapper created or
   * updated a workflow. An id absent from this map is not wrapper-managed, so a
   * host `origin: "code"` registration is protected from overwrite/delete (C3).
   */
  private readonly owners = new Map<string, string | undefined>();
  /** Standalone compiler used when the host does not inject one. */
  private readonly fallbackCompiler = new MastraWorkflowCompiler();

  /**
   * @param options - The wired runtime and optional shared compiler.
   */
  constructor(private readonly options: MastraWorkflowManagerOptions = {}) {}

  /** The wired real `@mastra/core` runtime, when any. */
  get runtime(): unknown {
    return this.options.runtime;
  }

  /**
   * Registers a workflow translated from a canonical document on the real Mastra
   * instance (real `addWorkflow`). This is the honest "create" operation: the
   * pinned library registers live, it does not persist a translated code-step
   * definition (see {@link persist}).
   *
   * @param document - The canonical document to translate and register.
   * @returns The managed workflow descriptor.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE}
   *   when the runtime exposes no `addWorkflow`.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_UNSUPPORTED_KIND} when the
   *   document cannot be translated.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_WORKFLOW_FORBIDDEN} when
   *   the id is already wrapper-managed by another owner, is a foreign
   *   registration, or its provenance cannot be determined (SAA-911 F1-F3).
   */
  async create(
    document: GraphWorkflowDocument,
    ...args: MaybeContextualArg<Context>
  ): Promise<MastraWorkflowDescriptor> {
    const runtime = this.requireRuntime("addWorkflow");
    const owner = mastraManagerCallerOwnerOf(args);
    this.assertWritableProvenance(runtime, document.id);
    // SAA-911 F1: an overwrite of an already wrapper-managed id is a write, so
    // it requires the caller to own the existing registration. A fresh create
    // is unconditional — the caller stamps their own owner (the same norm the
    // GraphWorkflowService upsert applies, SAA-105 R3).
    if (this.revisions.has(document.id)) {
      this.assertOwnerAccess(document.id, owner);
    }
    const compiled = this.compilerOf().compile(document);
    this.revisions.set(document.id, compiled.fingerprint);
    this.owners.set(document.id, owner);
    runtime.addWorkflow?.(compiled.workflow, document.id);
    return this.describe(document.id);
  }

  /**
   * Edits a managed workflow by recompiling the updated canonical document and
   * replacing the live registration (real `removeWorkflow` then `addWorkflow`). The
   * pinned library documents `removeWorkflow` as the update/delete path so a
   * subsequent save can re-register the same id cleanly.
   *
   * @param document - The updated canonical document.
   * @returns The managed workflow descriptor with its new revision.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE}
   *   when the runtime exposes no `addWorkflow`/`removeWorkflow`.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_WORKFLOW_FORBIDDEN} when
   *   the caller does not own the wrapper-managed workflow, the id is a
   *   foreign registration, or its provenance cannot be determined
   *   (SAA-911 F1–F3).
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_WORKFLOW_NOT_FOUND} when
   *   no workflow is registered under the document id.
   */
  async update(
    document: GraphWorkflowDocument,
    ...args: MaybeContextualArg<Context>
  ): Promise<MastraWorkflowDescriptor> {
    const runtime = this.requireRuntime("addWorkflow", "removeWorkflow");
    const owner = mastraManagerCallerOwnerOf(args);
    this.assertWritableProvenance(runtime, document.id);
    this.assertOwnerAccess(document.id, owner);
    const compiled = this.compilerOf().compile(document);
    const removed = runtime.removeWorkflow?.(document.id) === true;
    if (!removed) {
      throw new GraphExecutionError(
        `Mastra runtime has no managed workflow '${document.id}' to update`,
        GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
        { workflowId: document.id }
      );
    }
    this.revisions.set(document.id, compiled.fingerprint);
    this.owners.set(document.id, owner);
    runtime.addWorkflow?.(compiled.workflow, document.id);
    return this.describe(document.id);
  }

  /**
   * Deletes a managed workflow from the live Mastra registry (real
   * `removeWorkflow`).
   *
   * @param workflowId - The managed workflow id to remove.
   * @returns `true` when a workflow was removed.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE}
   *   when the runtime exposes no `removeWorkflow`.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_WORKFLOW_FORBIDDEN} when
   *   the caller does not own the wrapper-managed workflow, the id is a
   *   foreign registration, or its provenance cannot be determined
   *   (SAA-911 F1–F3).
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_WORKFLOW_NOT_FOUND} when no
   *   workflow is registered under the id.
   */
  async delete(
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<boolean> {
    const runtime = this.requireRuntime("removeWorkflow");
    const owner = mastraManagerCallerOwnerOf(args);
    this.assertWritableProvenance(runtime, workflowId);
    this.assertOwnerAccess(workflowId, owner);
    const removed = runtime.removeWorkflow?.(workflowId) === true;
    if (!removed) {
      throw new GraphExecutionError(
        `Mastra runtime has no managed workflow '${workflowId}' to delete`,
        GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
        { workflowId }
      );
    }
    this.revisions.delete(workflowId);
    this.owners.delete(workflowId);
    return true;
  }

  /**
   * Lists the managed workflows registered on the real Mastra instance (real
   * `listWorkflows`).
   *
   * @returns The managed workflow descriptors, in registry order.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE}
   *   when the runtime exposes no `listWorkflows`.
   */
  async list(): Promise<MastraWorkflowDescriptor[]> {
    const runtime = this.requireRuntime("listWorkflows");
    const registered = runtime.listWorkflows?.() ?? {};
    return Object.entries(registered).map(([id, workflow]) =>
      this.describeWorkflow(id, workflow)
    );
  }

  /**
   * Reads one managed workflow registered on the real Mastra instance (real
   * `getWorkflow`).
   *
   * @param workflowId - The managed workflow id to read.
   * @returns The managed workflow descriptor.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE}
   *   when the runtime exposes no `getWorkflow`.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_WORKFLOW_NOT_FOUND} when no
   *   workflow is registered under the id.
   */
  async get(workflowId: string): Promise<MastraWorkflowDescriptor> {
    const runtime = this.requireRuntime("getWorkflow");
    const workflow = this.registeredWorkflow(runtime, workflowId);
    return this.describeWorkflow(workflowId, workflow);
  }

  /**
   * Serializes a managed workflow through the real Mastra
   * `Workflow.serializedStepGraph` surface.
   *
   * @param workflowId - The managed workflow id to serialize.
   * @returns The JSON-safe serialized workflow.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE}
   *   when the runtime exposes no `getWorkflow`.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_WORKFLOW_NOT_FOUND} when no
   *   workflow is registered under the id.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_SERIALIZE_NOT_SUPPORTED}
   *   when the registered workflow exposes no serializable step graph.
   */
  async serialize(workflowId: string): Promise<MastraSerializedWorkflow> {
    const runtime = this.requireRuntime("getWorkflow");
    const workflow = this.registeredWorkflow(runtime, workflowId);
    const steps = (workflow as { serializedStepGraph?: unknown })
      .serializedStepGraph;
    if (!Array.isArray(steps)) {
      throw new GraphExecutionError(
        `Mastra workflow '${workflowId}' exposes no serialized step graph`,
        GRAPH_MASTRA_SERIALIZE_NOT_SUPPORTED,
        { workflowId }
      );
    }
    const revision = this.revisions.get(workflowId);
    return {
      id: workflowId,
      ...(revision !== undefined ? { revision } : {}),
      steps,
    };
  }

  /**
   * The canonical document revision (fingerprint) the wrapper tracks for a
   * document. Mastra has no native workflow version, so this is the honest
   * `EXTENSION-POINT` revision identity: it is computed from the canonical
   * document alone and requires no runtime.
   *
   * @param document - The canonical document to fingerprint.
   * @returns The stable revision fingerprint.
   */
  revision(document: GraphWorkflowDocument): string {
    return graphRunDocumentFingerprint(document);
  }

  /**
   * Persists a translated workflow to Mastra storage. The pinned real
   * `Mastra.addDynamicWorkflow` persists only agent/tool-referenced steps, while
   * the canonical translation emits host code steps, so this operation is
   * `NOT-SUPPORTED` and fails closed rather than faking a persisted definition.
   *
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_PERSIST_NOT_SUPPORTED}
   *   always.
   */
  async persist(): Promise<never> {
    throw new GraphExecutionError(
      "Mastra addDynamicWorkflow persists only agent/tool-referenced steps; the canonical translation emits host code steps",
      GRAPH_MASTRA_PERSIST_NOT_SUPPORTED
    );
  }

  /** The compiler the surface translates canonical documents with. */
  private compilerOf(): MastraWorkflowCompiler {
    return this.options.compiler ?? this.fallbackCompiler;
  }

  /**
   * Resolves the wired runtime after asserting it exposes every required real
   * Mastra method.
   *
   * @param methods - The real method names the operation needs.
   * @returns The wired runtime.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE}
   *   when the runtime is unwired or omits a required method.
   */
  private requireRuntime(
    ...methods: MastraManagementMethod[]
  ): MastraWorkflowManagementRuntime {
    const runtime = this.options.runtime;
    if (!runtime || typeof runtime !== "object") {
      throw new GraphExecutionError(
        "Mastra runtime is not wired; workflow management is unavailable",
        GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE
      );
    }
    const candidate = runtime as Record<string, unknown>;
    for (const method of methods) {
      if (typeof candidate[method] !== "function") {
        throw new GraphExecutionError(
          `Mastra runtime exposes no '${method}' method; workflow management is unavailable`,
          GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE,
          { method }
        );
      }
    }
    return runtime as MastraWorkflowManagementRuntime;
  }

  /**
   * Fails closed when a management mutation targets a workflow the wrapper did
   * not create (C3 complete mediation), and equally when the workflow's
   * provenance cannot be determined (SAA-911 F3). A wrapper-managed id is
   * writable; a pre-existing registration — including a host `origin: "code"`
   * workflow — is protected from overwrite/delete; and a runtime failure while
   * reading the registration state is never treated as "absent": the
   * provenance gate refuses the mutation rather than failing open onto a
   * possibly foreign registration.
   *
   * @param runtime - The validated runtime.
   * @param workflowId - The managed workflow id.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_WORKFLOW_FORBIDDEN} when
   *   the workflow is not wrapper-managed or its provenance is unresolvable.
   */
  private assertWritableProvenance(
    runtime: MastraWorkflowManagementRuntime,
    workflowId: string
  ): void {
    if (this.revisions.has(workflowId)) return;
    if (typeof runtime.getWorkflow !== "function") {
      // Without `getWorkflow` the gate cannot prove the id is unregistered,
      // so it cannot prove the mutation would not overwrite a foreign
      // registration — refuse instead of trusting absence (SAA-911 F3).
      throw new GraphExecutionError(
        `Mastra runtime exposes no 'getWorkflow'; the provenance of workflow '${workflowId}' cannot be determined, so the wrapper refuses to modify it`,
        GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
        { workflowId }
      );
    }
    let origin: MastraWorkflowOrigin | undefined;
    try {
      origin =
        typeof runtime.getWorkflowOrigin === "function"
          ? runtime.getWorkflowOrigin(workflowId)
          : undefined;
    } catch {
      throw new GraphExecutionError(
        `The Mastra runtime failed to report the registration origin of workflow '${workflowId}'; the wrapper refuses to modify a workflow whose provenance cannot be determined`,
        GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
        { workflowId }
      );
    }
    if (origin !== undefined) {
      throw new GraphExecutionError(
        `Mastra workflow '${workflowId}' is a host registration (origin '${origin}'); the wrapper only manages workflows it created`,
        GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
        { workflowId, origin }
      );
    }
    let registered: boolean;
    try {
      const workflow = runtime.getWorkflow(workflowId);
      registered = workflow !== undefined && workflow !== null;
    } catch (error) {
      // The real library reports an unregistered id by throwing its
      // structured not-found error — the only failure the gate may interpret
      // as "absent". Any other runtime failure leaves the provenance
      // undeterminable and fails closed (SAA-911 F3).
      if (!isMastraWorkflowNotFoundError(error)) {
        throw new GraphExecutionError(
          `The Mastra runtime failed to report the registration state of workflow '${workflowId}'; the wrapper refuses to modify a workflow whose provenance cannot be determined`,
          GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
          { workflowId }
        );
      }
      registered = false;
    }
    if (registered) {
      throw new GraphExecutionError(
        `Mastra workflow '${workflowId}' exists but is not wrapper-managed; refusing to modify a foreign registration`,
        GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
        { workflowId }
      );
    }
  }

  /**
   * Enforces strict owner equality on a wrapper-managed workflow before a
   * management mutation (SAA-911 F2, the SAA-105 R3 write norm). Deliberately
   * stricter than the read-visibility predicate: the owner-less visibility
   * branch that lets every caller *read* an owner-less workflow must never
   * authorize a write, so an owner-less workflow is writable only by an
   * owner-less caller, and an owned workflow only by its recorded owner.
   *
   * @param workflowId - The managed workflow id.
   * @param callerOwner - The caller owner resolved from the context.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_WORKFLOW_FORBIDDEN} when
   *   the caller may not write the workflow.
   */
  private assertOwnerAccess(
    workflowId: string,
    callerOwner: string | undefined
  ): void {
    const owner = this.owners.get(workflowId);
    if (!canAccessGraphResourcePayload({ owner }, callerOwner)) {
      throw new GraphExecutionError(
        `Mastra workflow '${workflowId}' is not writable by the caller`,
        GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
        { workflowId }
      );
    }
  }

  /**
   * Reads a registered workflow, mapping the real not-found failure onto the
   * canonical error code.
   *
   * @param runtime - The validated runtime.
   * @param workflowId - The managed workflow id to read.
   * @returns The registered workflow object.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_WORKFLOW_NOT_FOUND} when no
   *   workflow is registered under the id.
   */
  private registeredWorkflow(
    runtime: MastraWorkflowManagementRuntime,
    workflowId: string
  ): unknown {
    let workflow: unknown;
    try {
      workflow = runtime.getWorkflow?.(workflowId);
    } catch {
      workflow = undefined;
    }
    if (workflow === undefined || workflow === null) {
      throw new GraphExecutionError(
        `Mastra runtime has no managed workflow '${workflowId}'`,
        GRAPH_MASTRA_WORKFLOW_NOT_FOUND,
        { workflowId }
      );
    }
    return workflow;
  }

  /**
   * Builds a managed workflow descriptor, reading the real registration origin
   * and the wrapper-tracked revision when available.
   *
   * @param workflowId - The managed workflow id.
   * @param workflow - The registered workflow object.
   * @returns The managed workflow descriptor.
   */
  private describeWorkflow(
    workflowId: string,
    workflow: unknown
  ): MastraWorkflowDescriptor {
    const name = (workflow as { name?: unknown })?.name;
    let origin: MastraWorkflowOrigin | undefined;
    const runtime = this.options.runtime as
      | MastraWorkflowManagementRuntime
      | undefined;
    try {
      origin = runtime?.getWorkflowOrigin?.(workflowId);
    } catch {
      origin = undefined;
    }
    const revision = this.revisions.get(workflowId);
    return {
      id: workflowId,
      ...(typeof name === "string" ? { name } : {}),
      ...(origin ? { origin } : {}),
      ...(revision !== undefined ? { revision } : {}),
    };
  }

  /**
   * Builds a descriptor for a workflow the wrapper has just registered or
   * updated.
   *
   * @param workflowId - The managed workflow id.
   * @returns The managed workflow descriptor.
   */
  private describe(workflowId: string): MastraWorkflowDescriptor {
    const runtime = this.options.runtime as
      | MastraWorkflowManagementRuntime
      | undefined;
    let workflow: unknown;
    if (typeof runtime?.getWorkflow === "function") {
      try {
        workflow = runtime.getWorkflow(workflowId);
      } catch {
        workflow = undefined;
      }
    }
    return this.describeWorkflow(workflowId, workflow);
  }
}
