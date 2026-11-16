/**
 * @module as-graph/engine/telemetry/GraphTelemetry
 * @summary Metrics and traces through the OpenTelemetry API.
 * @description Instrumentation uses `@opentelemetry/api` only, so it is a
 * no-op until a host installs a provider. {@link startGraphTelemetry} installs
 * one: metrics exposed as Prometheus text on `GET /graph/metrics`
 * (`GRAPH_METRICS=prometheus`, default), pushed over OTLP
 * (`GRAPH_METRICS=otlp`, endpoint `OTEL_EXPORTER_OTLP_ENDPOINT`), or both
 * (`GRAPH_METRICS=both`); traces exported over OTLP when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 *
 * Instruments: `graph_runs_started_total`, `graph_runs_finished_total`
 * {status}, `graph_run_duration_seconds` {status}, `graph_node_duration_seconds`
 * {kind,status}, `graph_runs_active`, `graph_run_queue_depth`,
 * `graph_run_queue_wait_seconds`, `graph_store_operation_seconds`
 * {store,op}, `graph_runs_pruned_total`, `graph_sse_subscribers`,
 * `graph_runs_rejected_total` {reason}.
 */
import {
  metrics,
  trace,
  SpanStatusCode,
  type Attributes,
  type Span,
} from "@opentelemetry/api";

const meter = () => metrics.getMeter("@decaf-ts/as-graph");

/** Lazily-created instruments (so a provider installed later is honoured). */
class Instruments {
  private cache = new Map<string, unknown>();

  private get<T>(name: string, make: () => T): T {
    if (!this.cache.has(name)) this.cache.set(name, make());
    return this.cache.get(name) as T;
  }

  reset(): void {
    this.cache.clear();
  }

  get runsStarted() {
    return this.get("runsStarted", () =>
      meter().createCounter("graph_runs_started_total", { description: "Runs created" })
    );
  }
  get runsFinished() {
    return this.get("runsFinished", () =>
      meter().createCounter("graph_runs_finished_total", { description: "Runs finished, by status" })
    );
  }
  get runsRejected() {
    return this.get("runsRejected", () =>
      meter().createCounter("graph_runs_rejected_total", {
        description: "Run creations rejected (quota, backpressure, concurrency)",
      })
    );
  }
  get runsPruned() {
    return this.get("runsPruned", () =>
      meter().createCounter("graph_runs_pruned_total", { description: "Runs deleted by retention" })
    );
  }
  get runDuration() {
    return this.get("runDuration", () =>
      meter().createHistogram("graph_run_duration_seconds", { description: "Run duration", unit: "s" })
    );
  }
  get nodeDuration() {
    return this.get("nodeDuration", () =>
      meter().createHistogram("graph_node_duration_seconds", { description: "Node duration", unit: "s" })
    );
  }
  get queueWait() {
    return this.get("queueWait", () =>
      meter().createHistogram("graph_run_queue_wait_seconds", {
        description: "Time a run waited for a worker",
        unit: "s",
      })
    );
  }
  get storeOperation() {
    return this.get("storeOperation", () =>
      meter().createHistogram("graph_store_operation_seconds", {
        description: "Store operation latency",
        unit: "s",
      })
    );
  }
  get activeRuns() {
    return this.get("activeRuns", () =>
      meter().createUpDownCounter("graph_runs_active", { description: "Runs executing in this process" })
    );
  }
  get sseSubscribers() {
    return this.get("sseSubscribers", () =>
      meter().createUpDownCounter("graph_sse_subscribers", { description: "Open run event streams" })
    );
  }
}

/** The as-graph instruments. */
export const graphMetrics = new Instruments();

/** Registers the queue-depth gauge, read on every collection. */
export function observeGraphQueueDepth(depth: () => Promise<number>): void {
  const gauge = meter().createObservableGauge("graph_run_queue_depth", {
    description: "Runs waiting for a worker",
  });
  let last = 0;
  gauge.addCallback((result) => {
    void depth()
      .then((value) => {
        last = value;
      })
      .catch(() => undefined);
    result.observe(last);
  });
}

/** Times an async store operation into `graph_store_operation_seconds`. */
export async function timedGraphStoreOperation<T>(
  store: string,
  op: string,
  run: () => Promise<T>
): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } finally {
    graphMetrics.storeOperation.record((performance.now() - started) / 1000, { store, op });
  }
}

/** The as-graph tracer. */
export function graphTracer() {
  return trace.getTracer("@decaf-ts/as-graph");
}

/**
 * Runs `work` inside an active span; errors mark the span and rethrow.
 *
 * @param name - Span name (`graph.run`, `graph.node`, …).
 * @param attributes - Span attributes.
 * @param work - The traced work.
 */
export async function withGraphSpan<T>(
  name: string,
  attributes: Attributes,
  work: (span: Span) => Promise<T>
): Promise<T> {
  return graphTracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error)?.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Handle on the installed telemetry providers. */
export interface GraphTelemetryHandle {
  /** Prometheus text exposition of the current metrics, when enabled. */
  prometheus?: () => Promise<string>;
  /** Flushes and stops the providers. */
  shutdown(): Promise<void>;
}

/**
 * Installs the metrics (and, with an OTLP endpoint, trace) providers.
 *
 * @param env - The environment (default `process.env`).
 * @returns The handle, with a Prometheus renderer when Prometheus is enabled.
 */
export async function startGraphTelemetry(
  env: NodeJS.ProcessEnv = process.env
): Promise<GraphTelemetryHandle> {
  const mode = (env["GRAPH_METRICS"] ?? "prometheus").trim().toLowerCase();
  const endpoint = env["OTEL_EXPORTER_OTLP_ENDPOINT"]?.trim();
  const { MeterProvider, PeriodicExportingMetricReader } = await import(
    "@opentelemetry/sdk-metrics"
  );
  const readers: unknown[] = [];
  let prometheus: GraphTelemetryHandle["prometheus"];
  if (mode === "prometheus" || mode === "both") {
    const { PrometheusExporter, PrometheusSerializer } = await import(
      "@opentelemetry/exporter-prometheus"
    );
    const exporter = new PrometheusExporter({ preventServerStart: true });
    readers.push(exporter);
    const serializer = new PrometheusSerializer();
    prometheus = async () => {
      const { resourceMetrics } = await exporter.collect();
      return serializer.serialize(resourceMetrics);
    };
  }
  if ((mode === "otlp" || mode === "both") && endpoint) {
    const { OTLPMetricExporter } = await import(
      "@opentelemetry/exporter-metrics-otlp-http"
    );
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/metrics` }),
        exportIntervalMillis: Number(env["GRAPH_METRICS_EXPORT_MS"] ?? 15_000),
      })
    );
  }
  const meterProvider =
    mode === "off" ? undefined : new MeterProvider({ readers: readers as never });
  if (meterProvider) {
    metrics.setGlobalMeterProvider(meterProvider);
    graphMetrics.reset();
  }

  let tracerShutdown: (() => Promise<void>) | undefined;
  if (endpoint) {
    const [{ NodeTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }] =
      await Promise.all([
        import("@opentelemetry/sdk-trace-node"),
        import("@opentelemetry/exporter-trace-otlp-http"),
      ]);
    const provider = new NodeTracerProvider({
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` })
        ),
      ],
    });
    provider.register();
    tracerShutdown = () => provider.shutdown();
  }

  return {
    ...(prometheus ? { prometheus } : {}),
    async shutdown() {
      await meterProvider?.shutdown().catch(() => undefined);
      await tracerShutdown?.().catch(() => undefined);
    },
  };
}
