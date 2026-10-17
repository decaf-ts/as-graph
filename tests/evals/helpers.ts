/**
 * @module as-graph/tests/evals/helpers
 * @summary Shared fixtures for the mastra eval suite (SAA-836 E1).
 * @description Every `.eval.ts` file under `tests/evals` runs mastra
 * **datasets/experiments** against a target built from the production
 * `MastraGraphExecutionBackend` surface: the experiment's inline `task` executes
 * a canonical graph document through the real backend (production compiler +
 * `createMastraDefaultStepHandlers` + host factories), and mastra's
 * `runExperiment` records the experiment and per-item results in real mastra
 * storage, then the storage rows are read back and projected through the O1
 * read-only eval models (`MastraEvalModels`). Failures surface mastra eval
 * results (per-item mastra-recorded errors), never raw thrown errors.
 *
 * Evals are **stored separately and runnable independently** of the normal jest
 * suite: `.eval.ts` does not match the main `jest.config.cjs` `testRegex`
 * (`(test|spec|e2e)`), so only `jest.eval.config.cjs` picks these files up
 * (`npm run test:evals`).
 *
 * Live model runs (the single pipeline-smoke eval) read the provider key at
 * test time from the opencode config (`~/.config/opencode/opencode.json`,
 * provider `pdm_ai`, model `glm-5.3-flash`) or the `PDM_AI_API_KEY`
 * environment variable. The key is **never** logged, echoed, or asserted.
 * When the credentials are absent the live eval is skipped; when they are
 * present but the provider upstream is unhealthy the mastra-recorded item
 * error surfaces in the eval report (never a raw `AI_APICallError`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { createScorer, type MastraScorer } from "@mastra/core/evals";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
} from "../../src/shared/graph/constants";
import type { GraphWorkflowDocument } from "../../src/shared/graph";
import type { GraphExecutionEvent } from "../../src/shared/graph";
import { createGraphBackendHost } from "../../src/nest/graph/GraphBackendHost";
import { createMastraDefaultStepHandlers } from "../../src/mastra/MastraDefaultStepHandlers";
import type { MastraBackendConfig } from "../../src/mastra/types";
import {
  mastraExperimentRowToModel,
  mastraExperimentResultRowToModel,
} from "../../src/mastra/MastraEvalModels";
import { document, edge, node } from "../../src/workflows/builders";
import type {
  GraphFrameAwareEventSink,
} from "../../src/engine/execution/GraphExecutionBackend";
import type { GraphExecutionFrame } from "../../src/engine/execution/GraphExecutionFrame";
import type { GraphExecutionObserver } from "../../src/engine/events/GraphExecutionObserver";

/** Directory the eval reports are written to (gitignored `var/`). */
const REPORT_DIR = join(process.cwd(), "var", "as-graph-evals");

/** The opencode provider id + model the router exposes for the live eval. */
export const LIVE_PROVIDER = "pdm_ai";
export const LIVE_MODEL_ID = "glm-5.3-flash";
/** The canonical router base URL, used when the opencode config omits one. */
export const LIVE_BASE_URL = "https://router.ai.pdmfc.com/v1";

/** Absolute path of the opencode config read at test time. */
const CONFIG_PATH = join(
  process.env.HOME ?? "",
  ".config",
  "opencode",
  "opencode.json"
);

/** The provider connection resolved at test time (never the key value). */
export interface LiveProviderConfig {
  baseURL: string;
  apiKey: string;
}

/**
 * Resolves the live provider connection. The base URL comes from the opencode
 * config's `pdm_ai` provider (falling back to the canonical router URL); the
 * key is resolved from the `PDM_AI_API_KEY` environment variable, falling back
 * to the config's stored value.
 *
 * @returns The base URL and API key, or `undefined` when neither source yields a
 *   usable connection.
 */
