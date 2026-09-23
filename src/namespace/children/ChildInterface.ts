import { Interface } from "../Interface";

/**
 * @interface ChildInterface
 * @description This interface extends the base {@link Interface} and adds a new generic method.
 * @summary Generic interface extending Interface with an additional method for enhanced functionality.
 * It provides a contract for objects that implement both the original Interface methods
 * and the new method2.
 *
 * @template T - The generic type parameter
 * @extends {Interface}
 */
export interface ChildInterface<T> extends Interface {
  /**
   * @description This method takes an argument of type T and returns a Promise that resolves to a string.
   * @summary Generic method that returns a Promise<string> based on the input argument.
   *
   * @template T - The generic type parameter
   * @param {T} arg1 - The input argument of generic type T
   * @return {Promise<string>} A Promise that resolves to a string
   */
  method2(arg1: T): Promise<string>;
}
