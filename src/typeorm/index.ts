/**
 * @module as-graph/typeorm
 * @summary Durable TypeORM/Postgres adapter wiring for as-graph in production.
 * @description Durable production path for the five as-graph decaf tables plus
 * the mastra persistence/eval/metrics models (SAA-926 §6.4). Development keeps
 * the built-in `RamAdapter` (`./ram`); production hosts build a
 * `@decaf-ts/for-typeorm` postgres adapter through
 * {@link createTypeormGraphAdapter} against the enterprise deployment's
 * connection contract.
 */
export * from "./TypeormGraphAdapter";
