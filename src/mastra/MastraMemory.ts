/**
 * @module as-graph/mastra/MastraMemory
 * @summary Mastra memory layer for the agent `memory` zone (SAA-836 M2).
 * @description The memory provider node resolves its **config** into a live
 * mastra-native `Memory`, selecting a storage backend by config. Mastra-first
 * (R3): `libsql` and `pg` are mastra's **native** memory storage backends
 * (`@mastra/libsql`'s `LibSQLStore` and `@mastra/pg`'s `PostgresStore`), and
 * `memory` is mastra's own `InMemoryStore` baseline (no external service — the
 * offline path the memory driver tests and the config-only fallback use). The
 * concrete `Memory` class is mastra's `@mastra/memory` package: `@mastra/core`
 * 1.x ships only the abstract `MastraMemory` base, so wrapping the concrete
 * implementation is the direct-library wrap (R2) — reimplementing memory
 * semantics (conversation history, semantic recall, working memory) in as-graph
 * would be invention. Every path fails closed with
 * {@link GRAPH_MASTRA_MEMORY_UNAVAILABLE} when a provider's connection options
 * are incomplete, so no engine fabricates a memory.
 *
 * Credential gate (SAA-911 F4, gate C): backend configs never carry credential
 * values. Plaintext credential members in `connection` options are refused —
 * never stripped — with {@link GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED}, and `pg`
 * requires a `credentialRef` whose `credentialId` NAMES the environment
 * variable (user-supplied `.env.secret`) carrying the password; the value is
 * resolved from the host environment only at backend-construction time and is
 * never logged, persisted, or held by the graph layer.
 *
 * R9 resource-output semantics: the node's step emits the JSON-safe, secret-free
 * {@link MastraMemoryDescriptor} on its `resource` output; the live `Memory`
 * instance is resolved in-process where it is consumed (the agent runtime) and
 * is **never** persisted — the run store carries the descriptor only.
 *
 * The mastra memory packages are declared peer dependencies and statically
 * imported — C11 forbids dynamic imports under `src/mastra/**` — exactly like
 * `@mastra/core` itself: the `core.agent.memory`/`core.agent.memorySelector`
 * kinds are mastra-only (`graphNodeRequiresMastraEngine`), so every surface
 * that can reach this module already runs on the mastra engine.
 */
import { InMemoryStore, type MastraCompositeStore } from "@mastra/core/storage";
import type { MastraMemory } from "@mastra/core/memory";
import { Memory } from "@mastra/memory";
import { LibSQLStore, type LibSQLConfig } from "@mastra/libsql";
import {
  PostgresStore,
  type PostgresStoreConfig,
} from "@mastra/pg";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import type { GraphWorkflowDocument } from "../shared/graph/document/GraphWorkflowDocument";
import {
  isGraphCredentialReference,
  type GraphCredentialReference,
} from "../shared/graph/catalog/GraphCredentialReference";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import {
  GRAPH_MASTRA_MEMORY_PROVIDER_UNKNOWN,
  GRAPH_MASTRA_MEMORY_UNAVAILABLE,
} from "./types";
import {
  assertNoMastraPlainConnectionCredentials,
  mastraCredentialEnvNameOf,
  resolveMastraCredentialValue,
} from "./MastraEnvironment";
import { MASTRA_AGENT_ZONE } from "../node/agents/zones";

/** The memory storage providers the memory node can be configured with. */
export type MastraMemoryProvider = "memory" | "libsql" | "pg";

/** Every supported memory provider, in palette order. */
export const MASTRA_MEMORY_PROVIDERS: readonly MastraMemoryProvider[] = [
  "memory",
  "libsql",
  "pg",
];

/**
 * The memory configuration a `core.agent.memory` node carries. It is **config**,
 * never a live memory: the host (or the agent runtime) resolves it through
 * {@link resolveMastraMemory} at execution time. Secrets are never carried here
 * as plain values — a backend that needs credentials declares a `credentialRef`
 * instead (gate C).
 */
