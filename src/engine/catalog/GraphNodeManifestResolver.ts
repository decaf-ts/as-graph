/**
 * @module as-graph/engine/catalog/GraphNodeManifestResolver
 * @summary Manifest resolution against node instances (DECAF-50 §4.11).
 * @description Expands a manifest's `dynamicPorts` rules against the
 * instance's parameter values and resolves the effective
 * {@link GraphResolvedNodeManifest} — static plus expanded dynamic ports,
 * JSON-safe cloned, with credentials/capabilities/policies/metadata carried
 * over.
 */
import type {
  GraphDynamicPortRule,
  GraphJsonValue,
  GraphNodeManifest,
  GraphPortManifest,
} from "../../shared/graph";
import {
  cloneGraphJsonValue,
  isGraphJsonSafeValue,
} from "../../shared/graph";
import type { GraphNodeInstance } from "../../shared/graph";
import type {
  GraphNodeResolutionContext,
  GraphResolvedNodeManifest,
} from "../../shared/graph";
import { isGraphResolvedNodeManifest } from "../../shared/graph";
import { GraphNodeRegistrationError } from "./GraphCatalogueErrors";
import type { GraphResolvedManifestProvider } from "./GraphNodeRegistration";

/** Result of expanding a manifest's dynamic-port rules: concrete input/output/connection ports. */
export interface GraphDynamicPortResolution {
  inputs: GraphPortManifest[];
  outputs: GraphPortManifest[];
  connections: GraphPortManifest[];
}

