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
import type { MastraDecafModelResolver } from "./MastraStructuredOutput";
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
import type { GraphWorkflowDocument } from "../shared/graph/document/GraphWorkflowDocument";
import type { MastraWorkflowCompiler } from "./MastraWorkflowCompiler";
import type { MastraAgentRuntime } from "./MastraAgentStepHandler";
import type { MastraModelAdapterConfig } from "./MastraAgentModelAdapter";
import type { MastraMemoryConfig } from "./MastraMemory";
import type { MastraPersistence } from "./MastraPersistence";

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
/**
 * A configured RAG vector store could not be resolved (SAA-836 M4): the host
 * supplied no binding/driver for the selected provider, so the engine fails
 * closed instead of fabricating a store.
 */
export const GRAPH_MASTRA_VECTOR_UNAVAILABLE =
  "GRAPH_MASTRA_VECTOR_UNAVAILABLE";
/** A RAG vector store declared an unknown provider (SAA-836 M4). */
export const GRAPH_MASTRA_VECTOR_PROVIDER_UNKNOWN =
  "GRAPH_MASTRA_VECTOR_PROVIDER_UNKNOWN";
/**
 * A configured agent memory could not be resolved (SAA-836 M2): the mastra
 * memory package a provider needs is absent, the connection options are
 * incomplete, or no host resolution was supplied — so the engine fails closed
 * instead of fabricating a memory.
 */
export const GRAPH_MASTRA_MEMORY_UNAVAILABLE =
  "GRAPH_MASTRA_MEMORY_UNAVAILABLE";
/** An agent memory declared an unknown storage provider (SAA-836 M2). */
export const GRAPH_MASTRA_MEMORY_PROVIDER_UNKNOWN =
  "GRAPH_MASTRA_MEMORY_PROVIDER_UNKNOWN";
/**
 * A wired input/output processor or guardrail could not be resolved into a
 * real mastra processor (SAA-836 M5): unknown type, or a model-carrying type
 * with no resolvable classifier model, so the engine fails closed instead of
 * silently dropping the wired pipeline stage.
 */
export const GRAPH_MASTRA_PROCESSOR_UNAVAILABLE =
  "GRAPH_MASTRA_PROCESSOR_UNAVAILABLE";
/**
 * The MCP Server Trigger has no host-supplied mastra MCP server surface
 * (SAA-836 M5), so no workflow can be served as an MCP server; the trigger
 * fails closed instead of fabricating an endpoint.
 */
export const GRAPH_MASTRA_MCP_UNAVAILABLE = "GRAPH_MASTRA_MCP_UNAVAILABLE";
/**
 * A channel trigger/response node has no host-supplied channel adapter surface
 * (SAA-836 M6), so no conversation can be received from or delivered to the
 * platform; the node fails closed instead of fabricating a channel endpoint.
 */
export const GRAPH_MASTRA_CHANNEL_UNAVAILABLE =
  "GRAPH_MASTRA_CHANNEL_UNAVAILABLE";
/**
 * A schedule trigger node declared no resolvable cron expression (SAA-836
 * M6), so no scheduled fire can be registered with the mastra scheduler; the
 * translation fails closed instead of silently scheduling nothing.
 */
export const GRAPH_MASTRA_SCHEDULE_UNAVAILABLE =
  "GRAPH_MASTRA_SCHEDULE_UNAVAILABLE";
/**
 * A voice node has no host-supplied mastra voice surface (SAA-836 M6) — the
 * `@mastra/voice-*` provider packages are not vendored — so the node fails
 * closed instead of fabricating a voice capability.
 */
export const GRAPH_MASTRA_VOICE_UNAVAILABLE =
  "GRAPH_MASTRA_VOICE_UNAVAILABLE";
/** The Mastra execute path did not terminate within its run-level timeout. */
export const GRAPH_MASTRA_EXECUTE_TIMEOUT = "GRAPH_MASTRA_EXECUTE_TIMEOUT";
/** The Mastra execute path was aborted by the caller's cancellation signal. */
export const GRAPH_MASTRA_EXECUTE_ABORTED = "GRAPH_MASTRA_EXECUTE_ABORTED";
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
 * Mastra metrics reads require a storage surface the wired runtime does not
 * expose (SAA-836 S2): no storage at all, or the queried domain is absent, so
 * the read fails closed instead of fabricating rows.
 */
export const GRAPH_MASTRA_METRICS_UNAVAILABLE =
  "GRAPH_MASTRA_METRICS_UNAVAILABLE";
/**
 * The mastra metrics models are read-only projections (SAA-836 S2); a write
 * through the metrics adapter fails closed.
 */
