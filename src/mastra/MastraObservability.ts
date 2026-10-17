/**
 * @module as-graph/mastra/MastraObservability
 * @summary The mastra engine observability layer with the langfuse default
 * target and the OUR-node isolation exporter (SAA-836 O1).
 * @description Mastra observability is configured **on the mastra engine**:
 * the mastra runtime's own observability entrypoint catches every signal the
 * engine emits (workflow runs/steps, agent runs, model generations, tool
 * calls, logs, metrics, scores) and exports them, by default and always, to
 * the deployed langfuse target through mastra's official
 * `@mastra/langfuse` exporter. On top of the engine-wide export, the decaf
 * node observability exporter implements OUR observability layer: it receives
 * every exported event, attributes each trace to the canonical graph node it
 * belongs to (the compiler stamps a `decafNode` origin onto every mastra step
 * it translates), and scopes OUR-node signals separately from engine-internal
 * signals, so OUR nodes remain isolatable in OUR observability while mastra
 * catches everything on its engine.
 *
 * Wiring is environment-driven (SAA-836 S1/O1): `MASTRA__OBSERVABILITY__*`
 * carries the non-secret config from `.env`; the langfuse credentials are
 * referenced **by name only** from the user-supplied `.env.secret` (tracked
 * `.env.secret.template`, gate C) and the layer **fails closed** when they
 * are missing — no unauthenticated trace export is ever attempted.
 *
 * R2 justification (direct-library wrap): trace export to langfuse has no
 * decaf-service equivalent — tracing spans are a mastra-native engine concern
 * — so the mastra-official `@mastra/observability` registry and
 * `@mastra/langfuse` exporter are wrapped directly instead of reimplementing
 * an OTel exporter inside decaf.
 */
import { Logging } from "@decaf-ts/logging";
import type { Logger } from "@decaf-ts/logging";
// SAA-836 O1 (R2 wrap justification recorded in the module docs): mastra's
// official observability registry and langfuse exporter are wrapped directly —
// trace export has no decaf-service equivalent. Static imports keep the C11
// no-dynamic-import invariant for src/mastra/**.
import { LangfuseExporter } from "@mastra/langfuse";
import {
  DefaultObservabilityInstance,
  Observability,
} from "@mastra/observability";
import {
  MASTRA_DEFAULT_LANGFUSE_ENDPOINT,
  MastraEnvironment,
  assertMastraObservabilityCredentials,
} from "./MastraEnvironment";

/** The mastra runtime surface the observability layer attaches through
 * (`@mastra/core`'s `Mastra.registerExporter`). Real mastra runtimes always
 * expose it; duck-typed test doubles do not, and for those the wiring is
 * skipped so the general engine keeps booting them unchanged.
 */
export const GRAPH_MASTRA_OBSERVABILITY_RUNTIME_METHOD = "registerExporter";

/** Canonical attribute key the compiler stamps onto every translated mastra
 * step so exported spans carry the OUR-node origin. */
export const MASTRA_DECAF_NODE_ORIGIN_KEY = "decafNode";

/** Resolved mastra observability configuration (SAA-836 O1). */
export interface MastraObservabilityConfig {
  /** Whether the observability layer is wired at engine boot. */
  enabled: boolean;
  /** The service name attached to every exported trace. */
  serviceName: string;
  /** Optional deployment environment tag attached to exported traces. */
  environment: string;
  langfuse: {
    /** The langfuse endpoint traces are exported to (non-secret). */
    endpoint: string;
    /** The name of the `.env.secret` variable carrying the langfuse public key. */
    publicKeyEnv: string;
    /** The name of the `.env.secret` variable carrying the langfuse secret key. */
    secretKeyEnv: string;
  };
}

/**
 * Reads the mastra observability configuration from the accumulated mastra
 * environment (the `MASTRA__OBSERVABILITY__*` overrides are already applied by
 * {@link MastraEnvironment}).
 *
 * @returns The resolved observability configuration.
 */