export function readLiveProviderConfig(): LiveProviderConfig | undefined {
  let baseURL = LIVE_BASE_URL;
  let configApiKey: string | undefined;
  try {
    if (existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
        provider?: Record<string, { options?: Record<string, unknown> }>;
      };
      const options = parsed.provider?.[LIVE_PROVIDER]?.options;
      const configuredBaseURL = options?.["baseURL"];
      const configuredApiKey = options?.["apiKey"];
      if (typeof configuredBaseURL === "string" && configuredBaseURL) {
        baseURL = configuredBaseURL;
      }
      if (typeof configuredApiKey === "string" && configuredApiKey) {
        configApiKey = configuredApiKey;
      }
    }
  } catch {
    return undefined;
  }
  const apiKey = process.env["PDM_AI_API_KEY"] ?? configApiKey;
  if (typeof apiKey !== "string" || !apiKey) return undefined;
  return { baseURL, apiKey };
}

/** Minimal structural view of the provider's language model we exercise. */
interface LiveLanguageModel {
  doGenerate(options: {
    prompt: Array<Record<string, unknown>>;
    maxOutputTokens?: number;
  }): Promise<{ content: Array<Record<string, unknown>> }>;
}

/** The `@ai-sdk/openai-compatible` provider factory, when the package is installed. */
type OpenAICompatibleFactory = (options: {
  name: string;
  baseURL: string;
  apiKey: string;
}) => (modelId: string) => unknown;

/**
 * Loads the `@ai-sdk/openai-compatible` provider factory, the same provider the
 * opencode `pdm_ai` config is declared with. Loaded defensively so the live
 * eval stays skip-guarded (instead of failing to run) where the package is
 * absent.
 *
 * @returns The `createOpenAICompatible` factory, or `undefined` when unavailable.
 */
function loadOpenAICompatible(): OpenAICompatibleFactory | undefined {
  try {
    const localRequire = createRequire(__filename);
    const mod = localRequire("@ai-sdk/openai-compatible") as {
      createOpenAICompatible?: unknown;
    };
    return typeof mod.createOpenAICompatible === "function"
      ? (mod.createOpenAICompatible as OpenAICompatibleFactory)
      : undefined;
  } catch {
    return undefined;
  }
}

export const liveProviderConfig = readLiveProviderConfig();
export const createOpenAICompatible = loadOpenAICompatible();

/** The agent execution result shape the M1 agent runtime projects onto outputs. */
export interface EvalAgentResult {
  /** The agent's text response. */
  text: string;
  /** The agent's tool calls (empty for text-only evals). */
  toolCalls: unknown[];
}

/**
 * Builds the live `core.agent` host factory: a wrapper agent whose `generate`
 * calls the real `pdm_ai` router model (`glm-5.3-flash`) through the
 * `@ai-sdk/openai-compatible` provider. The key never leaves this closure and
 * is never logged.
 *
 * @param config - The live provider connection (base URL + key).
 * @returns The `createAgent` backend factory, or `undefined` when the
 *   `@ai-sdk/openai-compatible` package is unavailable.
 */
export function createLiveAgentFactory(
  config: LiveProviderConfig
): ((adapter: unknown, node: unknown) => unknown) | undefined {
  const factory = createOpenAICompatible;
  if (!factory) return undefined;
  return () => {
    const provider = factory({
      name: LIVE_PROVIDER,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    });
    const liveModel = provider(LIVE_MODEL_ID) as unknown as LiveLanguageModel;
    return {
      generate: async (prompt: string): Promise<EvalAgentResult> => {
        const generated = await liveModel.doGenerate({
          prompt: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
            },
          ],
          maxOutputTokens: 128,
        });
        const textPart = generated.content.find(
          (part) => part["type"] === "text"
        ) as { text?: string } | undefined;
        return { text: textPart?.text ?? "", toolCalls: [] };
      },
    };
  };
}

/**
 * Builds the deterministic `core.agent` host factory: a stub agent whose
 * `generate` echoes the prompt under a fixed template. No model provider is
 * involved (R1): the stub exists so agent-carrying eval documents execute
 * without credentials, keeping the whole eval suite runnable independently of
 * the live provider's health.
 *
 * @returns The `createAgent` backend factory.
 */
export function createStubAgentFactory(): () => unknown {
  return () => ({
    generate: async (prompt: string): Promise<EvalAgentResult> => {
      return { text: `stub response for ${prompt}`, toolCalls: [] };
    },
  });
}