export const GRAPH_MASTRA_METRICS_READ_ONLY =
  "GRAPH_MASTRA_METRICS_READ_ONLY";

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
   * @param options - Step options (`stepId` names the Mastra step; `document`
   *   carries the document being compiled, for handlers that resolve
   *   connection-zone wiring such as the agent's `memory` zone — SAA-836 M2).
   * @returns The Mastra step object.
   */
  createStep(node: GraphNodeInstance, options: MastraNodeStepOptions): unknown;
}

/**
 * Options a {@link MastraNodeStepHandler.createStep} call receives. `stepId`
 * names the Mastra step; `document` (SAA-836 M2/M5) carries the canonical
 * document being compiled so document-aware handlers (the agent handler
 * resolving its wired `memory` provider nodes or processor/guardrail zones)
 * can resolve graph context at translation time.
 */
export interface MastraNodeStepOptions {
  /** The Mastra step id to build the step with. */
  stepId: string;
  /** The canonical document being compiled, when the compiler has one. */
  document?: GraphWorkflowDocument;
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
  /**
   * Optional named agent map used by the `core.agent` step handler (SAA-837
   * M1). Keyed by `<provider>/<modelId>`, model id, or node id.
   */
  agents?: Record<string, unknown>;
  /**
   * Optional factory building a live mastra agent from a node's model-adapter
   * config (SAA-837 M1). Consulted when the {@link agents} map has no match.
   * The third argument (SAA-836 M2) carries the live mastra memories resolved
   * from the agent node's wired `memory` zone, for factories that attach
   * memory at construction; absent when no memory provider is wired.
   */
  createAgent?: (
    adapter: MastraModelAdapterConfig | undefined,
    node: GraphNodeInstance,
    memories?: readonly unknown[]
  ) => unknown | Promise<unknown>;
  /**
   * Optional named memory map used by the `core.agent` step handler (SAA-836
   * M2), keyed by the wiring memory node's id, its config id, or its provider.
   * Consulted before {@link createMemory} and the built-in resolution.
   */
  memories?: Record<string, unknown>;
  /**
   * Optional factory building a live mastra memory from a wired memory node's
   * config (SAA-836 M2). Consulted after the {@link memories} map and before
   * the built-in {@link resolveMastraMemory} wrap.
   */
  createMemory?: (
    config: MastraMemoryConfig,
    node: GraphNodeInstance
  ) => unknown | Promise<unknown>;
  /**
   * Optional pre-built agent runtime (SAA-837 M1). When provided it takes
   * precedence over {@link agents}/{@link createAgent}. When none of the three
   * is set, a `core.agent` node fails closed with
   * `GRAPH_MASTRA_AGENT_UNAVAILABLE`.
   */
  agentRuntime?: MastraAgentRuntime;
  /**
   * Host hook resolving the classifier model a model-carrying processor or
   * guardrail runs on (SAA-836 M5, R1). Receives the wired node's model-adapter
   * config; when omitted, the composed `<provider>/<modelId>` id is used.
   */
  resolveProcessorModel?: (
    adapter: MastraModelAdapterConfig | undefined
  ) => unknown | Promise<unknown>;
  /**
   * Host decaf-model registry resolving a structured-output definition's model
   * name to its constructor (SAA-836 S1). The resolved model converts to the
   * mastra Zod schema through `@decaf-ts/as-zod` (the single conversion path).
   * When omitted, a structured-output definition that references a model by
   * name fails closed with `GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED`.
   */
  resolveStructuredOutputModel?: MastraDecafModelResolver;
  /**
   * Host factory building the real mastra MCP server surface for an MCP Server
   * Trigger node (SAA-836 M5, R2). The `@mastra/mcp` package is not vendored,
   * so the wrapper never constructs the server itself; when omitted, the
   * trigger fails closed with `GRAPH_MASTRA_MCP_UNAVAILABLE`.
   */
  createMcpServer?: (descriptor: MastraMcpServerDescriptor) => unknown | Promise<unknown>;
  /**
   * Host factory building the real mastra channel adapter surface for a
   * channel trigger node (SAA-836 M6, R2). Concrete platform adapters live in
   * host-supplied packages (mastra's adapter catalog is metadata-only), so
   * when omitted the trigger fails closed with
   * `GRAPH_MASTRA_CHANNEL_UNAVAILABLE`.
   */
  resolveChannelAdapter?: (
    descriptor: MastraChannelTriggerDescriptor
  ) => unknown | Promise<unknown>;
  /**
   * Host factory posting a channel response node's reply to the platform
   * conversation bound by its descriptor (SAA-836 M6, R2). When omitted the
   * response fails closed with `GRAPH_MASTRA_CHANNEL_UNAVAILABLE`.
   */
  sendChannelResponse?: (
    descriptor: MastraChannelResponseDescriptor,
    payload: Record<string, unknown>
  ) => unknown | Promise<unknown>;
  /**
   * Host factory resolving the live mastra voice surface for a voice node's
   * config descriptor (SAA-836 M6, R2) — for example the wired agent's
   * `getVoice()`. The `@mastra/voice-*` provider packages are not vendored,
   * so when omitted the node fails closed with
   * `GRAPH_MASTRA_VOICE_UNAVAILABLE`.
   */
  resolveVoice?: (descriptor: MastraVoiceConfigDescriptor) => unknown | Promise<unknown>;
  /** Node-kind step handlers; replaces the compiler's default (empty) set. */
  stepHandlers?: MastraNodeStepHandler[];
  /** Optional workflow catalogue port backing list/lookup capabilities. */
  workflowStore?: GraphBackendWorkflowStore;
  /** Reader for Mastra-authoritative suspended-run snapshots (resume port). */
  suspendStateReader?: MastraSuspendStateReader;
  /** Maximum accepted serialised `resumeData` size, in bytes. */
  maxResumeBytes?: number;
  /**
   * Run-level terminal timeout, in milliseconds, for {@link MastraGraphExecutionBackend.execute}.
   * A translated run that has not terminated within this bound fails closed with
   * {@link GRAPH_MASTRA_EXECUTE_TIMEOUT} instead of pinning the run slot and event
   * stream indefinitely; mirrors the Dagster `terminalTimeoutMs` bound. Defaults
   * to five minutes when omitted.
   */
  terminalTimeoutMs?: number;
  /**
   * Host-built per-layer persistence surface (SAA-836 O1). When provided it
   * replaces the Environment-routed default (`MASTRA__PERSISTENCE__*`:
   * replays → `fs`, cache → `ram`, pins → `fs`) entirely; a host that routes
   * a layer to a driver-backed adapter (PG/CouchDB) supplies it here (R8
   * on-demand).
   */
  persistence?: MastraPersistence;
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

/**
 * The MCP server descriptor an MCP Server Trigger node resolves (SAA-836 M5).
 * The host factory receives it and builds the real mastra MCP server surface
 * exposing the enclosing workflow.
 */
export interface MastraMcpServerDescriptor {
  /** The unique MCP server id exposed to clients. */
  serverId: string;
  /** Optional display title. */
  title?: string;
  /** Optional instructions describing how clients use the served workflow. */
  instructions?: string;
  /** The transport the host server surface starts with. */
  transport?: "http" | "stdio";
  /** The canonical workflow id the trigger node belongs to. */
  workflowId?: string;
  /** The document node id of the trigger. */
  nodeId: string;
}

/** The channel platforms the built-in channel trigger/response kinds cover (SAA-836 M6). */
export const MASTRA_CHANNEL_PLATFORMS = [
  "slack",
  "discord",
  "telegram",
  "teams",
] as const;

/** A channel platform covered by the built-in channel trigger/response kinds (SAA-836 M6). */
export type MastraChannelPlatform = (typeof MASTRA_CHANNEL_PLATFORMS)[number];

/**
 * The channel descriptor a channel trigger node resolves (SAA-836 M6). The
 * host factory receives it and builds the real mastra channel adapter surface
 * (the `AgentChannels` adapter for the platform); concrete platform adapters
 * live in host-supplied packages, so the wrapper never constructs one itself.
 */
export interface MastraChannelTriggerDescriptor {
  /** The channel platform the trigger receives conversations from. */
  platform: MastraChannelPlatform;
  /** Optional configured conversation binding declared on the node. */
  threadId?: string;
  /** The canonical workflow id the trigger node belongs to. */
  workflowId?: string;
  /** The document node id of the trigger. */
  nodeId: string;
}

/**
 * The channel descriptor a channel response node resolves (SAA-836 M6). The
 * host factory receives it together with the reply payload and posts the
 * reply to the platform conversation bound by `threadId`.
 */
export interface MastraChannelResponseDescriptor {
  /** The channel platform the reply is delivered to. */
  platform: MastraChannelPlatform;
  /** The conversation binding the reply is posted to. */
  threadId?: string;
  /** The canonical workflow id the response node belongs to. */
  workflowId?: string;
  /** The document node id of the response. */
  nodeId: string;
}

/**
 * The voice configuration descriptor a voice node resolves (SAA-836 M6),
 * mirroring mastra's `VoiceConfig` shape. The host factory receives it and
 * resolves the live mastra voice surface (for example the agent's
 * `getVoice()`); the `@mastra/voice-*` provider packages are not vendored, so
 * the wrapper never constructs a provider voice client itself.
 */
export interface MastraVoiceConfigDescriptor {
  /** Optional speaker/voice id the provider renders speech with. */
  speaker?: string;
  /** Optional speech (text-to-speech) model configuration. */
  speechModel?: { name?: string };
  /** Optional listening (speech-to-text) model configuration. */
  listeningModel?: { name?: string };
  /** The canonical workflow id the voice node belongs to. */
  workflowId?: string;
  /** The document node id of the voice node. */
  nodeId: string;
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