export function resolveMastraObservabilityConfig(): MastraObservabilityConfig {
  const source = MastraEnvironment.mastra.observability;
  return {
    enabled: source.enabled,
    serviceName: source.serviceName || "as-graph-mastra",
    environment: source.environment ?? "",
    langfuse: {
      endpoint: source.langfuse.endpoint || MASTRA_DEFAULT_LANGFUSE_ENDPOINT,
      publicKeyEnv:
        source.langfuse.publicKeyEnv || "LANGFUSE_PUBLIC_KEY",
      secretKeyEnv:
        source.langfuse.secretKeyEnv || "LANGFUSE_SECRET_KEY",
    },
  };
}

/** The OUR-node origin the compiler stamps onto a translated mastra step. */
export interface MastraDecafNodeOrigin {
  /** The canonical graph node id the step was translated from. */
  id: string;
  /** The canonical graph node kind the step was translated from. */
  kind: string;
}

/** A minimal exported-span surface the isolation classifier reads (duck-typed
 * against `@mastra/core/observability`'s `AnyExportedSpan` so the classifier
 * stays usable without importing the mastra runtime). */
export interface MastraExportedSpanLike {
  id: string;
  traceId: string;
  name: string;
  type?: string;
  entityType?: string;
  entityId?: string;
  attributes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Resolves the OUR-node origin an exported span carries **by metadata**, when
 * any. The origin is stamped by the workflow compiler under
 * {@link MASTRA_DECAF_NODE_ORIGIN_KEY} on the step's entry metadata.
 *
 * @param span - The exported span to classify.
 * @returns The OUR-node origin, or `undefined` for engine-internal spans.
 */
export function decafNodeOriginOf(
  span: MastraExportedSpanLike | undefined
): MastraDecafNodeOrigin | undefined {
  if (!span) return undefined;
  const attributes = span.attributes;
  if (attributes && typeof attributes === "object") {
    const entryMetadata = attributes["entryMetadata"];
    if (entryMetadata && typeof entryMetadata === "object") {
      const origin = (entryMetadata as Record<string, unknown>)[
        MASTRA_DECAF_NODE_ORIGIN_KEY
      ];
      if (
        origin &&
        typeof origin === "object" &&
        typeof (origin as Record<string, unknown>)["id"] === "string" &&
        typeof (origin as Record<string, unknown>)["kind"] === "string"
      ) {
        return origin as MastraDecafNodeOrigin;
      }
    }
  }
  return undefined;
}

/** Mastra names every `WORKFLOW_STEP` span `workflow step: '<stepId>'`, where
 * the step id is the canonical node id the compiler translated. */
const MASTRA_WORKFLOW_STEP_NAME_PATTERN = /^workflow step: '(.+)'$/;

/**
 * The OUR-node isolation exporter (SAA-836 O1). Implements mastra's
 * `ObservabilityExporter` contract on top of OUR observability layer: every
 * event the mastra engine exports is received here and logged through the
 * decaf logger, attributed to the canonical graph node it belongs to when the
 * span carries the compiler-stamped `decafNode` origin — so OUR-node signals
 * are isolatable in OUR observability (`decaf-node` scope) from
 * engine-internal signals (`decaf-engine` scope) while mastra still catches
 * everything on its engine.
 *
 * The exporter never throws into the engine's export pipeline: a logging
 * failure is swallowed so observability cannot break a run.
 */
export class DecafNodeObservabilityExporter {
  /** The exporter name mastra registers. */
  readonly name = "decaf-node-observability";

  private readonly logger: Logger;

  /** Canonical node origins known to the isolation classifier, keyed by node
   * id. The backend tracks the executed document's nodes per run. */
  private readonly knownNodes = new Map<string, MastraDecafNodeOrigin>();

  constructor(logger?: Logger) {
    this.logger = logger ?? Logging.for("MastraObservability");
  }

  /**
   * Tracks the canonical nodes of a document about to run, so the isolation
   * classifier can attribute mastra's `workflow step: '<stepId>'` spans (the
   * step id is the canonical node id) to their OUR-node origin.
   *
   * @param nodes - The canonical nodes of the document being executed.
   */
  trackNodes(nodes: readonly { id: string; kind: string }[]): void {
    for (const node of nodes) {
      this.knownNodes.set(node.id, { id: node.id, kind: node.kind });
    }
  }

