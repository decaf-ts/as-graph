import { Constructor, Metadata } from "@decaf-ts/decoration";
import { Model } from "@decaf-ts/decorator-validation";
import { ValidationKeys } from "@decaf-ts/decorator-validation";
import { UIKeys } from "../ui/constants";
import {
  GraphKeys,
} from "./constants";
import type {
  GraphNodeDefinition,
  GraphNodeMetadata,
  GraphPortDefinition,
  GraphPortGroupMetadata,
  GraphPortMetadata,
  GraphWorkflowDefinition,
  GraphWorkflowMetadata,
} from "./constants";
import { PortDirection } from "./constants";
import { resolveEffectiveColor, resolveEffectiveIcon } from "./constants";
import "@decaf-ts/ui-decorators";

type GraphModelLike<M extends Model = Model> = Constructor<M> | M;

function resolveModel<M extends Model>(model: GraphModelLike<M>): Constructor<M> {
  const resolved = Metadata.constr(model as Constructor<M>);
  if (typeof resolved === "function") return resolved as Constructor<M>;
  const fallback = (model as Model).constructor;
  if (typeof fallback === "function") return fallback as Constructor<M>;
  return model as Constructor<M>;
}

function asString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : String(value);
}

function pickLabel(
  element?: Record<string, any>,
  prop?: Record<string, any>,
  fallback?: string
) {
  const elementLabel = asString(element?.props?.label ?? element?.props?.name);
  return (
    elementLabel ??
    asString(prop?.name) ??
    fallback ??
    ""
  );
}

function resolveNestedModelConstructor(
  model: Constructor<Model>,
  property: string,
  validation?: Record<string, any>
): Constructor<Model> | undefined {
  // 1. Explicit `model` option on @input({ model: SomeSchema }) — survives
  //    bundler tree-shaking because the class is referenced in the decorator
  //    call, not just in TypeScript's __metadata("design:type", ...).
  const graph = graphPortMetadataOf(model, property);
  if (graph?.model && typeof graph.model === "function" && Model.isModel(graph.model as never)) {
    return graph.model as Constructor<Model>;
  }

  // 2. TypeScript design:type metadata (fragile — bundlers may replace with
  //    Object when the class is tree-shaken).
  const directType = Metadata.type(model, property);
  if (typeof directType === "function" && Model.isModel(directType)) {
    return directType as Constructor<Model>;
  }

  const designTypes = ((Metadata as any).getPropDesignTypes?.(model, property)?.designTypes ||
    []) as unknown[];
  for (const candidate of designTypes) {
    if (typeof candidate === "function" && Model.isModel(candidate as never)) {
      return candidate as Constructor<Model>;
    }
  }

  const customTypes = validation?.[ValidationKeys.TYPE]?.customTypes || [];
  for (const candidate of customTypes as unknown[]) {
    if (typeof candidate === "function" && Model.isModel(candidate as never)) {
      return candidate as Constructor<Model>;
    }
  }

  return undefined;
}

function prefixGraphPortPath(
  port: GraphPortDefinition,
  prefix: string
): GraphPortDefinition {
  const path = [prefix, port.path ?? port.property].filter(Boolean).join(".");
  return {
    ...port,
    path,
    children: port.children?.map((child) => prefixGraphPortPath(child, path)),
  };
}

/**
 * Returns the `@node()` metadata for a constructor, when present.
 */
export function graphNodeMetadataOf<M extends Model>(
  model: GraphModelLike<M>
): GraphNodeMetadata | undefined {
  const resolved = resolveModel(model);
  return Metadata.get(resolved, GraphKeys.NODE) as GraphNodeMetadata | undefined;
}

/**
 * Returns the `@graph()` metadata for a constructor, when present.
 */
export function graphWorkflowMetadataOf<M extends Model>(
  model: GraphModelLike<M>
): GraphWorkflowMetadata | undefined {
  const resolved = resolveModel(model);
  return Metadata.get(resolved, GraphKeys.GRAPH) as GraphWorkflowMetadata | undefined;
}

