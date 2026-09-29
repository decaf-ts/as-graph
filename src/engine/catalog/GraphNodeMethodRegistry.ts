import type { GraphNodeMethodManifest } from "../../shared/graph";
import {
  GraphNodeRegistrationError,
  GraphNodeMethodNotFoundError,
} from "./GraphCatalogueErrors";
import type { GraphNodeMethod } from "./GraphNodeRegistration";

/**
 * Per-kind registry of declared node methods (DECAF-50 §4.12): validates at
 * construction that every declared method has an implementation and no
 * implementation exists without a declaration, then serves declarations and
 * implementations by name.
 */
export class GraphNodeMethodRegistry {
  private readonly declarations = new Map<string, GraphNodeMethodManifest>();
  private readonly implementations = new Map<string, GraphNodeMethod>();

  constructor(
    private readonly kind: string,
    declared: GraphNodeMethodManifest[],
    provided: Record<string, GraphNodeMethod> = {}
  ) {
    for (const declaration of declared) {
      if (typeof declaration?.name !== "string" || !declaration.name) {
        throw new GraphNodeRegistrationError(
          `Method declaration for kind '${this.kind}' is missing a name`
        );
      }
      if (this.declarations.has(declaration.name)) {
        throw new GraphNodeRegistrationError(
          `Kind '${this.kind}' declares duplicate method '${declaration.name}'`
        );
      }
      this.declarations.set(declaration.name, declaration);
    }

    for (const [name, implementation] of Object.entries(provided)) {
      if (typeof implementation !== "function") {
        throw new GraphNodeRegistrationError(
          `Method implementation '${name}' for kind '${this.kind}' is not a function`
        );
      }
      if (!this.declarations.has(name)) {
        throw new GraphNodeRegistrationError(
          `Kind '${this.kind}' implements method '${name}' which is not declared by its manifest`
        );
      }
      this.implementations.set(name, implementation);
    }

    for (const name of this.declarations.keys()) {
      if (!this.implementations.has(name)) {
        throw new GraphNodeRegistrationError(
          `Kind '${this.kind}' declares method '${name}' with no implementation`
        );
      }
    }
  }

  /** Whether a method with the given name is declared. */
  has(name: string): boolean {
    return this.declarations.has(name);
  }

  /** Returns the method's declaration; throws {@link GraphNodeMethodNotFoundError} when undeclared. */
  getDeclaration(name: string): GraphNodeMethodManifest {
    const declaration = this.declarations.get(name);
    if (!declaration) {
      throw new GraphNodeMethodNotFoundError(
        `Kind '${this.kind}' does not declare method '${name}'`
      );
    }
    return declaration;
  }

  /** Returns the method's implementation (asserting it is declared first). */
  get(name: string): GraphNodeMethod {
    this.getDeclaration(name);
    return this.implementations.get(name) as GraphNodeMethod;
  }

  /** Lists all declarations, sorted by method name. */
  list(): GraphNodeMethodManifest[] {
    return [...this.declarations.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
  }
}
