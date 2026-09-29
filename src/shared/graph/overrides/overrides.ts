import "./Rendering";
import { Metadata } from "@decaf-ts/decoration";
import { type FieldDefinition, RenderingEngine } from "@decaf-ts/ui-decorators";
import { Model } from "@decaf-ts/decorator-validation";
import { graphDefinitionOf } from "../reader";
import { graphNodes, graphWorkflows } from "../registry";

(RenderingEngine.prototype as any).renderAsNode = function renderAsNode<
  M extends Model,
  T = void,
  R = FieldDefinition<T>,
>(model: M, globalProps: Record<string, unknown>, ...args: any[]): R {
  void globalProps;
  void args;
  return graphDefinitionOf(model) as unknown as R;
};

(Metadata as any).nodes = function nodes(): any[] {
  return graphNodes();
}.bind(Metadata);

(Metadata as any).workflows = function workflows(): any[] {
  return graphWorkflows();
}.bind(Metadata);