export interface MastraMemoryConfig {
  /** The selected storage provider. */
  provider: MastraMemoryProvider;
  /** Optional memory id (defaults to the provider). */
  id?: string;
  /** The conversation thread id the agent's invocations bind to. */
  threadId?: string;
  /** The resource id scoping resource-level memory (working memory scope). */
  resourceId?: string;
  /** How many recent messages the agent context keeps (mastra `lastMessages`). */
  lastMessages?: number;
  /** Whether semantic recall is enabled (mastra `semanticRecall`). */
  semanticRecall?: boolean;
  /**
   * The working-memory template (mastra `workingMemory.template`). Setting it
   * enables mastra working memory with this template.
   */
  workingMemoryTemplate?: string;
  /** Whether mastra generates thread titles (mastra `generateTitle`). */
  generateTitle?: boolean;
  /**
   * Advanced mastra `MemoryConfig` options not surfaced as named fields,
   * forwarded verbatim. Named fields override the same key here.
   */
  memoryOptions?: Record<string, unknown>;
  /**
   * Provider connection options. Never carries credential material (gate C,
   * SAA-911 F4): plaintext credential members are refused at resolution time.
   */
  connection?: Record<string, unknown>;
  /**
   * Credential reference resolved by document validation stage 8 (SAA-911
   * F4, gate C): `credentialId` names the environment variable that carries
   * the provider credential; the value is resolved from the host environment
   * (`.env.secret`) only at backend-construction time and is never carried by
   * the config.
   */
  credentialRef?: GraphCredentialReference;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Structural guard for {@link MastraMemoryConfig}: requires a known provider
 * and, when present, well-formed optional fields.
 *
 * @param value - The candidate memory config.
 * @returns `true` when the value is a valid memory configuration.
 */
export function isMastraMemoryConfig(
  value: unknown
): value is MastraMemoryConfig {
  if (!isPlainRecord(value)) return false;
  if (
    typeof value["provider"] !== "string" ||
    !(MASTRA_MEMORY_PROVIDERS as readonly string[]).includes(value["provider"])
  ) {
    return false;
  }
  const credentialRef = value["credentialRef"];
  if (
    credentialRef !== undefined &&
    !isGraphCredentialReference(credentialRef)
  ) {
    return false;
  }
  return true;
}

/**
 * Reads the memory config carried by a document node. Looks at the canonical
 * `memory` parameter first, then the flat node parameter shape; an absent or
 * malformed value returns `undefined` so the caller fails closed instead of
 * resolving a bogus memory.
 *
 * @param node - The canonical node instance.
 * @returns The validated memory config, or `undefined` when none is present.
 */
export function mastraMemoryConfigOf(
  node: GraphNodeInstance
): MastraMemoryConfig | undefined {
  const parameters = node.parameters ?? {};
  const memoryParam = parameters["memory"];
  if (isMastraMemoryConfig(memoryParam)) return memoryParam;
  if (!isMastraMemoryConfig(parameters)) return undefined;
  // Flat node-parameter shape: the flat `memoryId` handle maps onto the
  // canonical config `id` so descriptors and the backend `memories` map
  // resolve by the configured id. A copy is returned so the node instance's
  // parameters are never mutated.
  if (parameters.id === undefined && typeof parameters.memoryId === "string") {
    return { ...parameters, id: parameters.memoryId };
  }
  return parameters;
}

/**
 * The JSON-safe, secret-free descriptor of a resolved memory (R9): the live
 * `MastraMemory` instance is never persisted, only this reference is.
 */
export interface MastraMemoryDescriptor {
  /** Stable discriminator for the resolved-reference descriptor. */
  type: "mastra.memory";
  /** The selected storage provider. */
  provider: MastraMemoryProvider;
  /** The resolved memory id. */
  id: string;
  /** The configured conversation thread id. */
  threadId?: string;
  /** The configured resource id. */
  resourceId?: string;
  /** The configured recent-message window. */
  lastMessages?: number;
  /** The configured semantic-recall flag. */
  semanticRecall?: boolean;
  /** The configured working memory (enabled plus the template, when set). */
  workingMemory?: { enabled: boolean; template?: string };
  /** The configured thread-title generation flag. */
  generateTitle?: boolean;
  /** The credential reference, when one is configured (a reference, not a secret). */
  credentialRef?: GraphCredentialReference;
}

/**
 * Builds the JSON-safe descriptor for a memory config without resolving a live
 * memory. Used by the node's `execute` projection and the step handler so no
 * non-JSON value or secret ever reaches a persisted result.
 *
 * @param config - The validated memory config.
 * @returns The resolved-reference descriptor.
 */
export function mastraMemoryDescriptorOf(
  config: MastraMemoryConfig
): MastraMemoryDescriptor {
  const descriptor: MastraMemoryDescriptor = {
    type: "mastra.memory",
    provider: config.provider,
    id: config.id ?? config.provider,
  };
  if (config.threadId !== undefined) descriptor.threadId = config.threadId;
  if (config.resourceId !== undefined) descriptor.resourceId = config.resourceId;
  if (config.lastMessages !== undefined) {
    descriptor.lastMessages = config.lastMessages;
  }
  if (config.semanticRecall !== undefined) {
    descriptor.semanticRecall = config.semanticRecall;
  }
  if (config.workingMemoryTemplate !== undefined) {
    descriptor.workingMemory = {
      enabled: true,
      template: config.workingMemoryTemplate,
    };
  }
  if (config.generateTitle !== undefined) {
    descriptor.generateTitle = config.generateTitle;
  }
  if (config.credentialRef !== undefined) {
    descriptor.credentialRef = config.credentialRef;
  }
  return descriptor;
}

/**
 * Assembles the mastra `MemoryConfig` options object a resolved `Memory` is
 * constructed with. The named config fields override the same key in the
 * advanced {@link MastraMemoryConfig.memoryOptions} passthrough; a configured
 * working-memory template enables mastra working memory with that template.
 *
 * @param config - The validated memory config.
 * @returns The mastra memory options, or `undefined` when nothing is configured.
 */
export function mastraMemoryOptionsOf(
  config: MastraMemoryConfig
): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {
    ...(config.memoryOptions ?? {}),
  };
  if (config.lastMessages !== undefined) {
    options["lastMessages"] = config.lastMessages;
  }
  if (config.semanticRecall !== undefined) {
    options["semanticRecall"] = config.semanticRecall;
  }
  if (config.generateTitle !== undefined) {
    options["generateTitle"] = config.generateTitle;
  }
  if (
    typeof config.workingMemoryTemplate === "string" &&
    config.workingMemoryTemplate.trim().length > 0
  ) {
    options["workingMemory"] = {
      enabled: true,
      template: config.workingMemoryTemplate,
    };
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Wraps a failure into the fail-closed memory-unavailable error.
 *
 * @param provider - The provider whose backend could not be resolved.
 * @param id - The resolved memory id.
 * @param cause - The underlying failure message.
 * @returns The {@link GraphExecutionError} to throw.
 */
function memoryUnavailable(
  provider: MastraMemoryProvider,
  id: string,
  cause: string
): GraphExecutionError {
  return new GraphExecutionError(
    `The '${provider}' memory provider could not be resolved: ${cause}`,
    GRAPH_MASTRA_MEMORY_UNAVAILABLE,
    { provider, id }
  );
}

/**
 * Resolves a memory config into a live mastra storage backend.
 *
 * Mastra-first (R3): `memory` uses mastra's own `InMemoryStore`; `libsql` and
 * `pg` construct mastra's native memory storage stores (`@mastra/libsql`'s
 * `LibSQLStore` / `@mastra/pg`'s `PostgresStore`) — the two backends this slice
 * implements first (the full storage matrix completes in O1). Both fail closed
 * with {@link GRAPH_MASTRA_MEMORY_UNAVAILABLE} when the connection options are
 * incomplete; an unknown provider fails with
 * {@link GRAPH_MASTRA_MEMORY_PROVIDER_UNKNOWN} — never a fabricated store.
 *
 * Credential gate (SAA-911 F4, gate C): the `pg` connection options must carry
 * a complete non-secret host config (`host`, `port`, `database`, `user`) and a
 * `credentialRef` naming the environment variable that carries the pg
 * password — plaintext credential members in the connection are refused and
 * the credential value is host-resolved from the git-ignored `.env.secret`
 * only at construction time. `libsql` stays credential-free by configuration
 * (its `url` member is required and credential-bearing URLs are outside this
 * slice's scope — see the SAA-911 residual-risk forward item for the O1
 * storage matrix).
 *
 * @param config - The validated memory config.
 * @param id - The resolved memory id the store is constructed with.
 * @returns The live storage instance.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_PLAIN_CREDENTIAL_REFUSED}
 *   when the connection options carry plaintext credential material.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_CREDENTIALS_UNAVAILABLE}
 *   when the pg credential reference is absent, malformed, or its environment
 *   variable is unset or empty.
 * @throws {GraphExecutionError} when the backend options are incomplete or the
 *   provider is unknown.
 */
export async function resolveMastraMemoryStorage(
  config: MastraMemoryConfig,
  id: string
): Promise<MastraCompositeStore> {
  switch (config.provider) {
    case "memory":
      return new InMemoryStore();
    case "libsql": {
      const url = config.connection?.["url"];
      if (typeof url !== "string" || url.length === 0) {
        throw memoryUnavailable(
          config.provider,
          id,
          "the connection options must carry a 'url' (for example 'file:./agent-memory.db')"
        );
      }
      const options: Record<string, unknown> = {
        id,
        url,
        ...config.connection,
      };
      return new LibSQLStore(options as LibSQLConfig);
    }
    case "pg": {
      const context = { provider: "pg", id, surface: "memory" };
      const connection = { ...(config.connection ?? {}) };
      assertNoMastraPlainConnectionCredentials(connection, context);
      const fullHostConfig =
        typeof connection["host"] === "string" &&
        typeof connection["port"] === "number" &&
        typeof connection["database"] === "string" &&
        typeof connection["user"] === "string";
      if (!fullHostConfig) {
        throw memoryUnavailable(
          config.provider,
          id,
          "the connection options must carry a complete non-secret host config ('host', 'port', 'database', 'user') and a credentialRef naming the environment variable that carries the pg password — credential values are host-resolved from the git-ignored .env.secret (gate C, SAA-911 F4)"
        );
      }
      const credentialEnv = mastraCredentialEnvNameOf(
        config,
        context,
        "pg password"
      );
      const password = resolveMastraCredentialValue(credentialEnv);
      const options: Record<string, unknown> = {
        ...connection,
        id,
        password,
      };
      return new PostgresStore(options as PostgresStoreConfig);
    }
    default:
      throw new GraphExecutionError(
        `Unknown mastra memory provider '${String(config.provider)}'`,
        GRAPH_MASTRA_MEMORY_PROVIDER_UNKNOWN,
        { provider: String(config.provider) }
      );
  }
}

/** Options {@link resolveMastraMemory} resolves a memory with. */
export interface MastraMemoryResolveOptions {
  /**
   * A pre-resolved storage instance to construct the memory with, instead of
   * resolving one from the config's provider. Used by hosts that own their
   * storage lifecycle.
   */
  storage?: MastraCompositeStore;
}

/** A resolved memory: the live mastra `Memory` plus its JSON-safe descriptor. */
export interface ResolvedMastraMemory {
  /** The live mastra memory. */
  memory: MastraMemory;
  /** The JSON-safe, secret-free descriptor (R9). */
  descriptor: MastraMemoryDescriptor;
}

/**
 * Resolves a memory config into a live mastra-native `Memory`.
 *
 * The concrete `Memory` class is mastra's `@mastra/memory` package (R2 direct
 * wrap: `@mastra/core` 1.x ships only the abstract `MastraMemory` base, and
 * reimplementing memory semantics in as-graph would be invention). The package
 * is a declared peer dependency, statically imported like `@mastra/core`
 * itself (C11).
 *
 * @param config - The validated memory config.
 * @param options - Optional pre-resolved storage override.
 * @returns The live memory and its JSON-safe descriptor.
 * @throws {GraphExecutionError} when the storage backend cannot be resolved.
 */
export async function resolveMastraMemory(
  config: MastraMemoryConfig,
  options: MastraMemoryResolveOptions = {}
): Promise<ResolvedMastraMemory> {
  const descriptor = mastraMemoryDescriptorOf(config);
  const storage =
    options.storage ?? (await resolveMastraMemoryStorage(config, descriptor.id));
  const memoryOptions = mastraMemoryOptionsOf(config);
  const memory = new Memory({
    storage,
    ...(memoryOptions ? { options: memoryOptions } : {}),
  });
  return { memory, descriptor };
}

/**
 * The memory wiring one memory provider node contributes to an agent node:
 * the source node instance plus its validated memory config.
 */
export interface MastraAgentMemoryWiring {
  /** The memory provider node wired to the agent. */
  node: GraphNodeInstance;
  /** The node's validated memory config. */
  config: MastraMemoryConfig;
}

/**
 * Resolves the memory provider nodes wired to an agent node through the
 * `memory` zone: every connection edge whose target is the agent node's
 * `memory` port and whose source is a node carrying a valid memory config.
 * Connection edges are structural and never route values — this compile-time
 * walk is how the agent runtime learns which memory to resolve and bind.
 *
 * @param document - The document being compiled.
 * @param agentNode - The agent node whose `memory` zone to resolve.
 * @returns The wired memory nodes with their validated configs.
 */
export function connectedMastraMemoryWiringOf(
  document: GraphWorkflowDocument,
  agentNode: GraphNodeInstance
): MastraAgentMemoryWiring[] {
  const nodes = document.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const wiring: MastraAgentMemoryWiring[] = [];
  for (const edge of document.edges ?? []) {
    if (edge.type !== "connection") continue;
    const target = edge.target;
    const source = edge.source;
    if (target.scope !== "node" || target.nodeId !== agentNode.id) continue;
    if (target.port !== MASTRA_AGENT_ZONE.memory) continue;
    if (source.scope !== "node") continue;
    const sourceNode = byId.get(source.nodeId);
    if (!sourceNode) continue;
    const config = mastraMemoryConfigOf(sourceNode);
    if (!config) continue;
    wiring.push({ node: sourceNode, config });
  }
  return wiring;
}