/**
 * Returns the `@port()` metadata for a property, when present.
 *
 * @param {string} property - The property key to read port metadata for.
 */
export function graphPortMetadataOf<M extends Model>(
  model: GraphModelLike<M>,
  property: keyof M | string
): GraphPortMetadata | undefined {
  const resolved = resolveModel(model);
  return Metadata.get(resolved, Metadata.key(GraphKeys.PORT, String(property))) as
    | GraphPortMetadata
    | undefined;
}

/**
 * Builds the port definition for a node property from its metadata.
 *
 * @param {string} property - The property key to build a port definition for.
 */
export function graphPortDefinitionOf<M extends Model>(
  model: GraphModelLike<M>,
  property: keyof M | string
): GraphPortDefinition | undefined {
  return graphPortDefinitionOfInternal(resolveModel(model), String(property));
}

/**
 * Returns the flattened ports of a Schema-typed `@input` / `@output` property
 * (a "Schema port group"). The Schema's own `@input` / `@output` properties
 * whose direction matches `direction` are spliced into the result UNPREFIXED
 * (no `<schemaProp>.` prefix). The carrier property itself is not a port.
 *
 * Returns `undefined` when the property is not a Schema group (not
 * `graph.schema`, or not Schema-typed), so the caller falls back to the legacy
 * single-port / composite expansion path.
 */
function schemaGroupPorts(
  resolved: Constructor<Model>,
  propertyKey: string,
  direction: PortDirection,
  visited: Set<Constructor<Model>> = new Set()
): GraphPortDefinition[] | undefined {
  const graph = graphPortMetadataOf(resolved, propertyKey);
  if (!graph?.schema) return undefined;
  const validation = (Metadata as any).validationFor(resolved, propertyKey) as
    | Record<string, any>
    | undefined;
  const nestedModel = resolveNestedModelConstructor(resolved, propertyKey, validation);
  if (!nestedModel) return undefined;
  if (visited.has(nestedModel)) return []; // cycle guard — stop recursing
  const nextVisited = new Set(visited);
  nextVisited.add(resolved);
  nextVisited.add(nestedModel);
  const childPorts = graphPortsOfInternal(nestedModel, nextVisited);
  return childPorts.filter((child) => child.direction === direction);
}

function graphPortDefinitionOfInternal(
  resolved: Constructor<Model>,
  propertyKey: string,
  visited: Set<Constructor<Model>> = new Set()
): GraphPortDefinition | undefined {
  const graph = graphPortMetadataOf(resolved, propertyKey);
  if (!graph) return undefined;

  // Schema port group (@input / @output on a Schema-typed property): the
  // carrier is not a port — its Schema's matching-direction ports are spliced
  // into the parent by graphPortsOfInternal. The singular reader returns
  // undefined for the carrier.
  const validation = (Metadata as any).validationFor(resolved, propertyKey) as
    | Record<string, any>
    | undefined;
  const nestedModel = resolveNestedModelConstructor(resolved, propertyKey, validation);
  if (graph.schema && nestedModel) return undefined;

  const element = ((Model as any).uiElementOf(resolved, propertyKey) ||
    undefined) as Record<string, any> | undefined;
  const uiProp = (Model as any).uiDecorationOf(
    resolved,
    propertyKey,
    UIKeys.PROP
  ) as Record<string, any> | undefined;
  const designType = Metadata.type(resolved, propertyKey);
  const typeName = asString(
    validation?.[ValidationKeys.TYPE]?.customTypes?.[0]?.name ??
      element?.props?.type ??
      uiProp?.type ??
      designType?.name
  );
  const shouldExpand = !!graph.expand || (!!nestedModel && !visited.has(nestedModel));
  const children =
    shouldExpand && nestedModel
      ? (() => {
          const nextVisited = new Set(visited);
          nextVisited.add(resolved);
          nextVisited.add(nestedModel);
          return graphPortsOfInternal(nestedModel, nextVisited).map((child) =>
            prefixGraphPortPath(child, propertyKey)
          );
        })()
      : undefined;

  return {
    property: propertyKey,
    path: propertyKey,
    direction: graph.direction,
    name: propertyKey,
    label: pickLabel(element, uiProp, propertyKey),
    type: typeName?.toLowerCase(),
    required: !!validation?.[ValidationKeys.REQUIRED],
    hidden: !!(Model as any).uiIsHidden(resolved, propertyKey),
    designType: designType?.name,
    element,
    prop: uiProp,
    validation,
    graph,
    connectionRules: graph.connectionRules,
    composite: !!children?.length,
    children,
    model: nestedModel?.name,
  };
}

