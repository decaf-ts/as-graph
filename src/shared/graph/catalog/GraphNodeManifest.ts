import type { GraphJsonValue } from "../document/GraphJsonValue";
import type { GraphNodeDisplayManifest } from "./GraphNodeDisplayManifest";
import type { GraphPortManifest } from "./GraphPortManifest";
import type { GraphParameterDefinition } from "./GraphParameterDefinition";
import type { GraphNodeMethodManifest } from "./GraphNodeMethodManifest";
import type { GraphNodeCapability } from "./GraphNodeCapability";
import type { GraphNodePolicyManifest } from "./GraphNodePolicyManifest";
import type { GraphCredentialRequirement } from "./GraphCredentialRequirement";
import type { GraphDynamicPortRule } from "./GraphDynamicPortRule";

/**
 * Canonical, serialisable manifest of a node kind (DECAF-50 §4.9): display metadata, ports, parameters, dynamic ports, credentials, capabilities, methods and policy.
 */
export interface GraphNodeManifest {
  kind: string;
  display: GraphNodeDisplayManifest;
  inputs: GraphPortManifest[];
  outputs: GraphPortManifest[];
  connections?: GraphPortManifest[];
  parameters: GraphParameterDefinition[];
  dynamicPorts?: GraphDynamicPortRule[];
  credentials?: GraphCredentialRequirement[];
  capabilities?: GraphNodeCapability[];
  methods?: GraphNodeMethodManifest[];
  policies?: GraphNodePolicyManifest;
  metadata?: Record<string, GraphJsonValue>;
  /**
   * Namespaces required to execute this node kind, folded from the node class's
   * `@namespace(...)` metadata by the manifest compiler. The engine validates
   * them against the authenticated principal before execution.
   */
  namespaces?: string[];
}

/**
 * Type guard for {@link GraphNodeManifest}, checking the required `kind`, `display`, `inputs`, `outputs` and `parameters` fields.
  * @returns {boolean} Whether `value` is a GraphNodeManifest.
*/
export function isGraphNodeManifest(value: unknown): value is GraphNodeManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["kind"] === "string" &&
    typeof record["display"] === "object" &&
    Array.isArray(record["inputs"]) &&
    Array.isArray(record["outputs"]) &&
    Array.isArray(record["parameters"])
  );
}

/**
 * Returns the manifest's data ports for `direction` (inputs or outputs).
 */
export function graphDataPortManifestsOf(
  manifest: GraphNodeManifest,
  direction: "input" | "output"
): GraphPortManifest[] {
  return (direction === "input" ? manifest.inputs : manifest.outputs).filter(
    (port) => port.direction === direction
  );
}

/**
 * Returns the manifest's connection ports, or an empty array when none are declared.
 */
export function graphConnectionPortManifests(
  manifest: GraphNodeManifest
): GraphPortManifest[] {
  return manifest.connections ?? [];
}