  /**
   * Classifies an exported span: the OUR-node origin when the span belongs to
   * a canonical graph node (via the compiler-stamped entry metadata or a
   * mastra workflow-step span naming a tracked canonical node id),
   * `undefined` for engine-internal spans.
   *
   * @param span - The exported span to classify.
   * @returns The OUR-node origin, or `undefined`.
   */
  originOf(span: MastraExportedSpanLike | undefined): MastraDecafNodeOrigin | undefined {
    const byMetadata = decafNodeOriginOf(span);
    if (byMetadata) return byMetadata;
    const name = span?.name;
    if (typeof name !== "string") return undefined;
    const match = MASTRA_WORKFLOW_STEP_NAME_PATTERN.exec(name);
    if (!match) return undefined;
    return this.knownNodes.get(match[1]);
  }

  /** The engine-scope logger for signals without an OUR-node origin. */
  private engineFor(span: MastraExportedSpanLike | undefined): Logger {
    if (!this.originOf(span)) {
      return this.logger.for({ scope: "decaf-engine" });
    }
    return this.logger.for({ scope: "decaf-node" });
  }

  /**
   * Exports a tracing event into OUR observability layer, attributed to the
   * canonical node when the span belongs to one.
   *
   * @param event - The tracing event mastra's export pipeline emitted.
   */
  async exportTracingEvent(event: {
    type: string;
    exportedSpan?: MastraExportedSpanLike;
  }): Promise<void> {
    try {
      const span = event.exportedSpan;
      const origin = this.originOf(span);
      const logger = this.engineFor(span).for({
        spanType: span?.type,
        ...(span?.traceId ? { traceId: span.traceId } : {}),
        ...(span?.id ? { spanId: span.id } : {}),
        ...(origin ? { nodeId: origin.id, nodeKind: origin.kind } : {}),
      });
      logger.info(
        `[mastra-observability] ${event.type} ${span?.name ?? "<unknown>"}${origin ? ` (node ${origin.id}, kind ${origin.kind})` : ""}`
      );
    } catch {
      // OUR observability must never break the engine's export pipeline.
    }
  }

  /** Aliased mastra tracing-event hook (pipeline calls both spellings). */
  async onTracingEvent(event: {
    type: string;
    exportedSpan?: MastraExportedSpanLike;
  }): Promise<void> {
    await this.exportTracingEvent(event);
  }

  /**
   * Exports a log event into OUR observability layer.
   *
   * @param event - The log event mastra's export pipeline emitted.
   */
  async onLogEvent(event: { message?: unknown; [key: string]: unknown }): Promise<void> {
    try {
      this.logger.for({ scope: "decaf-engine", signal: "log" }).info(
        `[mastra-observability] log ${JSON.stringify(event?.message ?? event)}`
      );
    } catch {
      // Never break the export pipeline.
    }
  }

  /**
   * Exports a metric event into OUR observability layer.
   *
   * @param event - The metric event mastra's export pipeline emitted.
   */
  async onMetricEvent(event: { [key: string]: unknown }): Promise<void> {
    try {
      this.logger
        .for({ scope: "decaf-engine", signal: "metric" })
        .info(`[mastra-observability] metric ${JSON.stringify(event)}`);
    } catch {
      // Never break the export pipeline.
    }
  }

  /**
   * Exports a score event into OUR observability layer.
   *
   * @param event - The score event mastra's export pipeline emitted.
   */
  async onScoreEvent(event: { [key: string]: unknown }): Promise<void> {
    try {
      this.logger
        .for({ scope: "decaf-engine", signal: "score" })
        .info(`[mastra-observability] score ${JSON.stringify(event)}`);
    } catch {
      // Never break the export pipeline.
    }
  }

  /**
   * Exports an exporter-pipeline drop event into OUR observability layer.
   *
   * @param event - The drop event mastra's export pipeline emitted.
   */
  async onDroppedEvent(event: { [key: string]: unknown }): Promise<void> {
    try {
      this.logger
        .for({ scope: "decaf-engine", signal: "drop" })
        .warn(`[mastra-observability] dropped ${JSON.stringify(event)}`);
    } catch {
      // Never break the export pipeline.
    }
  }

  /** No buffered state: flush resolves immediately. */
  async flush(): Promise<void> {
    /* nothing buffered */
  }

