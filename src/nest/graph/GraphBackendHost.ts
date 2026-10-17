/**
 * @module as-graph/nest/graph/GraphBackendHost
 * @summary Boot-time engine-variant selection for the graph backend host (SAA-706).
 * @description Resolves which of the three pluggable graph engines — the built-in
 * local reference interpreter, the `@mastra/core` translated backend, or the
 * read-only Dagster backend — a host boots, constructs and registers that
 * backend, and assembles the {@link GraphExecutionModule} options that make the
 * Nest host serve the matching C20 capability manifest (`graph/engines`) and the
 * per-engine workflow catalogue (`graph/engines/{engineId}/workflows`).
 *
 * The host never stubs an engine: each variant constructs the real backend. A
 * translated/remote backend whose host wiring is absent (no Mastra runtime, no
 * Dagster client) still boots and serves the manifest; its catalogue then reports
 * the engine's honest `NOT_SUPPORTED` verdict through the engine facade, exactly
 * as `GraphEngineController` maps it to `501`. The variant is chosen at boot by
 * the `GRAPH_BACKEND_ENGINE` environment variable, so switching engines is a
 * configuration change, never a code change.
 */
import type { GraphWorkflowDocument } from "../../shared/graph";
import { GraphExecutionError } from "../../engine/errors/GraphExecutionError";
import { GraphExecutionBackendRegistry } from "../../engine/execution/GraphExecutionBackendRegistry";
import type { GraphExecutionBackend } from "../../engine/execution/GraphExecutionBackend";
import { GRAPH_LOCAL_EXECUTION_BACKEND } from "../../engine/constants";
// SAA-836 M6: the mastra and dagster engine backends load at runtime — the
// static backend imports were replaced by per-variant dynamic imports inside
// `buildGraphBackend`, so a consumer booting one engine never loads the
// other engine's code (only leaf, type-only or constants modules are shared).
import {
  MASTRA_BACKEND_FLAVOUR,
  type MastraBackendConfig,
} from "../../mastra/types";
import type {
  DagsterClient,
  DagsterGraphExecutionBackendConfig,
} from "../../dagster/DagsterTypes";
import { DAGSTER_BACKEND_FLAVOUR } from "../../dagster/constants";
import type { GraphExecutionModuleOptions } from "./GraphExecutionModule";

/**
 * The graph engine variants a host can boot. Each maps one-to-one onto the
 * backend flavour it registers, which is also the allowlisted engine id the C20
 * manifest advertises.
 */
export type GraphEngineVariant = "local" | "mastra" | "dagster";

/** Every bootable engine variant, in manifest order. */
export const GRAPH_ENGINE_VARIANTS: readonly GraphEngineVariant[] = [
  "local",
  "mastra",
  "dagster",
];

/** Environment variable selecting the engine variant the host boots. */
export const GRAPH_BACKEND_ENGINE_ENV = "GRAPH_BACKEND_ENGINE";

/** The engine variant a host boots when none is configured. */
export const DEFAULT_GRAPH_ENGINE_VARIANT: GraphEngineVariant = "local";

/**
 * Parses a configured engine variant, failing closed on an unknown value so a
 * typo never silently boots the wrong engine.
 *
 * @param value - The raw configured value (`undefined`/empty selects the fallback).
 * @param fallback - The variant to use when no value is configured.
 * @returns The resolved engine variant.
 * @throws {GraphExecutionError} when the value names no known variant.
 */
export function parseGraphEngineVariant(
  value: string | undefined,
  fallback: GraphEngineVariant = DEFAULT_GRAPH_ENGINE_VARIANT
): GraphEngineVariant {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if ((GRAPH_ENGINE_VARIANTS as readonly string[]).includes(normalized)) {
    return normalized as GraphEngineVariant;
  }
  throw new GraphExecutionError(
    `Unknown graph engine variant '${value}'; expected one of ${GRAPH_ENGINE_VARIANTS.join(
      ", "
    )}`,
    "GRAPH_BACKEND_ENGINE_UNKNOWN",
    { variant: value }
  );
}

/**
 * Reads the engine variant from an environment bag (defaults to `process.env`),
 * applying {@link parseGraphEngineVariant}.
 *
 * @param env - The environment to read from.
 * @returns The resolved engine variant.
 */
export function graphEngineVariantFromEnv(
  env: NodeJS.ProcessEnv = process.env
): GraphEngineVariant {
  return parseGraphEngineVariant(env[GRAPH_BACKEND_ENGINE_ENV]);
}

