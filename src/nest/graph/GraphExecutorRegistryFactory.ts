/**
 * @module as-graph/nest/graph/GraphExecutorRegistryFactory
 * @summary Factory that builds a populated {@link GraphNodeCatalogue} and its
 * {@link GraphNodeExecutorRegistry} compatibility facade.
 * @description Creates a catalogue pre-loaded with the DECAF-50 built-in
 * manifest+executor registrations plus the demo executors used by the graph
 * execution backend's sample workflows. The catalogue is the single
 * kind→registration map (DECAF-50 §4.7); the returned registry is a facade
 * over it, so no second executor map exists.
 */
import { Context, type Adapter } from "@decaf-ts/core";
import {
  GraphNodeCatalogue,
  GraphNodeExecutorRegistry,
  GraphExecutionEngine,
  builtInGraphNodeRegistrations,
  registerBuiltInGraphNodes,
  type GraphNodeExecutor,
  type GraphNodeExecutionRequest,
  IsolatedVmCodeSandboxEvaluator,
} from "../../";

type ExecutorFn = (
  request: GraphNodeExecutionRequest,
  context: unknown
) => Record<string, unknown> | Promise<Record<string, unknown>>;

const demoExecutorMap: Record<string, ExecutorFn> = {
  "math.add": (request) => ({
    sum: Number(request.inputs.a) + Number(request.inputs.b),
  }),
  "math.multiply": (request) => ({
    product: Number(request.inputs.x) * 2,
  }),
};

/**
 * Builds a {@link GraphNodeCatalogue} populated with the built-in
 * manifest+executor registrations and the arithmetic demo executors, wrapped
 * with its {@link GraphNodeExecutorRegistry} facade.
 *
 * The built-in kinds whose executors need the engine instance (loops, Code,
 * Switch) are only registered by {@link createDemoEngineConfig}'s
 * `onEngineCreated` hook via {@link registerEngineBoundGraphNodes}.
 *
 * @param extra - Additional executor registrations to merge into the catalogue.
 * @returns The populated catalogue and its registry facade.
 */
export async function createGraphNodeCatalogue(
  extra?: Record<string, GraphNodeExecutor>,
  context: Context = new Context()
): Promise<{ catalogue: GraphNodeCatalogue; registry: GraphNodeExecutorRegistry }> {
  const catalogue = new GraphNodeCatalogue();
  registerBuiltInGraphNodes(catalogue, context);

  for (const [kind, fn] of Object.entries(demoExecutorMap)) {
    catalogue.registerExecutor(kind, { execute: fn }, context);
  }

  if (extra) {
    for (const [kind, executor] of Object.entries(extra)) {
      catalogue.registerExecutor(kind, executor, context);
    }
  }

  return { catalogue, registry: new GraphNodeExecutorRegistry(catalogue) };
}

/**
 * Builds a {@link GraphNodeExecutorRegistry} facade over a populated
 * {@link GraphNodeCatalogue} (compatibility entry point).
 *
 * @param extra - Additional executor registrations to merge into the catalogue.
 * @returns The registry facade; the underlying catalogue is available as
 * `registry.catalog`.
 */
export async function createGraphExecutorRegistry(
  extra?: Record<string, GraphNodeExecutor>,
  context: Context = new Context()
): Promise<GraphNodeExecutorRegistry> {
  return (await createGraphNodeCatalogue(extra, context)).registry;
}

/**
 * Registers the engine-bound built-in kinds (loops, Code, Switch) on an
 * existing catalogue, replacing their placeholder-free entries with the real
 * engine-bound executors.
 *
 * @param catalogue - The catalogue receiving the registrations.
 * @param _engine - Retained for call-site compatibility; node classes now
 *   reach the engine through `GraphExecutionContext.engine`, so no executor
 *   needs an engine back-reference.
 * @returns The catalogue with the built-in registrations applied.
 */
export async function registerEngineBoundGraphNodes(
  catalogue: GraphNodeCatalogue,
  _engine: GraphExecutionEngine,
  context: Context = new Context()
): Promise<GraphNodeCatalogue> {
  for (const registration of builtInGraphNodeRegistrations()) {
    catalogue.register(registration, { replace: true }, context);
  }
  return catalogue;
}

/**
 * Builds a `GraphExecutionEngineConfig` populated with all built-in
 * registrations including loop executors that need a back-reference to the
 * engine and the Code node executor that needs the engine's
 * `codeSandboxEvaluator`.
 *
 * The config wires an {@link IsolatedVmCodeSandboxEvaluator} (backed by
 * `isolated-vm`) so the Code Node runs in a truly isolated V8 sandbox. Cached and
 * pinned value persistence uses the host-provided `valueAdapter` when given, and
 * otherwise defers to the globally configured adapter (`Adapter.current`); this
 * factory never installs an adapter of its own, so a host that did not configure
 * one fails closed in {@link GraphExecutionEngine.initialize} rather than having a
 * `RamAdapter` silently registered behind its back.
 *
 * @param valueAdapter - Optional Decaf adapter for cached/pinned values.
 * @returns A config object ready for `GraphExecutionEngine.initialize(config)`.
 */
export async function createDemoEngineConfig(
  valueAdapter?: Adapter<any, any, any, any>,
  context: Context = new Context()
): Promise<{
  catalogue: GraphNodeCatalogue;
  registry: GraphNodeExecutorRegistry;
  valueAdapter?: Adapter<any, any, any, any>;
  defaultOptions: { failFast: boolean };
  codeSandboxEvaluator: IsolatedVmCodeSandboxEvaluator;
  onEngineCreated: (engine: GraphExecutionEngine) => Promise<void>;
}> {
  const { catalogue, registry } = await createGraphNodeCatalogue(
    undefined,
    context
  );
  const codeSandboxEvaluator = new IsolatedVmCodeSandboxEvaluator();
  await codeSandboxEvaluator.boot({});

  return {
    catalogue,
    registry,
    ...(valueAdapter ? { valueAdapter } : {}),
    defaultOptions: { failFast: false },
    codeSandboxEvaluator,
    onEngineCreated: async (engine: GraphExecutionEngine) => {
      await registerEngineBoundGraphNodes(catalogue, engine, context);
    },
  };
}