  /** No external resources held: shutdown resolves immediately. */
  async shutdown(): Promise<void> {
    /* nothing to release */
  }
}

/** The live observability wiring attached to a mastra runtime. */
export interface MastraObservabilityHandle {
  /** The OUR-node isolation exporter registered on the runtime. */
  decafExporter: DecafNodeObservabilityExporter;
  /** Flushes every registered exporter (used at engine dispose). */
  flush(): Promise<void>;
  /** Shuts every registered exporter down and releases their resources. */
  shutdown(): Promise<void>;
}

/**
 * Wires the mastra observability layer onto a real mastra runtime
 * (SAA-836 O1). When the observability lane is disabled, or when the runtime
 * exposes no mastra `registerExporter` surface (a duck-typed test double,
 * never a real `@mastra/core` runtime), the runtime is left untouched and
 * `undefined` is returned. When enabled on a mastra-native runtime, wiring
 * fails closed on credentials: without the user-supplied langfuse
 * `.env.secret` credentials the layer throws
 * {@link GRAPH_MASTRA_OBSERVABILITY_CREDENTIALS_UNAVAILABLE} (gate C) —
 * langfuse is the default and always-present target, so no degraded
 * unauthenticated export path exists.
 *
 * The langfuse exporter is mastra's official `@mastra/langfuse`
 * `LangfuseExporter` (R2 wrap justification recorded in the module docs). The
 * OUR-node isolation exporter is registered alongside it so OUR nodes stay
 * isolatable in OUR observability layer.
 *
 * @param runtime - The wired mastra runtime (a real `@mastra/core` `Mastra`).
 * @param env - The runtime environment bag the credentials are read from;
 *   defaults to `process.env`.
 * @returns The observability handle, or `undefined` when the lane is disabled
 *   or the runtime is not mastra-native.
 * @throws {GraphExecutionError} when the lane is enabled on a mastra-native
 *   runtime but the langfuse credentials are unavailable.
 */
export async function wireMastraObservability(
  runtime: unknown,
  env: Record<string, string | undefined> = globalThis.process?.env ?? {}
): Promise<MastraObservabilityHandle | undefined> {
  const config = resolveMastraObservabilityConfig();
  if (!config.enabled) return undefined;
  if (
    !runtime ||
    typeof (runtime as Record<string, unknown>)[
      GRAPH_MASTRA_OBSERVABILITY_RUNTIME_METHOD
    ] !== "function"
  ) {
    return undefined;
  }
  // Gate C: fail closed without the user-supplied langfuse credentials. The
  // resolved names are returned; the values are only read into the exporter.
  const credentials = assertMastraObservabilityCredentials(env);
  const decafExporter = new DecafNodeObservabilityExporter();
  const langfuseExporter = new LangfuseExporter({
    // Gate C: the credential values are read from the user-supplied
    // `.env.secret` here and handed straight to the exporter; they are never
    // logged, persisted, or held elsewhere in the graph layer.
    publicKey: env[credentials.publicKeyEnv],
    secretKey: env[credentials.secretKeyEnv],
    baseUrl: config.langfuse.endpoint,
    ...(config.environment ? { environment: config.environment } : {}),
  });
  const registry = new Observability({
    configs: {},
  });
  const instance = new DefaultObservabilityInstance({
    name: "default",
    serviceName: config.serviceName,
    exporters: [],
  });
  // Bootstrap the real entrypoint over the runtime's no-op default, then add
  // both exporters to the resulting default instance. The first call
  // bootstraps (no-op → entrypoint, instance registered as default) and adds
  // the langfuse exporter; the second adds the OUR-node exporter to the now
  // real default instance.
  const register = (runtime as Record<string, unknown>)[
    "registerExporter"
  ] as (exporter: unknown, instance: unknown, entrypoint: unknown) => void;
  register.call(runtime, langfuseExporter, instance, registry);
  register.call(runtime, decafExporter, instance, registry);
  return {
    decafExporter,
    flush: async () => {
      for (const exporter of [langfuseExporter, decafExporter] as Array<{
        flush?: () => Promise<void>;
      }>) {
        await exporter.flush?.();
      }
    },
    shutdown: async () => {
      for (const exporter of [langfuseExporter, decafExporter] as Array<{
        shutdown?: () => Promise<void>;
      }>) {
        await exporter.shutdown?.();
      }
    },
  };
}
