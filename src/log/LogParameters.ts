/**
 * @module as-graph/log/LogParameters
 * @summary DECAF-9 LogParameterDescriptor registrations for run log attributes.
 * @description Registers the DECAF-48 run-identity attributes (`nodeId`,
 * `workflowId`, `runId`, `user`) as {@link LogParameterDescriptor} entries so
 * the MiniLogger pipeline renders them as discrete columns when present
 * (DECAF-48 §4.3 / §4.6; DECAF-9 §4.1, §4.6). The values come through
 * `logger.for({...}).log(...)` from `ctx` — no parallel logging path.
 *
 * The module is imported by the graph engine entrypoint (`../index.ts`), so
 * registration happens once at module load and stays idempotent across
 * re-imports and hot reloads.
 */
import type { LogParameterDescriptor } from "@decaf-ts/logging";
import { logParameterRegistry } from "@decaf-ts/logging";

import { GraphLogAttribute } from "../shared/graph";

/** Registry modules may re-run (tests / hot reload); keep it idempotent. */
const registered = new Set<string>();

/**
 * Reads a custom attribute off the config snapshot, tolerating non-standard
 * keys that the logger's `for({...})` config may carry.
 *
 * @param payload - The log parameter payload exposing the `config` snapshot.
 * @param key - The custom attribute key to read.
 * @returns The value bound to `key`, or `undefined` when absent.
 */
function configAttribute(
  payload: { config: Record<string, unknown> },
  key: string
): unknown {
  return (payload.config as Record<string, unknown>)[key];
}

/** Renders a string-list attribute as a comma-separated column value. */
function renderStringList(value: unknown): string {
  return Array.isArray(value) ? value.map((entry) => String(entry)).join(", ") : String(value);
}

/**
 * Registers the four DECAF-48 run attributes as log parameter descriptors
 * (nodeId / workflowId / runId / user). Rendered only when keyed with a
 * non-null value so one-shot module imports from other packages never leak
 * empty columns.
 */
export function registerGraphRunLogParameters(): void {
  const descriptors: LogParameterDescriptor[] = [
    {
      key: GraphLogAttribute.NODE_ID,
      shouldInclude(payload) {
        return configAttribute(payload, GraphLogAttribute.NODE_ID) != null;
      },
      render(payload) {
        return String(configAttribute(payload, GraphLogAttribute.NODE_ID));
      },
    },
    {
      key: GraphLogAttribute.WORKFLOW_ID,
      shouldInclude(payload) {
        return configAttribute(payload, GraphLogAttribute.WORKFLOW_ID) != null;
      },
      render(payload) {
        return String(configAttribute(payload, GraphLogAttribute.WORKFLOW_ID));
      },
    },
    {
      key: GraphLogAttribute.RUN_ID,
      shouldInclude(payload) {
        return configAttribute(payload, GraphLogAttribute.RUN_ID) != null;
      },
      render(payload) {
        return String(configAttribute(payload, GraphLogAttribute.RUN_ID));
      },
    },
    {
      key: GraphLogAttribute.USER,
      shouldInclude(payload) {
        return configAttribute(payload, GraphLogAttribute.USER) != null;
      },
      render(payload) {
        return String(configAttribute(payload, GraphLogAttribute.USER));
      },
    },
    {
      key: GraphLogAttribute.ROLES,
      shouldInclude(payload) {
        const value = configAttribute(payload, GraphLogAttribute.ROLES);
        return Array.isArray(value) && value.length > 0;
      },
      render(payload) {
        return renderStringList(configAttribute(payload, GraphLogAttribute.ROLES));
      },
    },
    {
      key: GraphLogAttribute.NAMESPACES,
      shouldInclude(payload) {
        const value = configAttribute(payload, GraphLogAttribute.NAMESPACES);
        return Array.isArray(value) && value.length > 0;
      },
      render(payload) {
        return renderStringList(configAttribute(payload, GraphLogAttribute.NAMESPACES));
      },
    },
    {
      key: GraphLogAttribute.ORGANIZATION,
      shouldInclude(payload) {
        return configAttribute(payload, GraphLogAttribute.ORGANIZATION) != null;
      },
      render(payload) {
        return String(configAttribute(payload, GraphLogAttribute.ORGANIZATION));
      },
    },
    {
      key: GraphLogAttribute.IP,
      shouldInclude(payload) {
        return configAttribute(payload, GraphLogAttribute.IP) != null;
      },
      render(payload) {
        return String(configAttribute(payload, GraphLogAttribute.IP));
      },
    },
  ];

  for (const descriptor of descriptors) {
    if (registered.has(descriptor.key)) continue;
    logParameterRegistry.register(descriptor);
    registered.add(descriptor.key);
  }
}

registerGraphRunLogParameters();
