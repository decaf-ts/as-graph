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
import { canAccessGraphResource } from "../engine/runs/ownership";
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
   */
  async create(
    document: GraphWorkflowDocument,
    ...args: MaybeContextualArg<Context>
  ): Promise<MastraWorkflowDescriptor> {
    const runtime = this.requireRuntime("addWorkflow");
    const owner = mastraManagerCallerOwnerOf(args);
    this.assertWritableProvenance(runtime, document.id);
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
   * Fails closed when a management mutation targets a workflow the wrapper did not
   * create (C3 complete mediation). A wrapper-managed id is writable; any
   * pre-existing registration — including a host `origin: "code"` workflow — is
   * protected from overwrite/delete, and an existing workflow whose provenance
   * cannot be determined is refused rather than mutated.
   *
   * @param runtime - The validated runtime.
   * @param workflowId - The managed workflow id.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_WORKFLOW_FORBIDDEN} when the
   *   workflow is not wrapper-managed.
   */
  private assertWritableProvenance(
    runtime: MastraWorkflowManagementRuntime,
    workflowId: string
  ): void {
    if (this.revisions.has(workflowId)) return;
    const origin = this.originOf(runtime, workflowId);
    if (origin !== undefined) {
      throw new GraphExecutionError(
        `Mastra workflow '${workflowId}' is a host registration (origin '${origin}'); the wrapper only manages workflows it created`,
        GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
        { workflowId, origin }
      );
    }
    if (this.registered(runtime, workflowId)) {
      throw new GraphExecutionError(
        `Mastra workflow '${workflowId}' exists but is not wrapper-managed; refusing to modify a foreign registration`,
        GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
        { workflowId }
      );
    }
  }

  /**
   * Enforces the C23 ownership predicate on a wrapper-managed workflow before a
   * management mutation, mirroring the backend's `canAccessGraphResource`
   * enforcement. Owner-less workflows stay writable by every caller.
   *
   * @param workflowId - The managed workflow id.
   * @param callerOwner - The caller owner resolved from the context.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_WORKFLOW_FORBIDDEN} when the
   *   caller may not write the workflow.
   */
  private assertOwnerAccess(
    workflowId: string,
    callerOwner: string | undefined
  ): void {
    const owner = this.owners.get(workflowId);
    if (!canAccessGraphResource({ owner }, callerOwner)) {
      throw new GraphExecutionError(
        `Mastra workflow '${workflowId}' is not writable by the caller`,
        GRAPH_MASTRA_WORKFLOW_FORBIDDEN,
        { workflowId }
      );
    }
  }

  /**
   * Reads how the runtime reports a workflow's registration origin.
   *
   * @param runtime - The validated runtime.
   * @param workflowId - The workflow id.
   * @returns The origin, or `undefined` when the runtime reports none.
   */
  private originOf(
    runtime: MastraWorkflowManagementRuntime,
    workflowId: string
  ): MastraWorkflowOrigin | undefined {
    if (typeof runtime.getWorkflowOrigin !== "function") return undefined;
    try {
      return runtime.getWorkflowOrigin(workflowId);
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the runtime already has a workflow registered under the id.
   *
   * @param runtime - The validated runtime.
   * @param workflowId - The workflow id.
   * @returns `true` when a workflow is registered under the id.
   */
  private registered(
    runtime: MastraWorkflowManagementRuntime,
    workflowId: string
  ): boolean {
    if (typeof runtime.getWorkflow !== "function") return false;
    try {
      const workflow = runtime.getWorkflow(workflowId);
      return workflow !== undefined && workflow !== null;
    } catch {
      return false;
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
