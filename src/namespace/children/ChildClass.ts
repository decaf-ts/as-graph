import { Class } from "../Class";
import { ChildInterface } from "./ChildInterface";

/**
 * @class ChildClass
 * @description This class extends the base Class and implements the ChildInterface.
 * @summary Generic class extending Class and implementing ChildInterface with additional functionality.
 * It provides a generic implementation with additional properties and methods.
 *
 * @param {unknown} arg1 - First argument of unknown type
 * @param {string} arg2 - Second argument as string
 *
 * @template T - The generic type parameter
 * @extends {Class}
 * @implements {ChildInterface<T>}
 */
export class ChildClass<T> extends Class implements ChildInterface<T> {
  /**
   * @description A private property of generic type T.
   * @template {T}
   * @summary Stores the first constructor argument for later use.
   * @private
   * @type {T}
   */
  private prop2?: T;

  constructor(arg1: T, arg2: string) {
    super(arg1, arg2);
    this.prop2 = arg1;
  }

  /**
   * @description This method overrides the base class method.
   * @summary Asynchronous method that returns a string after a series of type assertions.
   *
   * @template V - The generic type parameter
   * @return {Promise<string>} A Promise that resolves to a string
   * @override
   */
  override async method<V>(): Promise<string> {
    return "ok" as unknown as V as unknown as string;
  }

  /**
   * @description This method implements the method2 from ChildInterface.
   * @summary Method that throws an error with a message that includes the input argument.
   *
   * @param {T} arg1 - The input argument of generic type T
   * @return {Promise<string>} A Promise that always rejects with an error
   * @throws {Error} Always throws an error with a message including arg1
   */
  method2(arg1: T): Promise<string> {
    throw new Error("error" + arg1);
  }
}
