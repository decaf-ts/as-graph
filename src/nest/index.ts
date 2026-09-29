/**
 * @module as-graph/nest
 * @summary NestJS graph backend wiring sub-entry.
 * @description Exposes the NestJS controllers, services, models and dynamic
 * module that host the graph execution engine over HTTP/SSE. Backend
 * consumers import from `@decaf-ts/as-graph/nest`; the engine itself is
 * framework-free and lives in the standard `@decaf-ts/as-graph` export.
 */

export * from "./graph";
