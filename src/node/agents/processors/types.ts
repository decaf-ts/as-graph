/**
 * @module as-graph/nodes/agents/processors/types
 * @summary Processor/guardrail kind vocabularies (SAA-836 M5).
 * @description The node-level configuration vocabularies of the mastra
 * processor family: the mastra-native processor types an input-processor or
 * output-processor node resolves to, and the guardrail types composing with
 * the output-processor pipeline. Pure string unions/constants — no mastra
 * import — so the main `@decaf-ts/as-graph` surface stays mastra-free; the
 * `@decaf-ts/as-graph/mastra` resolution layer imports this module to build
 * the real `@mastra/core/processors` instances from these discriminators.
 */

/**
 * Mastra-native input-processor (preprocessor) types an input-processor node
 * can resolve to (SAA-836 M5). All map to real `@mastra/core/processors`
 * classes; the model-carrying types take a classifier LLM carried as
 * `modelAdapter` config (R1).
 */
export const MASTRA_INPUT_PROCESSOR_TYPES = [
  "unicodeNormalizer",
  "languageDetector",
  "piiDetector",
  "promptInjectionDetector",
  "systemPromptScrubber",
] as const;

/** A mastra-native input-processor type. */
export type MastraInputProcessorType = (typeof MASTRA_INPUT_PROCESSOR_TYPES)[number];

/**
 * Mastra-native output-processor (post-processor) types an output-processor
 * node can resolve to (SAA-836 M5). All map to real
 * `@mastra/core/processors` classes.
 */
export const MASTRA_OUTPUT_PROCESSOR_TYPES = [
  "tokenLimiter",
  "toolCallFilter",
  "regexFilter",
  "responseCache",
] as const;

/** A mastra-native output-processor type. */
export type MastraOutputProcessorType = (typeof MASTRA_OUTPUT_PROCESSOR_TYPES)[number];

/**
 * Mastra-native guardrail types (SAA-836 M5): the processors that intercept
 * invalid model traffic and can abort execution via mastra's tripwire. All map
 * to real `@mastra/core/processors` classes; the model-carrying types take a
 * classifier LLM carried as `modelAdapter` config (R1).
 */
export const MASTRA_GUARDRAIL_TYPES = [
  "moderation",
  "piiDetector",
  "promptInjectionDetector",
  "regexFilter",
] as const;

/** A mastra-native guardrail type. */
export type MastraGuardrailType = (typeof MASTRA_GUARDRAIL_TYPES)[number];