/**
 * Host-injected frame-bound event sink that records emitted events. This is
 * the only piece of the event pipeline the production backend does not own;
 * evals drive the same shape the integration harness uses.
 *
 * @param runId - The canonical run id to bind onto the frame.
 * @returns The recorded events and the frame-bound sink.
 */
function evalSink(runId: string): {
  events: Partial<GraphExecutionEvent>[];
  sink: GraphFrameAwareEventSink;
} {
  const events: Partial<GraphExecutionEvent>[] = [];
  const observer: GraphExecutionObserver = {
    refresh: async () => {},
  };
  const frame = {
    runId,
    valueStore: { getWorkflowValues: () => ({}) },
    nodeResults: new Map(),
    events: [],
    startedAt: new Date(),
    finishedAt: undefined as Date | undefined,
    finish: () => {
      frame.finishedAt = new Date();
    },
  };
  const sink: GraphFrameAwareEventSink = {
    frame: frame as unknown as GraphExecutionFrame,
    eventFactory: undefined as never,
    engine: undefined as never,
    emit: async (event) => {
      events.push(event);
      await observer.refresh(event as GraphExecutionEvent);
    },
    updateObservers: async (event) => {
      await observer.refresh(event as GraphExecutionEvent);
    },
    bindFrame: () => {},
  };
  return { events, sink: sink as unknown as GraphFrameAwareEventSink };
}

/** The graph-run outcome one dataset item's task execution produced. */
export interface GraphTaskOutput {
  /** The canonical run terminal status (`succeeded`/`failed`/`suspended`/…). */
  status: string;
  /** Per-node recorded outputs, keyed by node id. */
  outputs: Record<string, Record<string, unknown>>;
  /**
   * The suspend payloads the run recorded (`workflow.suspended` events), keyed
   * by the suspending node id — the HITL kind's evaluable surface.
   */
  suspends: Record<string, Record<string, unknown>>;
  /**
   * The per-node failure surfaces the run recorded (`node.failed` events),
   * keyed by node id — failures surface the mastra/engine error fields
   * (message + code), never a raw thrown error.
   */
  nodeErrors: Record<string, { message: string; code?: string }>;
  /**
   * The graph-run failure surface, when the run did not succeed: the mastra/
   * engine-recorded error fields (message + code), never a raw thrown error.
   */
  error?: { message: string; code?: string };
}

/** A single dataset item for a graph eval. */
export interface GraphEvalItem {
  /** Stable item id (auto-generated by mastra when omitted). */
  id?: string;
  /** The inputs the graph document runs with. */
  input: Record<string, unknown>;
  /** Optional ground truth the scorers/eval file compares against. */
  groundTruth?: unknown;
}

/** The specification one `.eval.ts` file hands to {@link runGraphEval}. */
export interface GraphEvalSpec {
  /** Unique eval id (also the report file stem). */
  evalId: string;
  /** The agent-category kind under eval, when the eval targets one kind. */
  kind?: string;
  /** The canonical graph document every item executes. */
  document: GraphWorkflowDocument;
  /** The dataset items the experiment runs. */
  items: GraphEvalItem[];
  /**
   * Extra host backend config (agent factories, MCP/channel factories, …) on
   * top of the default step-handler set. A `core.agent` node fails closed when
   * no agent factory is supplied, so agent-carrying evals must inject one.
   */
  backendConfig?: Partial<MastraBackendConfig>;
  /** Extra scorers beyond the default run-succeeded scorer. */
  scorers?: MastraScorer[];
  /** Human-readable experiment description recorded in mastra storage. */
  description?: string;
}

