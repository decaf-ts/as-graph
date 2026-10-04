/**
 * @module as-graph/execution/GraphExecutionBackendRegistry
 * @summary Registry of pluggable graph execution backends (DECAF-50 §4.9).
 * @description Flavour/name registry for {@link GraphExecutionBackend}
 * implementations, patterned on Decaf's persistence-adapter registry
 * (`Adapter._cache` / `Adapter.current` / `Adapter.setCurrent`). The built-in
 * {@link LocalGraphExecutionBackend} registers itself under
 * {@link GRAPH_LOCAL_EXECUTION_BACKEND}; remote backends (Dagster, Mastra)
 * register under their own flavour.
 */
import { GraphExecutionError } from "../errors";
import { GRAPH_LOCAL_EXECUTION_BACKEND } from "../constants";
import type { GraphExecutionBackend } from "./GraphExecutionBackend";

/**
 * Static registry mapping backend flavours to their singleton instances, mirroring
 * Decaf's `Adapter` flavour registry.
 */
export class GraphExecutionBackendRegistry {
  private static _currentFlavour?: string;
  private static readonly _cache: Record<
    string,
    GraphExecutionBackend<any>
  > = {};

  /**
   * Registers a backend under a flavour. Re-registering the same flavour
   * replaces the previous entry (the engine may create several local backends
   * across its lifetime). The current flavour is never changed implicitly:
   * hosts select a non-default backend with {@link setCurrent}, so the engine's
   * default stays a fresh local backend per engine and never shares per-run
   * state between concurrently booted engines.
   *
   * @param flavour - The backend flavour name.
   * @param backend - The backend instance.
   * @returns The registered backend.
   */
  static register<B extends GraphExecutionBackend<any>>(
    flavour: string,
    backend: B
  ): B {
    GraphExecutionBackendRegistry._cache[flavour] = backend;
    return backend;
  }

  /**
   * Resolves a registered backend by flavour, or the current backend when no
   * flavour is given. Returns `undefined` when nothing is registered.
   *
   * @param flavour - The backend flavour to resolve, if any.
   * @returns The backend instance, or `undefined`.
   */
  static get<B extends GraphExecutionBackend<any>>(
    flavour?: string
  ): B | undefined {
    const name = flavour ?? GraphExecutionBackendRegistry._currentFlavour;
    if (!name) return undefined;
    return GraphExecutionBackendRegistry._cache[name] as B | undefined;
  }

  /**
   * Resolves a registered backend by flavour, throwing when absent.
   *
   * @param flavour - The backend flavour to resolve.
   * @returns The backend instance.
   * @throws {GraphExecutionError} when no backend is registered under the flavour.
   */
  static getOrFail<B extends GraphExecutionBackend<any>>(
    flavour: string
  ): B {
    const backend = GraphExecutionBackendRegistry.get<B>(flavour);
    if (!backend) {
      throw new GraphExecutionError(
        `No graph execution backend registered under '${flavour}'`,
        "GRAPH_EXECUTION_BACKEND_NOT_REGISTERED"
      );
    }
    return backend;
  }

  /** The current default backend, when one is registered. */
  static get current(): GraphExecutionBackend<any> | undefined {
    return GraphExecutionBackendRegistry.get();
  }

  /** The current default backend flavour, defaulting to `local`. */
  static get currentFlavour(): string {
    return (
      GraphExecutionBackendRegistry._currentFlavour ??
      GRAPH_LOCAL_EXECUTION_BACKEND
    );
  }

  /** Sets the current default backend flavour. */
  static setCurrent(flavour: string): void {
    GraphExecutionBackendRegistry._currentFlavour = flavour;
  }

  /**
   * Lists every registered backend with its flavour, in registration order.
   * Used by the capability manifest to enumerate the available engines without
   * probing them; a flavour is an allowlisted engine id.
   *
   * @returns A snapshot array of registered flavour/backend entries.
   */
  static list(): Array<{ flavour: string; backend: GraphExecutionBackend<any> }> {
    return Object.entries(GraphExecutionBackendRegistry._cache).map(
      ([flavour, backend]) => ({ flavour, backend })
    );
  }

  /** Unregisters a backend by flavour. */
  static unregister(flavour?: string): void {
    if (!flavour) return;
    delete GraphExecutionBackendRegistry._cache[flavour];
    if (GraphExecutionBackendRegistry._currentFlavour === flavour) {
      GraphExecutionBackendRegistry._currentFlavour = undefined;
    }
  }

  /** Clears every registered backend (test isolation). */
  static clear(): void {
    for (const flavour of Object.keys(
      GraphExecutionBackendRegistry._cache
    )) {
      delete GraphExecutionBackendRegistry._cache[flavour];
    }
    GraphExecutionBackendRegistry._currentFlavour = undefined;
  }
}