/**
 * Returns the port definitions of a node constructor.
 */
export function graphPortsOf<M extends Model>(
  model: GraphModelLike<M>
): GraphPortDefinition[] {
  return graphPortsOfInternal(resolveModel(model));
}

function graphPortsOfInternal(
  resolved: Constructor<Model>,
  visited: Set<Constructor<Model>> = new Set()
): GraphPortDefinition[] {
  const properties = Metadata.properties(resolved) || [];
  const result: GraphPortDefinition[] = [];
  for (const property of properties) {
    const key = String(property);
    const graph = graphPortMetadataOf(resolved, key);
    // Schema port group: splice the Schema's matching-direction ports
    // (unprefixed) instead of emitting the carrier.
    if (graph?.schema) {
      const groupPorts = schemaGroupPorts(resolved, key, graph.direction, visited);
      if (groupPorts) {
        result.push(...groupPorts);
        continue;
      }
    }
    const port = graphPortDefinitionOfInternal(resolved, key, visited);
    if (port) result.push(port);
  }
  return result;
}

/**
 * Returns the leaf ports of a set of port definitions, expanding composite groups.
 */
export function graphLeafPortsOf(ports: GraphPortDefinition[]): GraphPortDefinition[] {
  return ports.flatMap((port) =>
    port.children && port.children.length ? graphLeafPortsOf(port.children) : [port]
  );
}

/**
 * Returns the leaf input ports of a workflow constructor.
 */
export function graphWorkflowInputLeafPortsOf<M extends Model>(
  model: GraphModelLike<M>
): GraphPortDefinition[] {
  return graphLeafPortsOf(graphWorkflowDefinitionOf(model).inputs);
}

/**
 * Returns the leaf output ports of a workflow constructor.
 */
export function graphWorkflowOutputLeafPortsOf<M extends Model>(
  model: GraphModelLike<M>
): GraphPortDefinition[] {
  return graphLeafPortsOf(graphWorkflowDefinitionOf(model).outputs);
}

/**
 * Builds the graph node definition for a constructor from its metadata.
 */
export function graphDefinitionOf<M extends Model>(
  model: GraphModelLike<M>
): GraphNodeDefinition {
  const resolved = resolveModel(model);
  const ui = (Model as any).uiModelOf(resolved);
  const graph = graphNodeMetadataOf(resolved) || {};
  const tag = ui?.tag || resolved.name;
  const ports = graphPortsOf(resolved);
  const portGroups = resolvePortGroups(resolved, graph);

  return {
    name: resolved.name,
    tag,
    kind: graph.kind || tag,
    category: graph.category,
    color: graph.color,
    effectiveColor: resolveEffectiveColor(graph.color, graph.category),
    group: graph.group,
    height: graph.height,
    icon: graph.icon,
    effectiveIcon: resolveEffectiveIcon(graph.icon, graph.category),
    labels: graph.labels || [],
    maxChildren: graph.maxChildren,
    minWidth: graph.minWidth,
    width: graph.width,
    shape: graph.shape,
    cornerRadius: graph.cornerRadius,
    sizeRules: graph.sizeRules,
    props: ui?.props,
    ui,
    graph,
    ports,
    portGroups,
  };
}

/**
 * Builds the effective `portGroups` list for a node: starts from the declared
 * `GraphNodeMetadata.portGroups` and ensures every Schema-typed `@input` /
 * `@output` property not explicitly listed gets a default
 * `{ property, toggle: "all" }` entry. Non-Schema-typed `@input` / `@output`
 * properties are not groups and are ignored.
 */
