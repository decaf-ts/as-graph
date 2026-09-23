import { Class } from "../Class";
import { Type } from "../type";

/**
 * @function something
 * @description This function is a generic method that extends the Class type.
 * @summary Generic function that logs arguments and returns the context (this) of the function.
 * It logs all provided arguments to the console and returns the context (this) of the function.
 *
 * @template T - Type extending {@link Class}
 * @template V - Type of the arguments
 * @this {T}
 * @param {...V} args - Variable number of arguments of type V
 * @return {Type<T>} Returns the context (this) of the function
 *
 * @example
 * class MyClass extends Class {
 *   myMethod() {
 *     return something.call(this, 'arg1', 'arg2');
 *   }
 * }
 * 
 * const instance = new MyClass();
 * const result = instance.myMethod();
 * // Logs: 'arg1', 'arg2'
 * // result is the instance of MyClass
 *
 * @memberOf module:ts-workspace.Namespace.ChildNamespace
 * @see {@link Class}
 * @see {@link Type}
 */
export function something<T extends Class, V>(this: T, ...args: V[]): Type<T> {
  console.log(...args);
  return this;
}
