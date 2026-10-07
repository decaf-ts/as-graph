/**
 * @module as-graph/mastra/types
 * @summary Mastra backend shared types, ports, and error codes (SAA-196).
 * @description Contract surface of the `@mastra/core`-translated execution
 * backend: the registered backend flavour, the fail-closed error codes, the
 * host-provided node step handlers that own `createStep` translation, the
 * backend configuration, and the suspend-state reader port Mastra resume relies
 * on. Mastra owns execution state for suspended runs; these types only describe
 * what the host injects and what resume auditing returns.
 */
import type { Context, MaybeContextualArg } from "@decaf-ts/core";
import type {
  GraphBackendWorkflowStore,
  GraphBackendWorkflowSummary,
  GraphExecutionBackend,
} from "../engine/execution/GraphExecutionBackend";
import type {
  GraphExecutionValues,
  GraphRunId,
} from "../engine/types";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import type { MastraWorkflowCompiler } from "./MastraWorkflowCompiler";

/** The flavour id the Mastra backend registers under in the backend registry. */
export const MASTRA_BACKEND_FLAVOUR = "mastra";

/** A document node kind the Mastra translator cannot represent. */
export const GRAPH_MASTRA_UNSUPPORTED_KIND = "GRAPH_MASTRA_UNSUPPORTED_KIND";
/** A suspendable step declared a missing or degraded resume schema. */
export const GRAPH_MASTRA_RESUME_SCHEMA_UNSAFE =
  "GRAPH_MASTRA_RESUME_SCHEMA_UNSAFE";
/** A resume request failed validation (size, JSON safety, schema, or step). */
export const GRAPH_MASTRA_RESUME_INVALID = "GRAPH_MASTRA_RESUME_INVALID";
/** The resume step or iteration index is not allowlisted by the document. */
export const GRAPH_MASTRA_RESUME_STEP_UNKNOWN =
  "GRAPH_MASTRA_RESUME_STEP_UNKNOWN";
/** The Mastra snapshot is not a suspended run of the current document. */
export const GRAPH_MASTRA_RESUME_STATE_INVALID =
  "GRAPH_MASTRA_RESUME_STATE_INVALID";
/** The document translation emitted non-JSON-safe Mastra config. */
export const GRAPH_MASTRA_TRANSLATION_JSON_UNSAFE =
  "GRAPH_MASTRA_TRANSLATION_JSON_UNSAFE";
/** No Mastra agent is available for an agent-backed node. */
export const GRAPH_MASTRA_AGENT_UNAVAILABLE =
  "GRAPH_MASTRA_AGENT_UNAVAILABLE";
/** The wired Mastra runtime exposes no workflow-management surface. */
export const GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE =
  "GRAPH_MASTRA_MANAGEMENT_UNAVAILABLE";
/** A managed workflow id has no workflow registered on the runtime. */
export const GRAPH_MASTRA_WORKFLOW_NOT_FOUND =
  "GRAPH_MASTRA_WORKFLOW_NOT_FOUND";
/** Persisting a translated workflow to Mastra storage is not supported. */
export const GRAPH_MASTRA_PERSIST_NOT_SUPPORTED =
  "GRAPH_MASTRA_PERSIST_NOT_SUPPORTED";
/** A registered workflow exposes no serializable step graph. */
export const GRAPH_MASTRA_SERIALIZE_NOT_SUPPORTED =
  "GRAPH_MASTRA_SERIALIZE_NOT_SUPPORTED";
/**
 * A management mutation targeted a workflow the caller may not write, or a host
 * registration the wrapper did not create (C3 complete-mediation guard).
 */
export const GRAPH_MASTRA_WORKFLOW_FORBIDDEN =
  "GRAPH_MASTRA_WORKFLOW_FORBIDDEN";

/**
 * Execution context handed to a Mastra step handler for one node execution.
 * The handler receives everything the document resolved for the node plus the
 * Mastra-native suspension affordances.
 */
export interface MastraNodeStepContext {
  /** The document node being executed. */
  nodeId: string;
  /** The document node kind. */
  kind: string;
  /** Resolved node input values keyed by input port. */
  inputData: GraphExecutionValues;
  /** The workflow-level state accumulated so far. */
  state: Record<string, unknown>;
  /** Payload offered to a suspending step. */
  suspendPayload?: unknown;
  /** Resume payload supplied when a suspended step continues. */
  resumeData?: unknown;
  /** The Mastra-native runtime handle, when one is available. */
  mastra?: unknown;
  /** Mastra-native suspension callback for human-in-the-loop steps. */
  suspend?: (payload?: unknown) => unknown;
}

/**
 * Host-provided translator for one node kind. The backend has no built-in node
 * executors: hosts register one handler per supported kind, and translation
 * fails closed with {@link GRAPH_MASTRA_UNSUPPORTED_KIND} otherwise.
 */
export interface MastraNodeStepHandler {
  /** The document node kind this handler translates. */
  kind: string;
  /**
   * Builds the Mastra step for one node instance.
   * @param node - The document node instance to translate.
   * @param options - Step options (`stepId` names the Mastra step).
   * @returns The Mastra step object.
   */
  createStep(node: GraphNodeInstance, options: { stepId: string }): unknown;
}

/**
 * Configuration the host passes to {@link MastraGraphExecutionBackend.initialize}.
 * Everything is host-injected; the backend never constructs Mastra primitives.
 */
