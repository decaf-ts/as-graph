import type { FieldDefinition } from "@decaf-ts/ui-decorators";
import type { Model } from "@decaf-ts/decorator-validation";

/**
 * Augments `ui-decorators`' rendering engine with `renderAsNode`, which resolves a model into a graph node definition.
 */
export interface RenderingEngine<T = void, R = FieldDefinition<T>> {
  renderAsNode<M extends Model>(
    model: M,
    globalProps: Record<string, unknown>,
    ...args: any[]
  ): R;
}
