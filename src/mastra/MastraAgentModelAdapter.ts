/**
 * @module as-graph/mastra/MastraAgentModelAdapter
 * @summary Model-adapter-in-config for the mastra agent node (SAA-837 M1, R1).
 * @description The agent node carries its LLM as **configuration** — a provider
 * id, a model id, and an optional credential reference — instead of as a
 * dedicated model-provider node kind (R1: no model-provider kinds). This module
 * is the single authority for that config shape, its structural guard, and the
 * translation into the `@mastra/core` model config the agent is constructed with.
 * The credential **reference** is validated by the existing credential-reference
 * validation (document validation stage 8); this module never resolves a secret
 * value and never persists one.
 */
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import {
  isGraphCredentialReference,
  type GraphCredentialReference,
} from "../shared/graph/catalog/GraphCredentialReference";

/**
 * The model-adapter configuration an agent node carries in its `modelAdapter`
 * parameter (R1). `provider` and `modelId` compose the mastra model id
 * (`<provider>/<modelId>`); `credentialRef` is a reference resolved by the
 * existing credential-reference validation, never a plain secret. It is named
 * `credentialRef` (not `credentials`) because a `credentials` key is on the
 * stage-8 plain-secret deny-list — the reference object itself
 * (`credentialId`/`credentialType`) passes the same scan.
 */
export interface MastraModelAdapterConfig {
  /** Provider discriminator (e.g. `openai`, `anthropic`). */
  provider: string;
  /** Provider-specific model id (e.g. `gpt-4o-mini`). */
  modelId: string;
  /** Optional credential reference validated by document validation stage 8. */
  credentialRef?: GraphCredentialReference;
  /** Optional per-model retry budget forwarded to mastra. */
  maxRetries?: number;
  /** Optional model settings forwarded to mastra (temperature, …). */
  modelSettings?: Record<string, unknown>;
  /** Optional provider-specific options forwarded to mastra. */
  providerOptions?: Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Structural guard for {@link MastraModelAdapterConfig}: requires non-empty
 * `provider` and `modelId` strings and, when present, a well-formed credential
 * reference.
 *
 * @param value - The candidate adapter config.
 * @returns `true` when the value is a valid model-adapter configuration.
 */
export function isMastraModelAdapterConfig(
  value: unknown
): value is MastraModelAdapterConfig {
  if (!isPlainRecord(value)) return false;
  if (typeof value["provider"] !== "string" || value["provider"].length === 0) {
    return false;
  }
  if (typeof value["modelId"] !== "string" || value["modelId"].length === 0) {
    return false;
  }
  const credentialRef = value["credentialRef"];
  if (credentialRef !== undefined && !isGraphCredentialReference(credentialRef)) {
    return false;
  }
  return true;
}

/**
 * Reads the model-adapter config carried by a document node. Looks at the
 * canonical `modelAdapter` parameter only; an absent or malformed value returns
 * `undefined` so the caller fails closed instead of constructing a bogus model.
 *
 * @param node - The canonical node instance.
 * @returns The validated adapter config, or `undefined` when none is present.
 */
export function graphModelAdapterOf(
  node: GraphNodeInstance
): MastraModelAdapterConfig | undefined {
  const candidate = node.parameters?.["modelAdapter"];
  return isMastraModelAdapterConfig(candidate) ? candidate : undefined;
}

/** The `@mastra/core` model config derived from a {@link MastraModelAdapterConfig}. */
export interface MastraModelConfig {
  /** The composed `<provider>/<modelId>` model id mastra resolves. */
  id: string;
  /** Optional per-model retry budget forwarded to mastra. */
  maxRetries?: number;
  /** Optional model settings forwarded to mastra. */
  modelSettings?: Record<string, unknown>;
  /** Optional provider-specific options forwarded to mastra. */
  providerOptions?: Record<string, unknown>;
}

/**
 * Translates a {@link MastraModelAdapterConfig} into the `@mastra/core` model
 * config. Never injects an API key: the provider reads its own environment
 * (`.env.secret`, gate C) at call time, so no secret is ever held in the graph
 * document, node parameters, or this translation.
 *
 * @param adapter - The validated adapter config.
 * @returns The mastra model config the agent is constructed with.
 */
export function mastraModelConfigOf(adapter: MastraModelAdapterConfig): MastraModelConfig {
  const config: MastraModelConfig = { id: `${adapter.provider}/${adapter.modelId}` };
  if (typeof adapter.maxRetries === "number") config.maxRetries = adapter.maxRetries;
  if (adapter.modelSettings) config.modelSettings = adapter.modelSettings;
  if (adapter.providerOptions) config.providerOptions = adapter.providerOptions;
  return config;
}
