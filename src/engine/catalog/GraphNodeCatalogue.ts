/**
 * @module as-graph/engine/catalog/GraphNodeCatalogue
 * @summary Trusted backend node catalogue (DECAF-50 §4.10–§4.12).
 * @description The single registry of node kinds the nine-stage validator
 * resolves against and the execution engine pulls executors from.
 * Registrations are validated fail-fast on
 * {@link GraphNodeCatalogue.register} (manifest serializability, static
 * ports, parameters, dynamic-port rules, credentials, method declarations)
 * and manifests are served as JSON-safe clones — never class instances.
 */
import {
  Service,
  service,
  Context,
  type ContextualArgs,
  type MaybeContextualArg,
} from "@decaf-ts/core";
import type {
  GraphJsonValue,
  GraphNodeManifest,
  GraphNodeMethodManifest,
  GraphPortManifest,
} from "../../shared/graph";
import {
  assertGraphNodeManifestSerializable,
  cloneGraphJsonValue,
  isGraphCredentialRequirement,
  isGraphNodeMethodManifest,
  isGraphUnsafeObjectKey,
} from "../../shared/graph";
import type { GraphNodeInstance } from "../../shared/graph";
import type { GraphNodeExecutor } from "../execution/GraphNodeExecutor";
import type {
  GraphCatalogueQueryContext,
  GraphNodeResolutionContext,
  GraphResolvedNodeManifest,
} from "../../shared/graph";
import {
  GraphNodeRegistrationError,
  GraphNodeNotFoundError,
} from "./GraphCatalogueErrors";
import type {
  GraphNodeMethod,
  GraphNodeRegistration,
  GraphNodeRegistrationOptions,
} from "./GraphNodeRegistration";
import { GraphNodeMethodRegistry } from "./GraphNodeMethodRegistry";
import { GraphNodeManifestResolver } from "./GraphNodeManifestResolver";

const GRAPH_PORT_BINDING_MODES = ["edge", "literal", "expression"] as const;

type GraphPortBindingMode = (typeof GRAPH_PORT_BINDING_MODES)[number];

function isGraphPortBindingMode(value: unknown): value is GraphPortBindingMode {
  return (GRAPH_PORT_BINDING_MODES as readonly string[]).includes(value as string);
}

interface GraphCatalogueEntry {
  registration: GraphNodeRegistration;
  methods: GraphNodeMethodRegistry;
  placeholderManifest: boolean;
}

function assertValidPortId(kind: string, scope: string, id: string): void {
  if (typeof id !== "string" || !id) {
    throw new GraphNodeRegistrationError(
      `Manifest for kind '${kind}' has a ${scope} with an empty port id`
    );
  }
  if (isGraphUnsafeObjectKey(id)) {
    throw new GraphNodeRegistrationError(
      `Manifest for kind '${kind}' has a ${scope} with unsafe port id '${id}'`
    );
  }
}

function validateStaticPorts(kind: string, manifest: GraphNodeManifest): void {
  const buckets: [string, GraphPortManifest[]][] = [
    ["input", manifest.inputs],
    ["output", manifest.outputs],
    ["connection", manifest.connections ?? []],
  ];
  for (const [scope, ports] of buckets) {
    const seen = new Set<string>();
    for (const port of ports) {
      assertValidPortId(kind, `${scope} port`, port?.id);
      if (seen.has(port.id)) {
        throw new GraphNodeRegistrationError(
          `Manifest for kind '${kind}' declares duplicate static ${scope} port id '${port.id}'`
        );
      }
      seen.add(port.id);
      if (port.defaultMode !== undefined && !isGraphPortBindingMode(port.defaultMode)) {
        throw new GraphNodeRegistrationError(
          `Manifest for kind '${kind}' declares invalid default binding mode '${String(port.defaultMode)}' on ${scope} port '${port.id}'`
        );
      }
    }
  }
}

