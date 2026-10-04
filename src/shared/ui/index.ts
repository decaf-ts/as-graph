/**
 * @module as-graph/shared/ui
 * @summary UI metadata keys shared with the rendering layer.
 * @description The graph reader inspects the UI decoration metadata that the
 * `@uielement`/`@uiprop` decorators attach to a model's properties. Only the
 * `UIKeys.PROP` key is consumed by the shared graph reader; the rest of the key
 * object is reproduced so the shared package stays self-contained. The former
 * framework-neutral view-model projections and the duplicate execution-state mapper
 * were retired (no consumers; the canonical mapper lives in
 * `@decaf-ts/ui-decorators/graph`).
 */
export * from "./constants";
