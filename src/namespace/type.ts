/**
 * @typedef Type
 * @description This type represents either a string or a value of the generic type T.
 * @summary A union type of string and a generic type T that allows for flexible typing.
 * It allows for flexible typing where a value can be either a string or of any other specified type.
 * @template T - The generic type parameter
 * @typeDef
 *
 * @example
 * // Using Type with a specific type
 * type StringOrNumber = Type<number>;
 * const value1: StringOrNumber = "Hello"; // valid
 * const value2: StringOrNumber = 42; // valid
 * const value3: StringOrNumber = true; // invalid
 *
 * @example
 * // Using Type in a function
 * function processValue<T>(value: Type<T>): void {
 *   if (typeof value === 'string') {
 *     console.log('String value:', value);
 *   } else {
 *     console.log('Non-string value:', value);
 *   }
 * }
 *
 * @memberOf module:ts-workspace.Namespace
 */
export type Type<T> = string | T;