function validateParameters(kind: string, manifest: GraphNodeManifest): Set<string> {
  const ids = new Set<string>();
  for (const parameter of manifest.parameters) {
    const id = parameter?.id;
    if (typeof id !== "string" || !id) {
      throw new GraphNodeRegistrationError(
        `Manifest for kind '${kind}' has a parameter with an empty id`
      );
    }
    if (isGraphUnsafeObjectKey(id)) {
      throw new GraphNodeRegistrationError(
        `Manifest for kind '${kind}' has a parameter with unsafe id '${id}'`
      );
    }
    if (ids.has(id)) {
      throw new GraphNodeRegistrationError(
        `Manifest for kind '${kind}' declares duplicate parameter id '${id}'`
      );
    }
    ids.add(id);
  }
  return ids;
}

function validateDynamicPortRules(
  kind: string,
  manifest: GraphNodeManifest,
  parameterIds: Set<string>
): void {
  for (const rule of manifest.dynamicPorts ?? []) {
    if (!rule || typeof rule.parameter !== "string" || !rule.parameter) {
      throw new GraphNodeRegistrationError(
        `Manifest for kind '${kind}' has a dynamic-port rule without a parameter reference`
      );
    }
    if (!parameterIds.has(rule.parameter)) {
      throw new GraphNodeRegistrationError(
        `Manifest for kind '${kind}' has a dynamic-port rule referencing missing parameter '${rule.parameter}'`
      );
    }
    if (rule.type === "togglePort") {
      if (!rule.port) {
        throw new GraphNodeRegistrationError(
          `Manifest for kind '${kind}' has a togglePort rule without a port`
        );
      }
      assertValidPortId(kind, "togglePort rule port", rule.port.id);
    }
    if (rule.type === "repeatFromParameter" && typeof rule.portIdTemplate !== "string") {
      throw new GraphNodeRegistrationError(
        `Manifest for kind '${kind}' has a repeatFromParameter rule without a portIdTemplate`
      );
    }
  }
}

function validateCredentials(kind: string, manifest: GraphNodeManifest): void {
  for (const credential of manifest.credentials ?? []) {
    if (!isGraphCredentialRequirement(credential)) {
      throw new GraphNodeRegistrationError(
        `Manifest for kind '${kind}' has a malformed credential requirement`
      );
    }
    if (!credential.type) {
      throw new GraphNodeRegistrationError(
        `Manifest for kind '${kind}' has a credential requirement with an empty type`
      );
    }
  }
}

function validateMethodDeclarations(
  kind: string,
  manifest: GraphNodeManifest
): void {
  for (const declaration of manifest.methods ?? []) {
    if (!isGraphNodeMethodManifest(declaration)) {
      throw new GraphNodeRegistrationError(
        `Manifest for kind '${kind}' has a malformed method declaration`
      );
    }
  }
}

function assertValidRegistration(
  registration: GraphNodeRegistration
): asserts registration is GraphNodeRegistration {
  if (!registration || typeof registration !== "object") {
    throw new GraphNodeRegistrationError("Graph node registration is required");
  }
  if (!registration.manifest || typeof registration.manifest !== "object") {
    throw new GraphNodeRegistrationError(
      "Graph node registration is missing a manifest"
    );
  }
  if (!registration.executor || typeof registration.executor.execute !== "function") {
    throw new GraphNodeRegistrationError(
      `Graph node registration for kind '${String(registration.manifest?.kind)}' is missing an executor`
    );
  }
}

/**
 * Backend-side trusted node catalogue (DECAF-50 §4.10–§4.12): the single
 * registry of node kinds the nine-stage validator resolves against and the
 * execution engine pulls executors from. Registrations are validated on
 * {@link GraphNodeCatalogue.register} (manifest serializability, static
 * ports, parameters, dynamic-port rules, credentials, method declarations)
 * and manifests are served as JSON-safe clones — never class instances.
 * Supports the transition path via
 * {@link GraphNodeCatalogue.registerExecutor}, which creates placeholder
 * manifests with lenient policies for legacy executor-only registrations
 * (removed at cutover, P7).
 */
@service()
export class GraphNodeCatalogue extends Service {
  private readonly entries = new Map<string, GraphCatalogueEntry>();
  private readonly resolver = new GraphNodeManifestResolver();
  /**
   * Fallback context used only when a caller supplies none. Production callers
   * (engine, validators, controllers, boot factories) always thread the single
   * run/boot context; direct catalogue use (e.g. boot-time registration) falls
   * back to this instance-scoped context so the synchronous `logCtx` path always
   * receives exactly one context.
   */
  private readonly fallbackContext = new Context();