export interface MastraBackendConfig extends Record<string, unknown> {
  /** The Mastra runtime used to create and load runs. */
  mastra?: unknown;
  /** Optional Mastra storage configuration. */
  storage?: unknown;
  /** Optional named agent map used by agent-backed node handlers. */
  agents?: Record<string, unknown>;
  /** Node-kind step handlers; replaces the compiler's default (empty) set. */
  stepHandlers?: MastraNodeStepHandler[];
  /** Optional workflow catalogue port backing list/lookup capabilities. */
  workflowStore?: GraphBackendWorkflowStore;
  /** Reader for Mastra-authoritative suspended-run snapshots (resume port). */
  suspendStateReader?: MastraSuspendStateReader;
  /** Maximum accepted serialised `resumeData` size, in bytes. */
  maxResumeBytes?: number;
}

/**
 * Mastra-authoritative snapshot of a suspended run as exposed by the host's
 * suspend-state reader. Fields mirror {@link MastraResumeSnapshot} at the seam
 * where the backend reads run state for resume.
 */
export interface MastraRunSnapshotState {
  /** Canonical run id. */
  runId: GraphRunId;
  /** Canonical workflow id. */
  workflowId: string;
  /** Fingerprint of the document the run was launched from. */
  documentFingerprint: string;
  /** Mastra run status; resume is only legal from `suspended`. */
  status: string;
  /** Mastra step ids the run suspended on. */
  suspendedSteps: string[];
  /** Per-iteration suspend index, keyed by suspended step id. */
  suspendedForEachIndexes?: Record<string, number>;
}

/**
 * Host port that reads the Mastra-authoritative suspended-run snapshot.
 * Mastra owns execution state for suspended runs (gap-1); `GraphRunStore` is
 * never consulted for resume.
 */
export interface MastraSuspendStateReader {
  /**
   * Reads the suspended-run snapshot for a run.
   * @param runId - The canonical run id.
   * @param args - Optional decaf context arguments.
   * @returns The snapshot, or `undefined` when the run has none.
   */
  readRunState(
    runId: GraphRunId,
    ...args: MaybeContextualArg<Context>
  ): Promise<MastraRunSnapshotState | undefined>;
}

/** Host request to resume a suspended Mastra run. */
export interface MastraResumeRequest {
  /** The suspended step to resume; defaults to the first suspended step. */
  step?: string;
  /** Resume payload validated against the suspended step's resume schema. */
  resumeData?: Record<string, unknown>;
  /** Iteration index to resume, for suspensions inside a `foreach`. */
  forEachIndex?: number;
}

/**
 * C18 audit record returned by a successful resume. Carries identity and
 * provenance only; the raw `resumeData` is never logged or echoed.
 */
export interface MastraResumeAudit {
  /** Authenticated caller, when the host provided one. */
  caller?: string | null;
  /** The resumed run id. */
  runId: GraphRunId;
  /** The workflow id of the resumed run. */
  workflowId?: string;
  /** The resumed step id. */
  step?: string;
  /** The resumed iteration index, when the step is inside a `foreach`. */
  forEachIndex?: number;
  /** Stable hash of the accepted `resumeData`. */
  resumeDataHash?: string;
  /** Serialised size, in bytes, of the accepted `resumeData`. */
  resumeDataBytes?: number;
  /** ISO timestamp of the audit entry. */
  at?: string;
}

/** How Mastra registered a workflow: declared in code or persisted dynamically. */
export type MastraWorkflowOrigin = "code" | "dynamic";

/**
 * Structural port over the real `@mastra/core` `Mastra` workflow-management
 * surface (1.74.0). Every method mirrors a real instance method; the wrapper
 * never synthesizes one and fails closed when the wired runtime omits it.
 */
export interface MastraWorkflowManagementRuntime {
  /** Registers a committed workflow on the instance (real `addWorkflow`). */
  addWorkflow?(workflow: unknown, key?: string): void;
  /** Removes a registered workflow by key or id (real `removeWorkflow`). */
  removeWorkflow?(keyOrId: string): boolean;
  /** Reads a registered workflow by id (real `getWorkflow`). */
  getWorkflow?(id: string, options?: { serialized?: boolean }): unknown;
  /** Lists the registered workflows (real `listWorkflows`). */
  listWorkflows?(options?: { serialized?: boolean }): Record<string, unknown>;
  /** Reads how a workflow was registered (real `getWorkflowOrigin`). */
  getWorkflowOrigin?(keyOrId: string): MastraWorkflowOrigin | undefined;
}

/** A managed workflow as surfaced by the management surface. */
export interface MastraWorkflowDescriptor {
  /** Canonical workflow id. */
  id: string;
  /** Display name, when the registered workflow exposes one. */
  name?: string;
  /** How the workflow was registered, when the runtime reports it. */
  origin?: MastraWorkflowOrigin;
  /** Canonical document revision (fingerprint), when the wrapper tracked one. */
  revision?: string;
}

/** The JSON-safe serialized form of a registered workflow. */
export interface MastraSerializedWorkflow {
  /** Canonical workflow id. */
  id: string;
  /** Canonical document revision (fingerprint), when known. */
  revision?: string;
  /** The real Mastra `serializedStepGraph`. */
  steps: unknown;
}

/** Options a {@link MastraWorkflowManager} is created with. */
export interface MastraWorkflowManagerOptions {
  /** The wired real `@mastra/core` runtime (or `undefined` when unwired). */
  runtime?: unknown;
  /** The compiler used to translate canonical documents. */
  compiler?: MastraWorkflowCompiler;
}

/** The Mastra backend specialised over its configuration type. */
export type MastraBackend = GraphExecutionBackend<MastraBackendConfig>;
export type { GraphBackendWorkflowSummary };
