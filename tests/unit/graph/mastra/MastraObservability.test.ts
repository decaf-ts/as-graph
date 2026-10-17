/**
 * @module as-graph/tests/unit/graph/mastra/MastraObservability
 * @summary Driver tests for the mastra engine observability layer (SAA-836 O1,
 * SAA-891): the OUR-node isolation exporter, the fail-closed langfuse
 * credential gate, the `registerExporter` wiring, and the compiler's
 * `decafNode` origin stamp.
 * @description Real-vs-injected note. **Real**: the production
 * `DecafNodeObservabilityExporter`, `decafNodeOriginOf`,
 * `assertMastraObservabilityCredentials`, `resolveMastraObservabilityConfig`,
 * `wireMastraObservability`, the real `@mastra/langfuse` `LangfuseExporter`
 * construction, and the real `@mastra/observability` registry/instance. The
 * runtime in the wiring tests is a minimal duck-typed double exposing only
 * mastra's `registerExporter` surface (exactly what
 * {@link wireMastraObservability} requires) — the real `@mastra/core` runtime
 * path is exercised end-to-end by
 * `tests/integration/mastra/MastraObservabilityDriverRun.test.ts`. The
 * exporter logger is injected so scope attribution is observed on recorded
 * calls instead of parsed out of the global log stream.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import { LangfuseExporter } from "@mastra/langfuse";
import {
  Observability,
  DefaultObservabilityInstance,
} from "@mastra/observability";
import type { Logger } from "@decaf-ts/logging";
import {
  DecafNodeObservabilityExporter,
  decafNodeOriginOf,
  GRAPH_MASTRA_OBSERVABILITY_RUNTIME_METHOD,
  MASTRA_DECAF_NODE_ORIGIN_KEY,
  resolveMastraObservabilityConfig,
  wireMastraObservability,
} from "../../../../src/mastra/MastraObservability";
import {
  GRAPH_MASTRA_OBSERVABILITY_CREDENTIALS_UNAVAILABLE,
  MASTRA_DEFAULT_LANGFUSE_ENDPOINT,
  MASTRA_DEFAULT_LANGFUSE_PUBLIC_KEY_ENV,
  MASTRA_DEFAULT_LANGFUSE_SECRET_KEY_ENV,
  assertMastraObservabilityCredentials,
} from "../../../../src/mastra/MastraEnvironment";
import { GraphExecutionError } from "../../../../src/engine/errors/GraphExecutionError";
import { MastraWorkflowCompiler } from "../../../../src/mastra/MastraWorkflowCompiler";
import { leafHandler, humanApprovalDocument, twoLeafDocument } from "./helpers";
/** The `MASTRA__OBSERVABILITY__*` override variables these tests touch. */
const OBSERVABILITY_VARS = [
  "MASTRA__OBSERVABILITY__ENABLED",
  "MASTRA__OBSERVABILITY__SERVICE_NAME",
  "MASTRA__OBSERVABILITY__ENVIRONMENT",
  "MASTRA__OBSERVABILITY__LANGFUSE__ENDPOINT",
  "MASTRA__OBSERVABILITY__LANGFUSE__PUBLIC_KEY_ENV",
  "MASTRA__OBSERVABILITY__LANGFUSE__SECRET_KEY_ENV",
] as const;

afterEach(() => {
  for (const name of OBSERVABILITY_VARS) {
    delete process.env[name];
  }
});

/** A recorded log call: the scoped attribute bag plus the rendered message. */
interface RecordedLogCall {
  [key: string]: unknown;
  level: "info" | "warn";
  message: string;
}

/** A chainable logger double recording every `.info()`/`.warn()` call with
 * the attribute bags accumulated through the `.for()` chain. */
function recordingLogger(): { logger: Logger; calls: RecordedLogCall[] } {
  const calls: RecordedLogCall[] = [];
  let current: Record<string, unknown> = {};
  const sink = () => ({
    for: (attrs: Record<string, unknown>) => {
      current = { ...current, ...attrs };
      return sink();
    },
    info: (message: unknown) =>
      calls.push({ ...current, level: "info", message: String(message) }),
    warn: (message: unknown) =>
      calls.push({ ...current, level: "warn", message: String(message) }),
  });
  const logger = {
    for: (attrs: Record<string, unknown>) => {
      current = { ...attrs };
      return sink();
    },
  } as unknown as Logger;
  return { logger, calls };
}