  constructor() {
    super();
  }

  /**
   * Normalizes caller arguments to a single `Context`, reusing the caller's when
   * present and otherwise supplying the catalogue's fallback context.
   */
  private withContext(
    args: MaybeContextualArg<Context>
  ): ContextualArgs<Context> {
    const last = args[args.length - 1];
    return last instanceof Context ? (args as ContextualArgs<Context>) : [this.fallbackContext];
  }

  /**
   * Validates and registers a node kind. Throws
   * {@link GraphNodeRegistrationError} on invalid manifests, and on duplicate
   * kinds unless `options.replace` is set.
   */
  register(
    registration: GraphNodeRegistration,
    options: GraphNodeRegistrationOptions = {},
    ...args: MaybeContextualArg<Context>
  ): this {
    const { log } = this.logCtx(this.withContext(args), "register").for(
      this.register
    );
    log.debug(
      `Registering graph node kind '${registration?.manifest?.kind ?? "unknown"}'`
    );
    assertValidRegistration(registration);
    const manifest = registration.manifest;

    if (typeof manifest.kind !== "string" || !manifest.kind.trim()) {
      throw new GraphNodeRegistrationError(
        "Graph node manifest kind is required and must be a non-empty string"
      );
    }
    const kind = manifest.kind;

    if (this.entries.has(kind) && !options.replace) {
      throw new GraphNodeRegistrationError(
        `Graph node kind '${kind}' is already registered; pass { replace: true } to replace it`
      );
    }

    try {
      assertGraphNodeManifestSerializable(manifest);
    } catch (e) {
      throw new GraphNodeRegistrationError(
        `Manifest for kind '${kind}' is not JSON-serializable: ${(e as Error).message}`
      );
    }

    validateStaticPorts(kind, manifest);
    const parameterIds = validateParameters(kind, manifest);
    validateDynamicPortRules(kind, manifest, parameterIds);
    validateCredentials(kind, manifest);
    validateMethodDeclarations(kind, manifest);
    const methods = new GraphNodeMethodRegistry(
      kind,
      manifest.methods ?? [],
      registration.methods ?? {}
    );

    this.entries.set(kind, {
      registration,
      methods,
      placeholderManifest: false,
    });
    return this;
  }

  /**
   * Registers an executor for a kind. When the kind has no manifest yet, a
   * placeholder manifest is created with transition-leniency policies
   * (`allowUndeclaredParameters`/`allowUnknownOutputs`, DECAF-50 §4.18) that
   * are removed at cutover (P7).
   */
  registerExecutor(
    kind: string,
    executor: GraphNodeExecutor,
    ...args: MaybeContextualArg<Context>
  ): this {
    const { log } = this.logCtx(this.withContext(args), "registerExecutor").for(
      this.registerExecutor
    );
    log.debug(`Registering graph executor for kind '${kind}'`);
    if (typeof kind !== "string" || !kind.trim()) {
      throw new GraphNodeRegistrationError("Graph executor kind is required");
    }
    if (!executor || typeof executor.execute !== "function") {
      throw new GraphNodeRegistrationError(
        `Executor registered for kind '${kind}' is missing an execute method`
      );
    }
    const existing = this.entries.get(kind);
    if (existing) {
      existing.registration = { ...existing.registration, executor };
      return this;
    }
    const manifest: GraphNodeManifest = {
      kind,
      display: { name: kind },
      inputs: [],
      outputs: [],
      parameters: [],
      // Transition leniency (DECAF-50 §4.8/§4.9/§4.18): placeholder manifests
      // created for legacy executor-only registrations accept undeclared
      // parameters and unknown outputs until cutover (P7).
      policies: {
        allowUndeclaredParameters: true,
        allowUnknownOutputs: true,
      },
    };
    this.entries.set(kind, {
      registration: { manifest, executor },
      methods: new GraphNodeMethodRegistry(kind, [], {}),
      placeholderManifest: true,
    });
    return this;
  }

  /** Removes a kind registration. */
  unregister(kind: string, ...args: MaybeContextualArg<Context>): this {
    const { log } = this.logCtx(this.withContext(args), "unregister").for(this.unregister);
    log.debug(`Unregistering graph node kind '${kind}'`);
    this.entries.delete(kind);
    return this;
  }

