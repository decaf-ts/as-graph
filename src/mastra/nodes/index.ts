/**
 * @module as-graph/mastra/nodes
 * @summary Mastra node-kind registry barrel (DECAF-809 Phase B).
 * @description Public surface of the `@decaf-ts/as-graph/mastra/nodes`
 * sub-entrypoint: the registry contracts and the built-in implementation
 * registry that binds every mastra-only node kind to its node class and step
 * handlers, with the coverage audit the backend and tests run to fail closed
 * on unimplemented kinds.
 */
export * from "./types";
export * from "./MastraNodeRegistry";
