import { Interface } from "./Interface";

/**
 * @class Class
 * @description A class implementing the Interface contract.
 * @summary This class provides an implementation of the Interface contract with additional static functionality.
 * It manages an internal state through a private property and offers both instance and static methods.
 *
 * @param {unknown} arg1 - First argument of unknown type
 * @param {string} arg2 - Second argument as string
 *
 * @implements {Interface}
 *
 * @example
 * ```typescript
 * // Create a new instance
 * const instance = new Class('someValue', 'stringValue');
 *
 * // Using the generic method
 * await instance.method<string>()
 *   .catch(error => console.error(error));
 *
 * // Using the static method
 * Class.method();
 * ```
 *
 * @mermaid
 * sequenceDiagram
 *   participant Client
 *   participant Instance
 *   participant Static
 *
 *   Client->>Instance: new Class(arg1, arg2)
 *   activate Instance
 *   Instance-->>Client: class instance
 *   deactivate Instance
 *
 *   Client->>Instance: method<T>()
 *   activate Instance
 *   Instance-->>Client: Promise<string>
 *   deactivate Instance
 *
 *   Client->>Static: Class.method()
 *   activate Static
 *   Static-->>Client: void
 *   deactivate Static
 */
export class Class implements Interface {
  /**
   * @description Private property to store internal state.
   * @summary An unknown type property used for internal state management.
   * @private
   * @type {unknown}
   */
  private prop!: unknown;

  constructor(arg1: unknown, arg2: string) {
    console.log(arg1, arg2);
  }

  /**
   * @description Asynchronous method implementing the Interface contract.
   * @summary Throws an error with type casting chain.
   *
   * @template T The type parameter used in the error casting chain
   * @return {Promise<string>} A Promise that always rejects with an error
   * @throws {Error} Always throws an error
   */
  async method<T>(): Promise<string> {
    throw new Error("error" as T as unknown as string);
  }

  /**
   * @description Static method that throws an error.
   * @summary A static utility method that always throws an error.
   *
   * @return {never} Never returns as it always throws an error
   * @throws {Error} Always throws an error
   * @static
   */
  static method() {
    throw new Error("error");
  }
}
