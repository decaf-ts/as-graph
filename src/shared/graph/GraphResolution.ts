/**
 * @module ui-decorators/graph/GraphResolution
 * @summary Shared graph manifest-resolution contracts.
 * @description Frontend/backend-shared manifest-resolution types (DECAF-50
 * §4.11): the effective per-node manifest shape consumed by the planner,
 * executor, and the frontend catalogue, plus its structural type guard and
 * the resolution/query contexts. Node/browser compatible — no engine
 * runtime dependency.
 */
import type {
  GraphCredentialReference,
  GraphCredentialRequirement,
  GraphDynamicPortRule,
  GraphJsonValue,
  GraphNodeCapability,
  GraphNodeDisplayManifest,
  GraphNodePolicyManifest,
  GraphParameterDefinition,
  GraphPortManifest,
} from "./catalog";

/**
 * The effective manifest for one node instance (DECAF-50 §4.11): the
 * published manifest with dynamic ports expanded against the instance's
 * parameters. This is the shape the planner and executor consume — the only
 * input the nine-stage validator's resolved workflow carries per node.
 */
export interface GraphResolvedNodeManifest {
  /** Node kind. */
  kind: string;
  /** Display metadata (name, category, icon). */
  display: GraphNodeDisplayManifest;
  /** Effective input ports (static plus expanded dynamic). */
  inputs: GraphPortManifest[];
  /** Effective output ports (static plus expanded dynamic). */
  outputs: GraphPortManifest[];
  /** Effective connection ports, when any. */
  connections?: GraphPortManifest[];
  /** Declared parameters. */
  parameters: GraphParameterDefinition[];
  /** Dynamic-port rules the manifest declares, when any. */
  dynamicPorts?: GraphDynamicPortRule[];
  /** Credential requirements, when any. */
  credentials?: GraphCredentialRequirement[];
  /** Capabilities, when any. */
  capabilities?: GraphNodeCapability[];
  /** Execution policies, when declared. */
  policies?: GraphNodePolicyManifest;
  /** Free-form metadata. */
  metadata?: Record<string, GraphJsonValue>;
  /** Namespaces required to execute this node, when declared. */
  namespaces?: string[];
}

/**
 * Structural type guard for `GraphResolvedNodeManifest`.
 *
 * @returns {boolean} `true` when the value is a resolved node manifest.
 */
export function isGraphResolvedNodeManifest(
  value: unknown
): value is GraphResolvedNodeManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["kind"] === "string" &&
    typeof record["display"] === "object" &&
    record["display"] !== null &&
    Array.isArray(record["inputs"]) &&
    Array.isArray(record["outputs"]) &&
    Array.isArray(record["parameters"])
  );
}

/** Context handed to manifest resolution for a node instance: authorized credentials plus caller metadata. */
export interface GraphNodeResolutionContext {
  credentials?: GraphCredentialReference[];
  requestContext?: unknown;
  metadata?: Record<string, GraphJsonValue>;
}

/** Filters for catalogue manifest listing: restrict results to the given display categories and/or kinds. */
export interface GraphCatalogueQueryContext {
  categories?: string[];
  kinds?: string[];
}
