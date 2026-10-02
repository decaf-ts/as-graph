/**
 * @module as-graph/log/GraphRunLogger
 * @summary ctx.logger for graph node execution with structured SSE forwarding.
 * @description A decaf-ts {@link Logger} that attaches the DECAF-48 run
 * attributes (`nodeId` / `workflowId` / `runId` / `user`) through
 * DECAF-9 `logger.for({...})`, renders through the standard MiniLogger
 * pipeline, and forwards the structured {@link GraphRunLogEntry} to the
 * graph execution Observable so run logs stream over SSE on the existing
 * `/graph/events` pipeline (no second out-of-band channel).
 */
import { Logging } from "@decaf-ts/logging";
import type { Logger, LogMeta, StringLike } from "@decaf-ts/logging";

import {
  GraphLogAttribute,
  GraphExecutionEventType,
} from "../shared/graph";
import type { GraphRunLogEntry, GraphExecutionEvent } from "../shared/graph";

/**
 * Signature of the context's event emitter used to forward log entries onto
 * the existing graph execution Observable.
 */
export type GraphLogForwardFn = (
  event: Partial<GraphExecutionEvent>
) => Promise<void>;

/**
 * Options for constructing a {@link GraphRunLogger}.
 */
export interface GraphRunLoggerOptions {
  runId: string;
  workflowId: string;
  nodeId: string;
  user?: string | null;
  /** Granted roles of the authenticated principal, bound as a custom attribute. */
  roles?: string[];
  /** Granted namespaces of the authenticated principal, bound as a custom attribute. */
  namespaces?: string[];
  /** Authenticated organization/tenant, bound as a custom attribute. */
  organization?: string;
  /** Client IP address, bound as a custom attribute. */
  ip?: string;
  /**
   * Callback that forwards a structured log entry to the graph execution
   * Observable (emits a `GRAPH_RUN_LOG` event). Errors are swallowed.
   */
  forward: GraphLogForwardFn;
}

/**
 * Logger used by graph node executors (`ctx.logger`).
 *
 * Wraps the shared MiniLogger pipeline so the DECAF-48 attributes render as
 * discrete custom attributes in the formatted output, and forwards each
 * structured entry through {@link GraphRunLoggerOptions.forward} so the SSE
 * log channel (`graph.run.log`) receives the level/message/attributes/
 * timestamp payload.
 */
export class GraphRunLogger implements Logger {
  private readonly inner: Logger;
  private readonly baseOptions: GraphRunLoggerOptions;

  constructor(options: GraphRunLoggerOptions) {
    this.baseOptions = options;
    this.inner = Logging.for("GraphRun").for(
      this.attributeConfig(options) as Partial<any>
    );
  }

  /**
   * Produces the `Partial<LoggingConfig>` carrying the DECAF-48 attributes
   * so the LogParameter descriptors render them (DECAF-9 §4.6).
   */
  private attributeConfig(options: GraphRunLoggerOptions): Record<string, unknown> {
    return {
      [GraphLogAttribute.NODE_ID]: options.nodeId,
      [GraphLogAttribute.WORKFLOW_ID]: options.workflowId,
      [GraphLogAttribute.RUN_ID]: options.runId,
      [GraphLogAttribute.USER]: options.user ?? null,
      [GraphLogAttribute.ROLES]: options.roles,
      [GraphLogAttribute.NAMESPACES]: options.namespaces,
      [GraphLogAttribute.ORGANIZATION]: options.organization,
      [GraphLogAttribute.IP]: options.ip,
    };
  }