/** A minimal duck-typed mastra-native runtime: only `registerExporter`. */
function fakeMastraNativeRuntime(): {
  runtime: unknown;
  registrations: Array<{
    exporter: unknown;
    instance: unknown;
    entrypoint: unknown;
  }>;
} {
  const registrations: Array<{
    exporter: unknown;
    instance: unknown;
    entrypoint: unknown;
  }> = [];
  const runtime = {
    [GRAPH_MASTRA_OBSERVABILITY_RUNTIME_METHOD]: (
      exporter: unknown,
      instance: unknown,
      entrypoint: unknown
    ) => {
      registrations.push({ exporter, instance, entrypoint });
    },
  };
  return { runtime, registrations };
}

/** Fake langfuse credentials for a `.env.secret`-shaped environment bag. */
const CREDENTIAL_ENV_BAG = {
  LANGFUSE_PUBLIC_KEY: "test-public-key",
  LANGFUSE_SECRET_KEY: "test-secret-key",
};

describe("MastraObservability config resolution (SAA-836 O1)", () => {
  it("resolves the defaults: enabled, default service name, langfuse cloud target", () => {
    const config = resolveMastraObservabilityConfig();
    expect(config.enabled).toBe(true);
    expect(config.serviceName).toBe("as-graph-mastra");
    expect(config.environment).toBe("");
    expect(config.langfuse.endpoint).toBe(MASTRA_DEFAULT_LANGFUSE_ENDPOINT);
    expect(config.langfuse.publicKeyEnv).toBe(
      MASTRA_DEFAULT_LANGFUSE_PUBLIC_KEY_ENV
    );
    expect(config.langfuse.secretKeyEnv).toBe(
      MASTRA_DEFAULT_LANGFUSE_SECRET_KEY_ENV
    );
  });

  it("applies the MASTRA__OBSERVABILITY__* runtime overrides", () => {
    process.env["MASTRA__OBSERVABILITY__ENABLED"] = "false";
    process.env["MASTRA__OBSERVABILITY__SERVICE_NAME"] = "override-svc";
    process.env["MASTRA__OBSERVABILITY__ENVIRONMENT"] = "staging";
    process.env["MASTRA__OBSERVABILITY__LANGFUSE__ENDPOINT"] =
      "http://127.0.0.1:9";
    process.env["MASTRA__OBSERVABILITY__LANGFUSE__PUBLIC_KEY_ENV"] = "MY_PK";
    process.env["MASTRA__OBSERVABILITY__LANGFUSE__SECRET_KEY_ENV"] = "MY_SK";

    const config = resolveMastraObservabilityConfig();
    expect(config.enabled).toBe(false);
    expect(config.serviceName).toBe("override-svc");
    expect(config.environment).toBe("staging");
    expect(config.langfuse.endpoint).toBe("http://127.0.0.1:9");
    expect(config.langfuse.publicKeyEnv).toBe("MY_PK");
    expect(config.langfuse.secretKeyEnv).toBe("MY_SK");
  });
});

describe("decafNodeOriginOf — metadata-origin resolution (SAA-836 O1)", () => {
  it("resolves the compiler-stamped entryMetadata origin", () => {
    const span = {
      id: "span-1",
      traceId: "trace-1",
      name: "workflow step: 'first'",
      attributes: {
        entryMetadata: {
          [MASTRA_DECAF_NODE_ORIGIN_KEY]: { id: "first", kind: "test.leaf" },
        },
      },
    };
    expect(decafNodeOriginOf(span)).toEqual({ id: "first", kind: "test.leaf" });
  });

  it("returns undefined for engine-internal spans and malformed shapes", () => {
    expect(decafNodeOriginOf(undefined)).toBeUndefined();
    // No attributes at all.
    expect(
      decafNodeOriginOf({ id: "s", traceId: "t", name: "x" })
    ).toBeUndefined();
    // entryMetadata without the origin key.
    expect(
      decafNodeOriginOf({
        id: "s",
        traceId: "t",
        name: "x",
        attributes: { entryMetadata: { other: 1 } },
      })
    ).toBeUndefined();
    // A malformed origin (non-string id/kind) is not trusted.
    expect(
      decafNodeOriginOf({
        id: "s",
        traceId: "t",
        name: "x",
        attributes: {
          entryMetadata: { [MASTRA_DECAF_NODE_ORIGIN_KEY]: { id: 1, kind: 2 } },
        },
      })
    ).toBeUndefined();
  });
});

