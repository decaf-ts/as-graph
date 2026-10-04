/**
 * @module as-graph/nest/graph/GraphEngineCapabilityManifest
 * @summary Server-side engine capability manifest (SAA-197, SAA-193 C20).
 * @description Builds the read-only, statically-derived capability manifest the
 * frontend consumes to toggle per-engine features/buttons. The manifest is derived
 * exclusively from engine metadata — the registered
 * {@link GraphExecutionBackend}s and the capability tables the Dagster/Mastra
 * wrappers export — and is never probed against a remote engine and never read from
 * the environment. Every `detail` is a static, reviewed literal (C20): no secrets,
 * endpoints/DSNs, sandbox internals, infrastructure topology, or authorization
 * internals are exposed.
 */
import type {
  GraphBackendCapabilities,
  GraphExecutionBackend,
} from "../../engine/execution/GraphExecutionBackend";
import { resolveGraphBackendCapabilities } from "../../engine/execution/GraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "../../engine/execution/GraphExecutionBackendRegistry";
import { GRAPH_LOCAL_EXECUTION_BACKEND } from "../../engine/constants";
import { DAGSTER_CAPABILITY_TABLE } from "../../dagster/capabilities";
import {
  DAGSTER_BACKEND_FLAVOUR,
  DAGSTER_PINNED_VERSION,
} from "../../dagster/constants";
import { MASTRA_FEATURE_CAPABILITIES } from "../../mastra/MastraCapabilities";
import { MASTRA_BACKEND_FLAVOUR } from "../../mastra/types";

/**
 * The normalized per-feature verdict served by the manifest. C20 defines exactly
 * three verdicts; the wrapper tables' source spellings are normalized onto them
 * (`supported`/`SUPPORTED` → `SUPPORTED`, `not_supported`/`NOT-SUPPORTED` →
 * `NOT_SUPPORTED`, `extension_point`/`EXTENSION-POINT` → `EXTENSION_POINT`).
 */
export type GraphEngineFeatureVerdict =
  | "SUPPORTED"
  | "NOT_SUPPORTED"
  | "EXTENSION_POINT";

/** One engine feature row served by the manifest (C20). */
export interface GraphEngineFeature {
  /** Feature identifier as declared by the engine's capability metadata. */
  feature: string;
  /** Normalized verdict (C20 three-value vocabulary). */
  verdict: GraphEngineFeatureVerdict;
  /** Static, reviewed human-readable detail; never dynamic engine output. */
  detail?: string;
}

/** One engine entry served by the manifest (exact C20 shape). */
export interface GraphEngineDescriptor {
  /** Allowlisted engine id (the backend flavour). */
  engineId: string;
  /** Human-readable engine name. */
  displayName: string;
  /** Whether the engine executes in-process. */
  local: boolean;
  /** Pinned engine version the wrapper targets. */
  pinnedEngineVersion: string;
  /** Feature/verdict rows derived from the engine's capability metadata. */
  capabilities: GraphEngineFeature[];
}

/** The top-level capability manifest served to the frontend (exact C20 shape). */
export interface GraphEngineCapabilityManifest {
  /** One entry per available (registered) engine. */
  engines: GraphEngineDescriptor[];
  /** Engine id the server defaults to. */
  defaultEngineId: string;
}

/**
 * Pinned `@mastra/core` engine version. Kept here because the Mastra wrapper
 * exports only its feature table, not a version constant; the value mirrors the
 * `@mastra/core` dependency pin in `as-graph/package.json` (`1.74.0`).
 */
export const MASTRA_PINNED_VERSION = "1.74.0";

/**
 * Normalizes a wrapper capability verdict onto the C20 three-value vocabulary.
 * `PARTIAL` is deliberately downgraded to `NOT_SUPPORTED` (fail-closed): a
 * partially-supported feature must never be advertised as a usable toggle.
 *
 * @param verdict - The wrapper table verdict string.
 * @returns The normalized C20 verdict.
 */
export function toGraphEngineFeatureVerdict(
  verdict: string
): GraphEngineFeatureVerdict {
  const normalized = verdict.trim().toUpperCase().replace(/[-\s]+/g, "_");
  if (normalized === "SUPPORTED") return "SUPPORTED";
  if (normalized === "EXTENSION_POINT") return "EXTENSION_POINT";
  return "NOT_SUPPORTED";
}

/** The Dagster feature rows, derived from the exported capability table. */
const DAGSTER_ENGINE_FEATURES: GraphEngineFeature[] =
  DAGSTER_CAPABILITY_TABLE.map((row) => ({
    feature: row.feature,
    verdict: toGraphEngineFeatureVerdict(row.verdict),
    ...(row.detail !== undefined ? { detail: row.detail } : {}),
  }));