function readItemPath(item: unknown, path: string): unknown {
  if (!path) return undefined;
  let current: unknown = item;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function expandPortIdTemplate(
  template: string,
  values: { id: string; index: number; label: string }
): string {
  return template
    .replaceAll("${id}", values.id)
    .replaceAll("${index}", String(values.index))
    .replaceAll("${label}", values.label);
}

function dynamicPortIdFor(
  rule: Extract<GraphDynamicPortRule, { type: "repeatFromParameter" }>,
  item: unknown,
  index: number
): { id: string; label: string | undefined } {
  const rawId = readItemPath(item, rule.itemIdPath);
  const rawLabel = rule.itemLabelPath
    ? readItemPath(item, rule.itemLabelPath)
    : undefined;
  const id =
    (typeof rawId === "string" && rawId) ||
    (typeof rawId === "number" && Number.isFinite(rawId) && String(rawId)) ||
    String(index);
  const label = typeof rawLabel === "string" ? rawLabel : undefined;
  return { id, label };
}

function dynamicPortTargets(
  resolution: GraphDynamicPortResolution,
  direction: "input" | "output" | "connection"
): GraphPortManifest[] {
  switch (direction) {
    case "input":
      return resolution.inputs;
    case "output":
      return resolution.outputs;
    default:
      return resolution.connections;
  }
}

/**
 * Expands a manifest's `dynamicPorts` rules (DECAF-50 §4.11) against the
 * given parameter values — e.g. `repeatFromParameter` turns each array item
 * into a concrete port with a templated id/label. Static ports are never
 * duplicated; expanded ports are appended per direction.
 */
export function resolveGraphDynamicPorts(
  manifest: Pick<
    GraphNodeManifest,
    "dynamicPorts" | "inputs" | "outputs" | "connections"
  >,
  parameters: Record<string, GraphJsonValue>
): GraphDynamicPortResolution {
  const resolution: GraphDynamicPortResolution = {
    inputs: [],
    outputs: [],
    connections: [],
  };
  const seen = {
    input: new Set<string>((manifest.inputs ?? []).map((port) => port.id)),
    output: new Set<string>((manifest.outputs ?? []).map((port) => port.id)),
    connection: new Set<string>(
      (manifest.connections ?? []).map((port) => port.id)
    ),
  };

  const claim = (
    direction: "input" | "output" | "connection",
    portId: string
  ): boolean => {
    const taken = seen[direction];
    if (taken.has(portId)) return false;
    taken.add(portId);
    return true;
  };

  for (const rule of manifest.dynamicPorts ?? []) {
    if (rule.type === "repeatFromParameter") {
      const value = parameters[rule.parameter];
      if (!Array.isArray(value)) continue;
      const targets = dynamicPortTargets(resolution, rule.direction);
      value.forEach((item, index) => {
        const { id, label } = dynamicPortIdFor(rule, item, index);
        const portId = expandPortIdTemplate(rule.portIdTemplate, {
          id,
          index,
          label: label ?? id,
        });
        if (!claim(rule.direction, portId)) return;
        const base = rule.defaultPort
          ? cloneGraphJsonValue(rule.defaultPort as unknown as GraphJsonValue)
          : ({
              id: portId,
              label: label ?? portId,
              direction: rule.direction,
            } as GraphPortManifest);
        const port = base as unknown as GraphPortManifest;
        port.id = portId;
        port.direction = rule.direction;
        if (label) port.label = label;
        targets.push(port);
      });
    } else if (rule.type === "togglePort") {
      const value = parameters[rule.parameter];
      if (value !== rule.equals) continue;
      const port = cloneGraphJsonValue(
        rule.port as unknown as GraphJsonValue
      ) as unknown as GraphPortManifest;
      if (!claim(port.direction, port.id)) continue;
      dynamicPortTargets(resolution, port.direction).push(port);
    }
  }

  return resolution;
}

/**
 * Resolves a manifest against parameter values into a
 * {@link GraphResolvedNodeManifest}: static ports plus expanded dynamic
 * ports, with credentials/capabilities/policies/metadata carried over. The
 * result is a JSON-safe clone.
 */
export function resolveGraphNodeManifest(
  manifest: GraphNodeManifest,
  parameters: Record<string, GraphJsonValue>
): GraphResolvedNodeManifest {
  const dynamic = resolveGraphDynamicPorts(manifest, parameters);
  const resolved: GraphResolvedNodeManifest = {
    kind: manifest.kind,
    display: manifest.display,
    inputs: [...manifest.inputs, ...dynamic.inputs],
    outputs: [...manifest.outputs, ...dynamic.outputs],
    parameters: manifest.parameters,
  };
  const connections = [
    ...(manifest.connections ?? []),
    ...dynamic.connections,
  ];
  if (connections.length) resolved.connections = connections;
  if (manifest.dynamicPorts?.length) resolved.dynamicPorts = manifest.dynamicPorts;
  if (manifest.credentials?.length) resolved.credentials = manifest.credentials;
  if (manifest.capabilities?.length) resolved.capabilities = manifest.capabilities;
  if (manifest.policies) resolved.policies = manifest.policies;
  if (manifest.metadata) resolved.metadata = manifest.metadata;
  if (manifest.namespaces?.length) resolved.namespaces = manifest.namespaces;
  return cloneGraphJsonValue(
    resolved as unknown as GraphJsonValue
  ) as unknown as GraphResolvedNodeManifest;
}

/**
 * Resolves the effective manifest for a node instance. Prefers the
 * registration's `resolveManifest` provider (validated for shape and JSON
 * safety) and falls back to static-plus-dynamic resolution via
 * {@link resolveGraphNodeManifest}.
 */
export class GraphNodeManifestResolver {
  /**
   * Resolves the effective manifest for a node kind. Prefers the
   * registration's `resolveManifest` provider (validated for shape and JSON
   * safety, with the published manifest's namespaces preserved) and falls
   * back to static-plus-dynamic resolution via
   * {@link resolveGraphNodeManifest}.
   *
   * @param {string} kind - Registered node kind the manifest belongs to.
   * @param {GraphNodeManifest} manifest - Published static manifest for the kind.
   * @param {GraphResolvedManifestProvider | undefined} provider - Optional per-registration dynamic manifest provider.
   * @param {GraphNodeInstance} instance - Node instance whose parameters drive dynamic port resolution.
   * @param {GraphNodeResolutionContext} [context] - Optional resolution context forwarded to the provider.
   * @return {Promise<GraphResolvedNodeManifest>} The effective resolved manifest.
   * @throws {GraphNodeRegistrationError} When the provider returns a non-conforming or non-JSON-safe manifest.
   */
  async resolve(
    kind: string,
    manifest: GraphNodeManifest,
    provider: GraphResolvedManifestProvider | undefined,
    instance: GraphNodeInstance,
    context?: GraphNodeResolutionContext
  ): Promise<GraphResolvedNodeManifest> {
    if (provider) {
      const resolved = await provider(instance, context);
      if (!isGraphResolvedNodeManifest(resolved)) {
        throw new GraphNodeRegistrationError(
          `resolveManifest provider for kind '${kind}' returned a value that does not conform to GraphResolvedNodeManifest`
        );
      }
      if (!isGraphJsonSafeValue(resolved)) {
        throw new GraphNodeRegistrationError(
          `resolveManifest provider for kind '${kind}' returned a non-JSON-safe resolved manifest`
        );
      }
      const cloned = cloneGraphJsonValue(
        resolved as unknown as GraphJsonValue
      ) as unknown as GraphResolvedNodeManifest;
      // The provider may build a manifest without the auth requirement; the
      // published manifest remains authoritative for the node's namespaces.
      if (!cloned.namespaces?.length && manifest.namespaces?.length) {
        cloned.namespaces = manifest.namespaces.slice();
      }
      return cloned;
    }
    return resolveGraphNodeManifest(manifest, instance.parameters ?? {});
  }
}