  /**
   * Emits a structured log entry synchronously (forward is fire-and-forget).
   *
   * @param {string} level - The log level to emit at.
   * @param {StringLike} msg - The log message.
   * @param {LogMeta} [meta] - Optional structured metadata.
   */
  private emit(level: GraphRunLogEntry["level"], msg: StringLike, meta?: LogMeta): void {
    const rawMessage =
      typeof msg === "string"
        ? msg
        : msg instanceof Error
          ? msg.message
          : String(msg);
    const entry: GraphRunLogEntry = {
      level,
      message: rawMessage,
      timestamp: new Date().toISOString(),
      runId: this.baseOptions.runId,
      workflowId: this.baseOptions.workflowId,
      nodeId: this.baseOptions.nodeId,
      user: this.baseOptions.user ?? null,
    };
    if (this.baseOptions.roles !== undefined) {
      entry.roles = this.baseOptions.roles;
    }
    if (this.baseOptions.namespaces !== undefined) {
      entry.namespaces = this.baseOptions.namespaces;
    }
    if (this.baseOptions.organization !== undefined) {
      entry.organization = this.baseOptions.organization;
    }
    if (this.baseOptions.ip !== undefined) {
      entry.ip = this.baseOptions.ip;
    }
    if (meta !== undefined) {
      entry.payload = meta;
    }
    this.baseOptions.forward({
      type: GraphExecutionEventType.GRAPH_RUN_LOG,
      payload: entry,
    }).catch(() => {
      // Log forwarding must never crash node execution.
    });
    const dispatch: Record<
      GraphRunLogEntry["level"],
      (msg: StringLike, meta?: LogMeta) => void
    > = {
      benchmark: (m, x) => this.inner.benchmark(m, x),
      fatal: (m, x) => this.inner.fatal(m, x),
      critical: (m, x) => this.inner.critical(m, x),
      silly: (m, x) => this.inner.silly(m, x),
      trace: (m, x) => this.inner.trace(m, x),
      verbose: (m, x) => this.inner.verbose(m, x),
      info: (m, x) => this.inner.info(m, x),
      warn: (m, x) => this.inner.warn(m, x),
      error: (m, x) => this.inner.error(m, x),
      debug: (m, x) => this.inner.debug(m, x),
    };
    dispatch[level](rawMessage, meta);
  }

  /** @inheritdoc */
  benchmark(msg: StringLike, meta?: LogMeta): void {
    this.emit("benchmark", msg, meta);
  }

  /** @inheritdoc */
  fatal(msg: StringLike | Error, error?: Error | LogMeta, meta?: LogMeta): void {
    this.emit("fatal", msg as StringLike, (error as LogMeta) ?? meta);
  }

  /** @inheritdoc */
  critical(
    msg: StringLike | Error,
    error?: Error | LogMeta,
    meta?: LogMeta
  ): void {
    this.emit("critical", msg as StringLike, (error as LogMeta) ?? meta);
  }

  /** @inheritdoc */
  silly(msg: StringLike, verbosity?: number | LogMeta, meta?: LogMeta): void {
    this.emit("silly", msg, typeof verbosity === "object" ? verbosity : meta);
  }

  /** @inheritdoc */
  trace(msg: StringLike, meta?: LogMeta): void {
    this.emit("trace", msg, meta);
  }

  /** @inheritdoc */
  verbose(msg: StringLike, verbosity?: number | LogMeta, meta?: LogMeta): void {
    this.emit("verbose", msg, typeof verbosity === "object" ? verbosity : meta);
  }

  /** @inheritdoc */
  info(msg: StringLike, meta?: LogMeta): void {
    this.emit("info", msg, meta);
  }

  /** @inheritdoc */
  error(msg: StringLike | Error, error?: Error | LogMeta, meta?: LogMeta): void {
    this.emit("error", msg as StringLike, (error as LogMeta) ?? meta);
  }

  /** @inheritdoc */
  warn(msg: StringLike, meta?: LogMeta): void {
    this.emit("warn", msg, meta);
  }

  /** @inheritdoc */
  debug(msg: StringLike, meta?: LogMeta): void {
    this.emit("debug", msg, meta);
  }

  /** @inheritdoc */
  action(action: string, meta?: LogMeta): void;
  /** @inheritdoc */
  action(action: string, code: number, meta?: LogMeta): void;
  /**
   * Records an action log entry on the wrapped MiniLogger; passes through
   * unchanged (not forwarded as a structured run event).
   *
   * @param {string} action - Action name to record.
   * @param {number | LogMeta} [codeOrMeta] - Status code (first overload) or metadata (second overload).
   * @param {LogMeta} [meta] - Optional structured metadata.
   * @return {void}
   */
  action(
    action: string,
    codeOrMeta?: number | LogMeta,
    meta?: LogMeta
  ): void {
    (this.inner.action as any)(action, codeOrMeta, meta);
  }

  /** @inheritdoc */
  setConfig(): void {
    // Configuration is owned by the wrapped MiniLogger; nothing to apply.
  }

  /**
   * @inheritdoc
   *
   * @param {string} [_method] - The log method name or target to configure.
   * @param {object} [_config] - Optional configuration applied to the method.
   * @param {...any} _args - Additional configuration arguments.
   */
  for(
    _method?:
      | string
      | ((...args: any[]) => any)
      | { new (...args: any[]): any }
      | object
      | Partial<any>,
    _config?: Partial<any>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ..._args: any[]
  ): this {
    void _method;
    void _config;
    return this;
  }

  /** @inheritdoc */
  clear(): this {
    return this;
  }

  /** @inheritdoc */
  get root(): string[] {
    return this.inner.root;
  }
}