  /** Whether a kind is registered. */
  has(kind: string, ...args: MaybeContextualArg<Context>): boolean {
    this.logCtx(this.withContext(args), "has").for(this.has);
    return this.entries.has(kind);
  }

  private entry(kind: string): GraphCatalogueEntry {
    const entry = this.entries.get(kind);
    if (!entry) {
      throw new GraphNodeNotFoundError(
        `No graph node kind '${kind}' is registered in the catalogue`
      );
    }
    return entry;
  }

  /** Returns a JSON-safe clone of the kind's registered manifest. */
  getManifest(kind: string, ...args: MaybeContextualArg<Context>): GraphNodeManifest {
    this.logCtx(this.withContext(args), "getManifest").for(this.getManifest);
    return cloneGraphJsonValue(
      this.entry(kind).registration.manifest as unknown as GraphJsonValue
    ) as unknown as GraphNodeManifest;
  }

  /** Returns the kind's registered executor. */
  getExecutor(kind: string, ...args: MaybeContextualArg<Context>): GraphNodeExecutor {
    this.logCtx(this.withContext(args), "getExecutor").for(this.getExecutor);
    return this.entry(kind).registration.executor;
  }

  /** Returns the declared method manifest for a kind, if declared. */
  getMethodDeclaration(
    kind: string,
    method: string,
    ...args: MaybeContextualArg<Context>
  ): GraphNodeMethodManifest {
    this.logCtx(this.withContext(args), "getMethodDeclaration").for(this.getMethodDeclaration);
    return this.entry(kind).methods.getDeclaration(method);
  }

  /** Returns the registered method implementation for a kind. */
  getMethod(
    kind: string,
    method: string,
    ...args: MaybeContextualArg<Context>
  ): GraphNodeMethod {
    this.logCtx(this.withContext(args), "getMethod").for(this.getMethod);
    this.entry(kind).methods.getDeclaration(method);
    return this.entry(kind).methods.get(method);
  }

  /** Lists all method declarations registered for a kind. */
  listMethodDeclarations(
    kind: string,
    ...args: MaybeContextualArg<Context>
  ): GraphNodeMethodManifest[] {
    this.logCtx(this.withContext(args), "listMethodDeclarations").for(
      this.listMethodDeclarations
    );
    return this.entry(kind).methods.list();
  }

  /** Lists registered manifests, optionally filtered by kind and display category. */
  listManifests(
    context?: GraphCatalogueQueryContext,
    ...args: MaybeContextualArg<Context>
  ): GraphNodeManifest[] {
    this.logCtx(this.withContext(args), "listManifests").for(this.listManifests);
    const kinds = [...this.entries.keys()].sort();
    const categoryFilter = context?.categories?.length
      ? new Set(context.categories)
      : undefined;
    const kindFilter = context?.kinds?.length ? new Set(context.kinds) : undefined;
    const manifests: GraphNodeManifest[] = [];
    for (const kind of kinds) {
      if (kindFilter && !kindFilter.has(kind)) continue;
      const manifest = this.getManifest(kind, ...args);
      if (categoryFilter && !categoryFilter.has(manifest.display.category ?? "")) {
        continue;
      }
      manifests.push(manifest);
    }
    return manifests;
  }

  /** Lists all registered kinds, sorted. */
  listKinds(...args: MaybeContextualArg<Context>): string[] {
    this.logCtx(this.withContext(args), "listKinds").for(this.listKinds);
    return [...this.entries.keys()].sort();
  }

  /** Number of registered kinds. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Resolves the effective manifest for a node instance (dynamic ports
   * expanded, instance context applied) as a
   * {@link GraphResolvedNodeManifest}.
   */
  async resolveManifest(
    kind: string,
    instance: GraphNodeInstance,
    context?: GraphNodeResolutionContext,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphResolvedNodeManifest> {
    this.logCtx(this.withContext(args), "resolveManifest").for(this.resolveManifest);
    const entry = this.entry(kind);
    return this.resolver.resolve(
      kind,
      entry.registration.manifest,
      entry.registration.resolveManifest,
      instance,
      context
    );
  }
}