/** Environment variable gating boot-time demo-workflow seeding (F5 hardening). */
export const GRAPH_SEED_DEMO_ENV = "GRAPH_SEED_DEMO";

/** Case-insensitive environment values that suppress demo seeding. */
const GRAPH_SEED_DEMO_DISABLED_VALUES: readonly string[] = [
  "off",
  "false",
  "0",
  "no",
  "disabled",
];

/**
 * Resolves whether the standalone host seeds the demo workflow fixture registry
 * at boot (F5 hardening). Seeding is enabled by default so a source checkout
 * keeps its fixtures; a production host sets `GRAPH_SEED_DEMO=off` (also accepts
 * `false` / `0` / `no` / `disabled`, case-insensitive) to suppress owner-less
 * demo seeding without a code change. An unset or empty value keeps the default
 * (enabled), so existing hosts are unaffected.
 *
 * @param env - The environment to read from (defaults to `process.env`).
 * @returns `true` when boot-time demo seeding is enabled.
 */
export function graphDemoSeedEnabledFromEnv(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env[GRAPH_SEED_DEMO_ENV];
  if (raw === undefined || raw.trim() === "") return true;
  return !GRAPH_SEED_DEMO_DISABLED_VALUES.includes(raw.trim().toLowerCase());
}

/** Host wiring for the Dagster variant: the client port plus its gate options. */
export interface GraphDagsterHostOptions {
  /**
   * The read-only Dagster client port. When omitted the backend still boots and
   * serves the manifest, but its catalogue reports `NOT_SUPPORTED` because no
   * deployment transport is wired.
   */
  client?: DagsterClient;
  /** Opt-in gate for launching/replaying EXISTING workflows. Defaults to off. */
  executionEnabled?: boolean;
  /** Host-supplied default run tags. */
  tags?: Record<string, string>;
}

/**
 * Options for {@link createGraphBackendHost}: the selected variant plus the
 * per-variant host wiring. Unused wiring for the unselected variant is ignored.
 */
export interface GraphBackendHostOptions {
  /** The engine variant to boot. */
  variant: GraphEngineVariant;
  /**
   * Host wiring for the Mastra variant: the real `@mastra/core` runtime and the
   * node-kind step handlers. Absent wiring boots a catalogue-less Mastra host.
   */
  mastra?: MastraBackendConfig;
  /** Host wiring for the Dagster variant. */
  dagster?: GraphDagsterHostOptions;
  /**
   * Canonical workflow documents seeded into the selected engine's catalogue at
   * boot (the host's fixture registry). Forwarded to the module options so the
   * per-engine workflow catalogue serves the fixture set for whichever variant
   * the host booted. The seed stays engine-dependent and read-only for Dagster.
   */
  seedWorkflows?: readonly GraphWorkflowDocument[];
  /**
   * Existing module options to extend. The host overrides only `backend` and
   * `engines.defaultEngineId`, so a caller keeps its auth, limits, adapter, and
   * rate-limit configuration.
   */
  base?: GraphExecutionModuleOptions;
}

/**
 * The result of {@link createGraphBackendHost}: the resolved variant, the
 * allowlisted engine id it advertises, the constructed backend (absent for the
 * local variant, which the engine constructs itself), and the assembled module
 * options ready for `GraphExecutionModule.forRoot`.
 */
export interface GraphBackendHost {
  /** The resolved engine variant. */
  variant: GraphEngineVariant;
  /** The allowlisted engine id the manifest advertises for this variant. */
  engineId: string;
  /**
   * The constructed backend the host selected, or `undefined` for the local
   * variant (the engine constructs the built-in backend itself).
   */
  backend?: GraphExecutionBackend;
  /** Module options carrying the selected backend and default engine id. */
  moduleOptions: GraphExecutionModuleOptions;
}

/**
 * Constructs and registers the backend for the selected variant. The local
 * variant constructs nothing: the engine's built-in default backend is the
 * reference interpreter, so the host leaves `backend` unset and the engine
 * registers it during boot.
 *
 * @param options - The host options.
 * @returns The constructed backend, or `undefined` for the local variant.
 */