describe("DecafNodeObservabilityExporter — OUR-node isolation (SAA-836 O1)", () => {
  it("resolves a workflow-step span to its tracked node origin after trackNodes", () => {
    const exporter = new DecafNodeObservabilityExporter();
    // Before tracking, a workflow-step span naming a node id is unattributed.
    expect(
      exporter.originOf({
        id: "s",
        traceId: "t",
        name: "workflow step: 'first'",
      })
    ).toBeUndefined();
    exporter.trackNodes([
      { id: "first", kind: "test.leaf" },
      { id: "second", kind: "test.leaf" },
    ]);
    expect(
      exporter.originOf({ id: "s", traceId: "t", name: "workflow step: 'first'" })
    ).toEqual({ id: "first", kind: "test.leaf" });
    expect(
      exporter.originOf({
        id: "s",
        traceId: "t",
        name: "workflow step: 'second'",
      })
    ).toEqual({ id: "second", kind: "test.leaf" });
  });

  it("keeps the workflow_run root span engine-scoped (no origin)", () => {
    const exporter = new DecafNodeObservabilityExporter();
    exporter.trackNodes([{ id: "first", kind: "test.leaf" }]);
    expect(
      exporter.originOf({
        id: "root",
        traceId: "t",
        name: "workflow run: 'doc-1'",
        type: "workflow_run",
      })
    ).toBeUndefined();
  });

  it("prefers the stamped metadata origin over the name-pattern path", () => {
    const exporter = new DecafNodeObservabilityExporter();
    exporter.trackNodes([{ id: "tracked", kind: "tracked.kind" }]);
    expect(
      exporter.originOf({
        id: "s",
        traceId: "t",
        name: "workflow step: 'tracked'",
        attributes: {
          entryMetadata: {
            [MASTRA_DECAF_NODE_ORIGIN_KEY]: { id: "stamped", kind: "stamped.kind" },
          },
        },
      })
    ).toEqual({ id: "stamped", kind: "stamped.kind" });
  });

  it("scopes OUR-node signals to decaf-node and engine signals to decaf-engine", async () => {
    const { logger, calls } = recordingLogger();
    const exporter = new DecafNodeObservabilityExporter(logger);
    exporter.trackNodes([{ id: "first", kind: "test.leaf" }]);

    await exporter.exportTracingEvent({
      type: "span_ended",
      exportedSpan: {
        id: "s1",
        traceId: "t1",
        name: "workflow step: 'first'",
        type: "workflow_step",
      },
    });
    await exporter.exportTracingEvent({
      type: "span_ended",
      exportedSpan: {
        id: "s2",
        traceId: "t1",
        name: "workflow run: 'doc-1'",
        type: "workflow_run",
      },
    });

    const nodeCall = calls.find((call) => call["scope"] === "decaf-node");
    const engineCall = calls.find((call) => call["scope"] === "decaf-engine");
    expect(nodeCall).toBeDefined();
    expect(nodeCall?.["nodeId"]).toBe("first");
    expect(nodeCall?.["nodeKind"]).toBe("test.leaf");
    expect(nodeCall?.["spanType"]).toBe("workflow_step");
    expect(nodeCall?.["traceId"]).toBe("t1");
    expect(engineCall).toBeDefined();
    expect(engineCall?.["nodeId"]).toBeUndefined();
    expect(engineCall?.["spanType"]).toBe("workflow_run");
    expect(String(engineCall?.message)).toContain("workflow run: 'doc-1'");
  });

  it("routes log, metric, score, and drop signals to the engine scope", async () => {
    const { logger, calls } = recordingLogger();
    const exporter = new DecafNodeObservabilityExporter(logger);
    await exporter.onLogEvent({ message: "hello" });
    await exporter.onMetricEvent({ metric: "m" });
    await exporter.onScoreEvent({ score: "s" });
    await exporter.onDroppedEvent({ reason: "r" });

    expect(calls.map((call) => call["scope"])).toEqual([
      "decaf-engine",
      "decaf-engine",
      "decaf-engine",
      "decaf-engine",
    ]);
    expect(calls.map((call) => call["signal"])).toEqual([
      "log",
      "metric",
      "score",
      "drop",
    ]);
    expect(calls.find((call) => call["signal"] === "drop")?.level).toBe("warn");
  });

  it("never throws into the engine export pipeline", async () => {
    const throwing = {
      for: () => {
        throw new Error("logger exploded");
      },
    };
    const exporter = new DecafNodeObservabilityExporter(throwing as unknown as Logger);
    await expect(
      exporter.exportTracingEvent({
        type: "span_ended",
        exportedSpan: { id: "s", traceId: "t", name: "workflow step: 'first'" },
      })
    ).resolves.toBeUndefined();
    await expect(exporter.onLogEvent({ message: "x" })).resolves.toBeUndefined();
    await expect(exporter.onMetricEvent({})).resolves.toBeUndefined();
    await expect(exporter.onScoreEvent({})).resolves.toBeUndefined();
    await expect(exporter.onDroppedEvent({})).resolves.toBeUndefined();
  });

  it("flush and shutdown resolve with nothing buffered", async () => {
    const exporter = new DecafNodeObservabilityExporter();
    await expect(exporter.flush()).resolves.toBeUndefined();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });
});

