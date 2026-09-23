/**
 * @module ts-workspace
 * @description This module serves as the main entry point for the ts-workspace library.
 * @summary Aggregates and exports functionality from various submodules and utilities within the project.
 * 
 * The module includes:
 * 1. Utility functions and types from the "./utils" directory:
 *    - These likely contain helper functions, common types, and shared functionality used throughout the project.
 *    - May include operations for data manipulation, type checking, or other general-purpose utilities.
 * 
 * 2. A namespace and related types from the "./namespace" directory:
 *    - This could contain domain-specific code or a collection of related functionality.
 *    - Might include interfaces, types, or classes that represent core concepts in the library.
 * 
 * 3. A VERSION constant:
 *    - Represents the current version of the module.
 *    - Useful for version checking and compatibility purposes.
 * 
 * This structure provides a clean and organized export of the module's functionality, allowing consumers
 * to easily import and use specific parts of the library as needed.
 */

export * from "./utils";
export * from "./namespace";

/**
 * @const VERSION
 * @name VERSION
 * @description Represents the current version of the ts-workspace module.
 * @summary The actual version number is replaced during the build process.
 * @type {string}
 */
export const VERSION = "##VERSION##";