function resolvePortGroups(
  resolved: Constructor<Model>,
  graph: GraphNodeMetadata
): GraphPortGroupMetadata[] | undefined {
  const declared = graph.portGroups || [];
  const declaredByProperty = new Map(declared.map((g) => [g.property, g]));
  const groups: GraphPortGroupMetadata[] = [];
  const properties = Metadata.properties(resolved) || [];
  for (const property of properties) {
    const key = String(property);
    const portMeta = graphPortMetadataOf(resolved, key);
    if (!portMeta?.schema) continue;
    const validation = (Metadata as any).validationFor(resolved, key) as
      | Record<string, any>
      | undefined;
    const nestedModel = resolveNestedModelConstructor(resolved, key, validation);
    if (!nestedModel) continue; // not Schema-typed — not a group
    const declaredGroup = declaredByProperty.get(key);
    groups.push(
      declaredGroup
        ? { ...declaredGroup, toggle: declaredGroup.toggle ?? "all" }
        : { property: key, toggle: "all" as const }
    );
  }
  // also keep declared groups that don't correspond to a Schema property
  // (defensive — lets callers carry labels for future groups)
  for (const g of declared) {
    if (!groups.some((x) => x.property === g.property)) groups.push(g);
  }
  return groups.length ? groups : undefined;
}

/**
 * Detects an already-resolved {@link GraphWorkflowDefinition} — the plain-object
 * shape returned by {@link graphWorkflowDefinitionOf}, as opposed to a decorated
 * workflow class or model instance.
 *
 * Resolved definitions are values, not models: `resolveModel` maps them to
 * `Object`, so without this guard `graphWorkflowDefinitionOf` would rebuild an
 * empty definition and silently drop `nodes`/`relations`. Loop bodies already
 * resolved by the caller (e.g. `for-angular`'s `metadata.loop.body`) rely on
 * this round-trip.
 *
 * @returns {boolean} `true` when the value is an already-resolved workflow definition.
 */
export function isGraphWorkflowDefinition(
  value: unknown
): value is GraphWorkflowDefinition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GraphWorkflowDefinition>;
  return (
    typeof candidate.kind === "string" &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.relations) &&
    Array.isArray(candidate.inputs) &&
    Array.isArray(candidate.outputs) &&
    !!candidate.workflow &&
    typeof candidate.workflow === "object"
  );
}

/**
 * Builds the workflow definition for a constructor from its metadata.
 */
export function graphWorkflowDefinitionOf<M extends Model>(
  model: GraphModelLike<M>
): GraphWorkflowDefinition {
  if (isGraphWorkflowDefinition(model)) return model;
  const resolved = resolveModel(model);
  const workflow = graphWorkflowMetadataOf(resolved) || {};
  const node = graphDefinitionOf(resolved);
  const inputs =
    workflow.inputs ||
    node.ports.filter((port) => port.direction === PortDirection.INPUT);
  const outputs =
    workflow.outputs ||
    node.ports.filter((port) => port.direction === PortDirection.OUTPUT);
  const connections =
    workflow.connections ||
    node.ports.filter((port) => port.direction === PortDirection.CONNECTION);

  return {
    ...node,
    kind: workflow.kind || node.kind,
    category: workflow.category ?? node.category,
    color: workflow.color ?? node.color,
    effectiveColor: resolveEffectiveColor(workflow.color ?? node.color, workflow.category ?? node.category),
    group: workflow.group ?? node.group,
    height: workflow.height ?? node.height,
    icon: workflow.icon ?? node.icon,
    effectiveIcon: resolveEffectiveIcon(workflow.icon ?? node.icon, workflow.category ?? node.category),
    labels: workflow.labels || node.labels,
    maxChildren: workflow.maxChildren ?? node.maxChildren,
    minWidth: workflow.minWidth ?? node.minWidth,
    width: workflow.width ?? node.width,
    inputs,
    outputs,
    connections,
    nodes: workflow.nodes || [],
    relations: workflow.relations || [],
    workflow,
  };
}