describe("assertMastraObservabilityCredentials — fail-closed gate (SAA-836 O1 gate C)", () => {
  it("fails closed with GRAPH_MASTRA_OBSERVABILITY_CREDENTIALS_UNAVAILABLE when the credentials are missing", () => {
    let caught: unknown;
    try {
      assertMastraObservabilityCredentials({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GraphExecutionError);
    const gate = caught as GraphExecutionError & {
      graphCode?: string;
      details?: { credentialEnvs?: string[] };
    };
    expect(gate.graphCode).toBe(
      GRAPH_MASTRA_OBSERVABILITY_CREDENTIALS_UNAVAILABLE
    );
    expect(gate.details?.credentialEnvs).toEqual([
      "LANGFUSE_PUBLIC_KEY",
      "LANGFUSE_SECRET_KEY",
    ]);
  });

  it("fails closed when only one of the two credentials is present", () => {
    let caught: unknown;
    try {
      assertMastraObservabilityCredentials({ LANGFUSE_PUBLIC_KEY: "pub" });
    } catch (error) {
      caught = error;
    }
    expect(
      (caught as { details?: { credentialEnvs?: string[] } })?.details
        ?.credentialEnvs
    ).toEqual(["LANGFUSE_SECRET_KEY"]);
  });

  it("passes when both credentials are present and returns only their names", () => {
    const resolved = assertMastraObservabilityCredentials(CREDENTIAL_ENV_BAG);
    expect(resolved).toEqual({
      publicKeyEnv: "LANGFUSE_PUBLIC_KEY",
      secretKeyEnv: "LANGFUSE_SECRET_KEY",
    });
    // Gate C: the resolved shape carries variable NAMES, never values.
    expect(JSON.stringify(resolved)).not.toContain("test-public-key");
    expect(JSON.stringify(resolved)).not.toContain("test-secret-key");
  });

  it("honours custom credential variable names from the environment", () => {
    process.env["MASTRA__OBSERVABILITY__LANGFUSE__PUBLIC_KEY_ENV"] = "MY_PK";
    process.env["MASTRA__OBSERVABILITY__LANGFUSE__SECRET_KEY_ENV"] = "MY_SK";
    let caught: unknown;
    try {
      assertMastraObservabilityCredentials({});
    } catch (error) {
      caught = error;
    }
    expect(
      (caught as { details?: { credentialEnvs?: string[] } })?.details
        ?.credentialEnvs
    ).toEqual(["MY_PK", "MY_SK"]);
    expect(
      assertMastraObservabilityCredentials({ MY_PK: "pub", MY_SK: "sec" })
    ).toEqual({ publicKeyEnv: "MY_PK", secretKeyEnv: "MY_SK" });
  });
});

describe("wireMastraObservability — exporter registration (SAA-836 O1)", () => {
  it("leaves the runtime untouched when the observability lane is disabled", async () => {
    process.env["MASTRA__OBSERVABILITY__ENABLED"] = "false";
    const { runtime, registrations } = fakeMastraNativeRuntime();
    await expect(
      wireMastraObservability(runtime, CREDENTIAL_ENV_BAG)
    ).resolves.toBeUndefined();
    expect(registrations).toHaveLength(0);
  });

  it("leaves a duck-typed (non mastra-native) runtime untouched even with credentials", async () => {
    const runtime = { addWorkflow: () => undefined };
    await expect(
      wireMastraObservability(runtime, CREDENTIAL_ENV_BAG)
    ).resolves.toBeUndefined();
  });

  it("fails closed on a mastra-native runtime without langfuse credentials", async () => {
    const { runtime } = fakeMastraNativeRuntime();
    let caught: unknown;
    try {
      await wireMastraObservability(runtime, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GraphExecutionError);
    expect((caught as { graphCode?: string }).graphCode).toBe(
      GRAPH_MASTRA_OBSERVABILITY_CREDENTIALS_UNAVAILABLE
    );
    expect(
      (caught as { details?: { credentialEnvs?: string[] } }).details
        ?.credentialEnvs
    ).toEqual(["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]);
  });

  it("registers the langfuse exporter and the OUR-node exporter on the runtime", async () => {
    const { runtime, registrations } = fakeMastraNativeRuntime();
    const handle = await wireMastraObservability(runtime, CREDENTIAL_ENV_BAG);
    expect(handle).toBeDefined();

    expect(registrations).toHaveLength(2);
    const [first, second] = registrations;
    // First registration bootstraps the real entrypoint over the no-op
    // default and registers mastra's official langfuse exporter — enabled,
    // so the credentials were actually read into it.
    expect(first.exporter).toBeInstanceOf(LangfuseExporter);
    expect((first.exporter as { name: string }).name).toBe("langfuse");
    expect((first.exporter as { isDisabled: boolean }).isDisabled).toBe(false);
    expect(first.instance).toBeInstanceOf(DefaultObservabilityInstance);
    expect(first.entrypoint).toBeInstanceOf(Observability);
    // Second registration adds the OUR-node isolation exporter.
    expect(second.exporter).toBeInstanceOf(DecafNodeObservabilityExporter);
    expect((second.exporter as { name: string }).name).toBe(
      "decaf-node-observability"
    );
    expect(second.instance).toBeInstanceOf(DefaultObservabilityInstance);
    expect(second.entrypoint).toBeInstanceOf(Observability);

    expect(handle?.decafExporter).toBeInstanceOf(DecafNodeObservabilityExporter);
    await expect(handle?.flush()).resolves.toBeUndefined();
    await expect(handle?.shutdown()).resolves.toBeUndefined();
  });

  it("registers the langfuse exporter enabled even when the endpoint is unreachable (no unauthenticated fallback)", async () => {
    process.env["MASTRA__OBSERVABILITY__LANGFUSE__ENDPOINT"] =
      "http://127.0.0.1:9";
    const { runtime, registrations } = fakeMastraNativeRuntime();
    await wireMastraObservability(runtime, CREDENTIAL_ENV_BAG);
    expect(registrations).toHaveLength(2);
    // The langfuse exporter is constructed with the resolved credentials and
    // endpoint; an unreachable endpoint does not disable it (delivery is the
    // exporter's concern, wiring is the layer's).
    const langfuse = registrations[0].exporter as { isDisabled: boolean };
    expect(langfuse.isDisabled).toBe(false);
  });
});

describe("compiler stamp — decafNode origin on translated steps (SAA-836 O1)", () => {
  it("stamps the canonical node id and kind onto every translated step", () => {
    const source = twoLeafDocument();
    const compiler = new MastraWorkflowCompiler({
      stepHandlers: [leafHandler("test.leaf")],
    });
    const compiled = compiler.compile(source);

    expect([...compiled.steps.keys()]).toEqual(["first", "second"]);
    for (const [nodeId, step] of compiled.steps) {
      const metadata = (step as { metadata?: Record<string, unknown> })
        .metadata;
      expect(metadata).toBeDefined();
      expect(metadata?.[MASTRA_DECAF_NODE_ORIGIN_KEY]).toEqual({
        id: nodeId,
        kind: "test.leaf",
      });
    }
  });

  it("carries the stamp on the suspending humanApproval step too", () => {
    const compiler = new MastraWorkflowCompiler({ stepHandlers: [] });
    const compiled = compiler.compile(humanApprovalDocument());
    const step = compiled.steps.get("approve") as {
      metadata?: Record<string, unknown>;
    };
    expect(step.metadata?.[MASTRA_DECAF_NODE_ORIGIN_KEY]).toEqual({
      id: "approve",
      kind: "core.flow.humanApproval",
    });
  });
});
