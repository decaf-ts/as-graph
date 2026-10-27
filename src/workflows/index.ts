/**
 * @module as-graph/workflows
 * @summary Neutral workflow fixture surfaces plus the engine-neutral (basic)
 * demo registry (SAA-2049, SAA-1545 §5).
 * @description This entrypoint is safe for the local/general engine: it exports
 * the shared fixture types/builders and the `basic/` registry only. The Mastra
 * fixture registry is a separate subpath (`./workflows/mastra`) so importing or
 * booting the basic set never loads a Mastra node implementation.
 */
export * from "./types";
export * from "./coverage";
export * from "./builders";
export * from "./basic";