/** The Mastra feature rows, derived from the exported capability table. */
const MASTRA_ENGINE_FEATURES: GraphEngineFeature[] =
  MASTRA_FEATURE_CAPABILITIES.map((row) => ({
    feature: row.feature,
    verdict: toGraphEngineFeatureVerdict(row.verdict),
    ...(row.detail !== undefined ? { detail: row.detail } : {}),
  }));

/**
 * Derives the local engine's feature rows from the engine-agnostic
 * {@link GraphBackendCapabilities} the built-in backend exposes, so the manifest
 * never hand-maintains a separate local table.
 *
 * @param capabilities - The active backend's effective capability metadata.
 * @returns The normalized feature rows for the local engine.
 */
export function localEngineFeatures(
  capabilities: GraphBackendCapabilities
): GraphEngineFeature[] {
  return [
    {
      feature: "codeMode",
      verdict:
        capabilities.codeMode === "hostSide" ? "SUPPORTED" : "NOT_SUPPORTED",
      detail: "Host-side sandbox execution.",
    },
    {
      feature: "workflowList",
      verdict:
        capabilities.workflows.list === "supported"
          ? "SUPPORTED"
          : "NOT_SUPPORTED",
    },
    {
      feature: "workflowLookup",
      verdict:
        capabilities.workflows.get === "supported"
          ? "SUPPORTED"
          : "NOT_SUPPORTED",
    },
  ];
}

/**
 * A statically-registered engine capability source: the fixed descriptor fields
 * plus a function producing the feature rows for a registered backend.
 */
interface GraphEngineCapabilitySource {
  engineId: string;
  displayName: string;
  pinnedEngineVersion: string;
  features: (backend: GraphExecutionBackend) => GraphEngineFeature[];
}

/**
 * The allowlisted engine capability sources, keyed by backend flavour. An engine
 * absent from this map is never advertised (C21: engine selection is by
 * allowlisted ids only), even when a backend is registered under its flavour.
 */
const BUILT_IN_ENGINE_CAPABILITY_SOURCES: Record<
  string,
  GraphEngineCapabilitySource
> = {
  [GRAPH_LOCAL_EXECUTION_BACKEND]: {
    engineId: GRAPH_LOCAL_EXECUTION_BACKEND,
    displayName: "Local (built-in)",
    pinnedEngineVersion: "built-in",
    features: (backend) =>
      localEngineFeatures(resolveGraphBackendCapabilities(backend)),
  },
  [DAGSTER_BACKEND_FLAVOUR]: {
    engineId: DAGSTER_BACKEND_FLAVOUR,
    displayName: "Dagster",
    pinnedEngineVersion: DAGSTER_PINNED_VERSION,
    features: () => DAGSTER_ENGINE_FEATURES,
  },
  [MASTRA_BACKEND_FLAVOUR]: {
    engineId: MASTRA_BACKEND_FLAVOUR,
    displayName: "Mastra",
    pinnedEngineVersion: MASTRA_PINNED_VERSION,
    features: () => MASTRA_ENGINE_FEATURES,
  },
};

/**
 * Builds the capability manifest from the registered backends, statically at boot.
 * Only allowlisted flavours are advertised; the descriptors' `local` flag is read
 * from the registered backend, and no remote engine is ever probed. The returned
 * object is a fresh snapshot so a caller cannot mutate the served manifest.
 *
 * @param registered - The registered flavour/backend entries.
 * @param defaultEngineId - Optional host-preferred default engine id.
 * @returns The C20 capability manifest.
 */
export function buildGraphEngineCapabilityManifest(
  registered: ReadonlyArray<{
    flavour: string;
    backend: GraphExecutionBackend<any>;
  }>,
  defaultEngineId?: string
): GraphEngineCapabilityManifest {
  const engines: GraphEngineDescriptor[] = [];
  for (const { flavour, backend } of registered) {
    const source = BUILT_IN_ENGINE_CAPABILITY_SOURCES[flavour];
    if (!source) continue;
    engines.push({
      engineId: source.engineId,
      displayName: source.displayName,
      local: backend.local === true,
      pinnedEngineVersion: source.pinnedEngineVersion,
      capabilities: source.features(backend).map((row) => ({ ...row })),
    });
  }

  const ids = new Set(engines.map((engine) => engine.engineId));
  const currentFlavour = GraphExecutionBackendRegistry.currentFlavour;
  const resolvedDefault =
    defaultEngineId && ids.has(defaultEngineId)
      ? defaultEngineId
      : ids.has(currentFlavour)
        ? currentFlavour
        : (engines[0]?.engineId ?? currentFlavour);

  return { engines, defaultEngineId: resolvedDefault };
}
