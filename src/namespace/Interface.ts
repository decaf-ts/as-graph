/**
 * @interface Interface
 * @description This interface defines a contract for objects that have a single generic method.
 * @summary Generic interface with a single method that returns a Promise.
 * The method takes an argument of any type and returns a Promise that resolves to a string.
 */
export interface Interface {
  /**
   * @description This method takes an argument of any type and returns a Promise that resolves to a string.
   * @summary Generic method that returns a Promise<string>.
   *
   * @template T The type of the input argument
   * @param {T} arg1 - The input argument of type T
   * @return {Promise<string>} A Promise that resolves to a string
   */
  method<T>(arg1: T): Promise<string>;
}