/** The eval report one experiment produces, JSON-safe end to end. */
export interface GraphEvalReport {
  /** The eval id the report belongs to. */
  evalId: string;
  /** The mastra storage experiment id the run recorded. */
  experimentId: string;
  /** The mastra experiment terminal status. */
  status: string;
  /** Total dataset items the experiment planned to run. */
  totalItems: number;
  /** Items that succeeded. */
  succeededCount: number;
  /** Items that failed. */
  failedCount: number;
  /** Items that were skipped. */
  skippedCount: number;
  /** True when the run completed but some items failed. */
  completedWithErrors: boolean;
  /**
   * The mastra-recorded run-level failure (code/message from the
   * `experiment.run.finished` event), when the experiment failed before or
   * across item execution.
   */
  failure?: { code?: string; message?: string };
  /** Per-scorer recorded scores (mastra's own shape). */
  scores: Record<string, unknown>;
  /** The task output each item produced, keyed by item id. */
  outputs: Record<string, GraphTaskOutput>;
  /** The per-item results as mastra recorded them (id/status/error/scores). */
  itemResults: Array<{
    itemId: string;
    status: string;
    error?: Record<string, unknown>;
    /** The per-scorer scores mastra recorded for the item. */
    scores: Array<{ scorerId: string; score: number }>;
  }>;
  /** The O1-projected experiment row (read back from mastra storage). */
  projectedExperiment: Record<string, unknown> | null;
  /** The O1-projected result rows (read back from mastra storage). */
  projectedResults: Array<Record<string, unknown>>;
  /** The report file the run wrote (relative to the package root). */
  reportPath: string;
}

/**
 * Surfaces a caught failure as the graph-run error record (message + typed
 * code) instead of a raw thrown error, so experiment items record the mastra/
 * engine error surface and the eval report carries it.
 *
 * @param error - The caught value.
 * @returns The error surface record.
 */
export function graphErrorSurface(error: unknown): {
  message: string;
  code?: string;
} {
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; code?: unknown };
    return {
      message: typeof candidate.message === "string" ? candidate.message : String(error),
      ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    };
  }
  return { message: String(error) };
}

/**
 * Normalizes a mastra storage row into a plain JSON-safe record before the O1
 * projection. Jest's sandboxed module registry makes the mastra chunk's
 * `Date` instances realm-foreign, so `instanceof Date` checks (and any other
 * realm-sensitive probe) fail on them; round-tripping through JSON turns them
 * into ISO strings the O1 converters parse.
 *
 * @param row - The raw mastra storage row.
 * @returns The plain JSON-safe row record.
 */
function jsonNormalizeRow(row: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row ?? {})) as Record<string, unknown>;
}

/**
 * Runs one mastra experiment for a graph eval: every dataset item executes the
 * spec's document through the real `MastraGraphExecutionBackend`, mastra
 * records the experiment + per-item results in real mastra storage, the rows
 * are read back and projected through the O1 eval models, and a JSON report is
 * written under `var/as-graph-evals`.
 *
 * The default scorer records 1.0 when the graph run reached `succeeded` and
 * 0.0 otherwise; eval files add kind-specific scorers on top. A failed item
 * surfaces its mastra-recorded result (and the graph error surface), never a
 * raw thrown error.
 *
 * @param spec - The eval specification (document, items, backend factories).
 * @returns The JSON-safe eval report.
 */
