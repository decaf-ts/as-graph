/**
 * @module as-graph/shared
 * @description Frontend-shared graph surface. Everything under this entry point
 * is code the UI must also know about: the decorated-node/workflow metadata
 * contracts, the canonical workflow document and its (de)serialization, the
 * manifest catalogue and the frontend-safe execution-state contracts. Nothing
 * backend-specific (execution engine, planning, runs, store, NestJS) is exported
 * from here; engine logic lives in the standard export.
 * @summary Shared graph contracts consumed by both the backend engine and the UI.
 */

export * from "./graph";
export * from "./ui";