async function buildGraphBackend(
  options: GraphBackendHostOptions
): Promise<GraphExecutionBackend | undefined> {
  switch (options.variant) {
    case "mastra": {
      // SAA-836 M6: the mastra backend loads at runtime, so booting the
      // mastra variant never loads the dagster engine code.
      const { MastraGraphExecutionBackend } = await import(
        "../../mastra/MastraGraphExecutionBackend"
      );
      const backend = new MastraGraphExecutionBackend();
      await backend.initialize(options.mastra ?? {});
      return backend;
    }
    case "dagster": {
      // SAA-836 M6: the dagster backend loads at runtime, so booting the
      // dagster variant never loads the mastra engine code.
      const { DagsterGraphExecutionBackend } = await import(
        "../../dagster/DagsterGraphExecutionBackend"
      );
      const backend = new DagsterGraphExecutionBackend();
      const wiring = options.dagster ?? {};
      const config = {
        ...(wiring.client ? { client: wiring.client } : {}),
        ...(wiring.executionEnabled !== undefined
          ? { executionEnabled: wiring.executionEnabled }
          : {}),
        ...(wiring.tags ? { tags: wiring.tags } : {}),
      } as unknown as DagsterGraphExecutionBackendConfig;
      await backend.initialize(config);
      return backend;
    }
    case "local":
    default:
      return undefined;
  }
}

/**
 * Builds the bootable graph backend host for one engine variant: constructs and
 * registers the selected backend, selects it as the registry current so the
 * engine facade's default engine follows the variant, and assembles the
 * {@link GraphExecutionModule} options that advertise that engine's capability
 * manifest and per-engine workflow catalogue.
 *
 * @param options - The host options (variant, per-variant wiring, base options).
 * @returns The resolved host, including the module options to boot.
 */
export async function createGraphBackendHost(
  options: GraphBackendHostOptions
): Promise<GraphBackendHost> {
  const { variant } = options;
  const backend = await buildGraphBackend(options);

  // Select the variant as the registry current so the engine facade's default
  // backend (used by `GET /graph/workflows` and the run lifecycle) follows it.
  GraphExecutionBackendRegistry.setCurrent(variant);

  const base = options.base ?? {};
  const moduleOptions: GraphExecutionModuleOptions = {
    ...base,
    ...(backend ? { backend } : {}),
    ...(options.seedWorkflows
      ? { seedWorkflows: options.seedWorkflows }
      : {}),
    engines: {
      ...(base.engines ?? {}),
      defaultEngineId: variant,
    },
  };

  return {
    variant,
    engineId: variant,
    ...(backend ? { backend } : {}),
    moduleOptions,
  };
}

/**
 * Relative specifiers tried, in order, for the demo workflow fixture registry
 * (`src/workflows`). The registry is typed TS under `src/` — satisfying the
 * owner directive that demo assets live in `src` — and is excluded from release
 * packaging (see the `files` ignores). Using relative, extension-varied
 * specifiers keeps the loader working across the source checkout (ts-jest /
 * `tsx`) and both compiled outputs without a static dependency.
 */
const GRAPH_DEMO_WORKFLOW_SPECIFIERS: readonly string[] = [
  "../../workflows",
  "../../workflows/index",
  "../../workflows/index.js",
  "../../workflows/index.mjs",
  "../../workflows/index.cjs",
];

/**
 * Loads the host's demo workflow fixture registry for boot-time seeding. This is
 * the engine driver's seeding path (R4): the fixture registry is imported only
 * by tests and by this loader. Because the registry is excluded from release
 * packaging, the loader is best-effort — it returns the fixture documents when
 * the registry is present (a source checkout or development install) and an
 * empty set when it is absent (a published package), never failing the boot.
 *
 * @returns The canonical documents to seed, or an empty array when the registry
 *   is unavailable.
 */
export async function loadGraphDemoWorkflows(): Promise<
  readonly GraphWorkflowDocument[]
> {
  for (const specifier of GRAPH_DEMO_WORKFLOW_SPECIFIERS) {
    try {
      const module = (await import(specifier)) as {
        graphWorkflowFixtures?: readonly { document: GraphWorkflowDocument }[];
      };
      const fixtures = module.graphWorkflowFixtures;
      return fixtures ? fixtures.map((fixture) => fixture.document) : [];
    } catch {
      // Try the next candidate specifier.
    }
  }
  return [];
}

/** The allowlisted engine id for a variant (the backend flavour). */
export function graphEngineIdOf(variant: GraphEngineVariant): string {
  return variant === "local"
    ? GRAPH_LOCAL_EXECUTION_BACKEND
    : variant === "mastra"
      ? MASTRA_BACKEND_FLAVOUR
      : DAGSTER_BACKEND_FLAVOUR;
}