export async function runGraphEval(spec: GraphEvalSpec): Promise<GraphEvalReport> {
  const host = await createGraphBackendHost({
    variant: "mastra",
    mastra: {
      mastra: {},
      stepHandlers: createMastraDefaultStepHandlers(),
      ...spec.backendConfig,
    } as MastraBackendConfig,
  });
  const backend = host.backend;
  if (!backend) {
    throw new Error(`eval '${spec.evalId}' failed to boot the mastra backend`);
  }

  // Store the eval as a real mastra dataset (items) + experiment (run) — the
  // mastra datasets/experiments surface the slice scope requires: the dataset
  // rows persist the eval inputs, the experiment row + per-item result rows
  // persist the outcomes, and both are read back from storage for the report.
  const mastra = new Mastra({ storage: new InMemoryStore() });
  const dataset = await mastra.datasets.create({
    name: spec.evalId,
    ...(spec.description ? { description: spec.description } : {}),
    metadata: {
      evalId: spec.evalId,
      ...(spec.kind ? { kind: spec.kind } : {}),
    },
  });
  await dataset.addItems({
    items: spec.items.map((item) => ({
      // The caller-defined, dataset-local logical identity is `externalId`
      // (mastra generates the internal item id).
      ...(item.id ? { externalId: item.id } : {}),
      input: item.input,
      ...(item.groundTruth !== undefined ? { groundTruth: item.groundTruth } : {}),
    })),
  });

  let itemCount = 0;
  const outputsByItem: Record<string, GraphTaskOutput> = {};
  const task = async ({ input }: { input: unknown }): Promise<GraphTaskOutput> => {
    itemCount += 1;
    const runId = `${spec.evalId}-item-${itemCount}`;
    const { events, sink } = evalSink(runId);
    try {
      const result = await backend.execute({
        document: spec.document,
        plan: {} as never,
        inputs: (input ?? {}) as Record<string, unknown>,
        options: {} as never,
        events: sink,
      });
      const outputs: Record<string, Record<string, unknown>> = {};
      const suspends: Record<string, Record<string, unknown>> = {};
      const nodeErrors: Record<string, { message: string; code?: string }> = {};
      for (const event of events) {
        if (
          event.type === GraphExecutionEventType.NODE_COMPLETED &&
          typeof event.nodeId === "string"
        ) {
          const payload = event.payload as
            | { outputs?: Record<string, unknown> }
            | undefined;
          outputs[event.nodeId] = payload?.outputs ?? {};
        }
        if (
          event.type === GraphExecutionEventType.NODE_FAILED &&
          typeof event.nodeId === "string"
        ) {
          nodeErrors[event.nodeId] = graphErrorSurface(event.error);
        }
        if (event.type === GraphExecutionEventType.WORKFLOW_SUSPENDED) {
          const payload = event.payload as
            | { suspend?: Record<string, unknown> }
            | undefined;
          const nodeId =
            typeof event.nodeId === "string" ? event.nodeId : "unknown";
          suspends[nodeId] = payload?.suspend ?? {};
        }
      }
      const output: GraphTaskOutput = {
        status: result.status,
        outputs,
        suspends,
        nodeErrors,
        ...(result.status !== GraphExecutionStatus.SUCCEEDED &&
        typeof (result as { error?: unknown }).error !== "undefined"
          ? {
              error: graphErrorSurface((result as { error?: unknown }).error),
            }
          : {}),
      };
      return output;
    } catch (error) {
      // Failures surface as the graph error record on the task output — the
      // experiment item records a mastra eval result, never a raw thrown error.
      const output: GraphTaskOutput = {
        status: "failed",
        outputs: {},
        suspends: {},
        nodeErrors: {},
        error: graphErrorSurface(error),
      };
      return output;
    }
  };

  const succeededScorer: MastraScorer = createScorer({
    id: "graph-run-succeeded",
    description: "1.0 when the graph run reached the succeeded terminal status",
  }).generateScore(({ run }) => {
    const output = run.output as GraphTaskOutput | undefined;
    return output?.status === GraphExecutionStatus.SUCCEEDED ? 1 : 0;
  });

  const scorers = [succeededScorer, ...(spec.scorers ?? [])];

  // Capture the mastra lifecycle events so a run-level failure surfaces as the
  // mastra-recorded error (code/message) in the report, never a raw throw.
  let runFailure: { code?: string; message?: string } | undefined;
  const onEvent = async (event: unknown): Promise<void> => {
    const record = event as {
      type?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (record.type === "experiment.run.finished" && record.error) {
      runFailure = {
        ...(typeof record.error.code === "string" ? { code: record.error.code } : {}),
        ...(typeof record.error.message === "string"
          ? { message: record.error.message }
          : {}),
      };
    }
  };

  const summary = await dataset.startExperiment({
    name: spec.evalId,
    task: task as never,
    scorers: scorers as never,
    metadata: {
      evalId: spec.evalId,
      ...(spec.kind ? { kind: spec.kind } : {}),
    },
    maxConcurrency: 1,
    onEvent: onEvent as never,
  });

  // Read the persisted rows back from mastra storage and project them through
  // the O1 read-only eval models (R7: rows that cannot project are skipped,
  // never fabricated).
  const storage = mastra.getStorage();
  const experimentsStore = (await storage?.getStore("experiments")) as
    | {
        listExperiments(args: unknown): Promise<{ experiments: unknown[] }>;
        listExperimentResults(args: unknown): Promise<{ results: unknown[] }>;
      }
    | undefined;
  let projectedExperiment: Record<string, unknown> | null = null;
  let projectedResults: Array<Record<string, unknown>> = [];
  if (experimentsStore) {
    const listed = await experimentsStore.listExperiments({
      pagination: { page: 0, perPage: 10 },
    });
    const row = listed.experiments.find(
      (candidate) =>
        (candidate as { id?: unknown })?.id === summary.experimentId
    );
    if (row) {
      projectedExperiment = (mastraExperimentRowToModel(
        jsonNormalizeRow(row) as never
      ) as unknown as Record<string, unknown>) ?? null;
    }
    const resultsPage = await experimentsStore.listExperimentResults({
      experimentId: summary.experimentId,
      pagination: { page: 0, perPage: 100 },
    });
    projectedResults = resultsPage.results
      .map(
        (resultRow) =>
          mastraExperimentResultRowToModel(
            jsonNormalizeRow(resultRow) as never
          ) as unknown as Record<string, unknown>
      )
      .filter((projected) => projected !== undefined);
  }

  const itemResults = summary.results.map((item) => {
    const record = item as unknown as {
      itemId?: unknown;
      status?: unknown;
      error?: unknown;
      scores?: unknown;
      output?: unknown;
    };
    const scores = Array.isArray(record.scores)
      ? (record.scores as Array<Record<string, unknown>>)
          .filter((score) => typeof score?.["scorerId"] === "string")
          .map((score) => ({
            scorerId: score["scorerId"] as string,
            score: typeof score["score"] === "number" ? score["score"] : 0,
          }))
      : [];
    const itemId =
      typeof record.itemId === "string" ? record.itemId : String(record.itemId);
    // The task output the item produced (mastra recorded it on the result).
    outputsByItem[itemId] = jsonNormalizeRow(record.output) as unknown as GraphTaskOutput;
    return {
      itemId,
      status: typeof record.status === "string" ? record.status : "unknown",
      scores,
      ...(record.error && typeof record.error === "object"
        ? { error: record.error as Record<string, unknown> }
        : {}),
    };
  });

  const report: GraphEvalReport = {
    evalId: spec.evalId,
    experimentId: summary.experimentId,
    status: summary.status,
    totalItems: summary.totalItems,
    succeededCount: summary.succeededCount,
    failedCount: summary.failedCount,
    skippedCount: summary.skippedCount,
    completedWithErrors: summary.completedWithErrors,
    ...(runFailure ? { failure: runFailure } : {}),
    scores: (summary as unknown as { scores?: Record<string, unknown> }).scores ?? {},
    outputs: outputsByItem,
    itemResults,
    projectedExperiment,
    projectedResults,
    reportPath: "",
  };

  try {
    mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = join(REPORT_DIR, `${spec.evalId}-${summary.experimentId}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    report.reportPath = reportPath;
  } catch {
    // Report writing is best-effort: the experiment results are already
    // persisted in mastra storage, so a filesystem failure must not mask them.
  }

  return report;
}

/**
 * Builds a single-node family document for a resource-descriptor kind: the
 * family/RAG/processor steps resolve their configuration into the JSON-safe
 * `resource` descriptor on the node's output port (R9 config-only fallback),
 * which the eval scorer asserts against.
 *
 * @param evalId - The eval id (also the document id).
 * @param kind - The agent-category node kind under eval.
 * @param config - The node parameters (kind-specific, may be empty).
 * @returns The canonical graph document.
 */
export function resourceDescriptorDocument(
  evalId: string,
  kind: string,
  config: Record<string, unknown> = {}
): GraphWorkflowDocument {
  return document({
    id: evalId,
    name: evalId,
    nodes: [node("subject", kind, config)],
    edges: [],
  });
}

/**
 * The deterministic resource-descriptor scorer: 1.0 when the executed node
 * resolved its configuration into a `resource` descriptor carrying the
 * expected kind, 0.0 otherwise.
 *
 * @param kind - The agent-category kind the descriptor must carry.
 * @returns The mastra scorer.
 */
export function resourceDescriptorScorer(kind: string): MastraScorer {
  return createScorer({
    id: "resource-descriptor-kind",
    description: `1.0 when the node resolved a resource descriptor for kind ${kind}`,
  }).generateScore(({ run }) => {
    const output = run.output as GraphTaskOutput | undefined;
    const resource = (
      output?.outputs?.["subject"]?.["resource"] as
        | { kind?: unknown }
        | undefined
    );
    return resource?.kind === kind ? 1 : 0;
  });
}

/** Options for {@link defineResourceDescriptorEval}. */
export interface ResourceDescriptorEvalOptions {
  /** The node parameters the kind resolves (may be empty). */
  config?: Record<string, unknown>;
  /** Extra scorers beyond the descriptor-kind scorer. */
  scorers?: MastraScorer[];
  /** The dataset items to run (defaults to one probe item). */
  items?: GraphEvalItem[];
}

/**
 * Defines a standard eval suite for a resource-descriptor kind: one experiment
 * over the single-node document, asserting the mastra experiment completed,
 * recorded per-item results, and projected the O1 experiment row (the evals
 * execute and record mastra experiment results).
 *
 * @param kind - The agent-category node kind under eval.
 * @param evalId - The unique eval id.
 * @param options - The kind config and optional extra scorers/items.
 */
export function defineResourceDescriptorEval(
  kind: string,
  evalId: string,
  options: ResourceDescriptorEvalOptions = {}
): void {
  const { config = {}, scorers = [], items } = options;
  describe(`mastra eval — ${kind} (${evalId})`, () => {
    it(
      "runs a mastra experiment that records the kind's resource descriptor",
      async () => {
        const report = await runGraphEval({
          evalId,
          kind,
          document: resourceDescriptorDocument(evalId, kind, config),
          items: items ?? [{ id: "probe", input: {} }],
          scorers,
          description: `SAA-836 E1 eval for the ${kind} agent kind`,
        });

        // The experiment itself completed and recorded results.
        expect(report.status).toBe("completed");
        expect(report.totalItems).toBe(report.itemResults.length);
        expect(report.failedCount).toBe(0);
        // The descriptor scorer scored 1.0 for the kind's resource output.
        expect(report.succeededCount).toBe(report.totalItems);
        // Every scorer (default + kind-specific) scored 1.0 on every item.
        for (const itemResult of report.itemResults) {
          expect(itemResult.scores.length).toBeGreaterThan(0);
          for (const score of itemResult.scores) {
            expect(score.score).toBe(1);
          }
        }
        // The O1 projection read the persisted experiment row back.
        expect(report.projectedExperiment?.["experimentId"]).toBe(
          report.experimentId
        );
        expect(report.projectedResults.length).toBeGreaterThan(0);
      },
      60000
    );
  });
}

/**
 * The deterministic memory-descriptor scorer: 1.0 when the executed memory
 * node resolved its configuration into the JSON-safe `mastra.memory` resource
 * descriptor (R9 config-only fallback) carrying the expected provider, 0.0
 * otherwise.
 *
 * @param provider - The memory provider the descriptor must carry (when the
 *   eval pins one; omitted matches any provider).
 * @returns The mastra scorer.
 */
export function memoryDescriptorScorer(provider?: string): MastraScorer {
  return createScorer({
    id: "memory-descriptor",
    description: `1.0 when the node resolved a mastra.memory descriptor${
      provider ? ` for provider ${provider}` : ""
    }`,
  }).generateScore(({ run }) => {
    const output = run.output as GraphTaskOutput | undefined;
    const resource = output?.outputs?.["subject"]?.["resource"] as
      | { type?: unknown; provider?: unknown }
      | undefined;
    const typeMatches = resource?.type === "mastra.memory";
    return typeMatches && (provider === undefined || resource?.provider === provider)
      ? 1
      : 0;
  });
}

export { document, edge, node };
