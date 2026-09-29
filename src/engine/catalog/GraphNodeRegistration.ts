/**
 * @module as-graph/engine/catalog/GraphNodeRegistration
 * @summary Catalogue registration contracts (DECAF-50 §4.12).
 * @description The manifest+executor {@link GraphNodeRegistration} pairing
 * the catalogue registers, the node-method invocation contracts
 * (`GraphNodeMethodRequest`/`GraphNodeMethodContext`), the
 * resolved-manifest provider hook, and the `defineGraphNode` /
 * `declaredGraphNodeMethods` helpers.
 */
import type {
  GraphCredentialReference,
  GraphJsonValue,
  GraphNodeManifest,
  GraphNodeMethodManifest,
} from "../../shared/graph";
import type { GraphNodeInstance } from "../../shared/graph";
import type { GraphNodeExecutor } from "../execution/GraphNodeExecutor";
import type {
  GraphNodeResolutionContext,
  GraphResolvedNodeManifest,
} from "../../shared/graph";

/** Invocation payload for a catalogue-exposed node method (DECAF-50 §4.12). */
export interface GraphNodeMethodRequest {
  /** Node kind owning the method. */
  kind: string;
  /** Declared method name. */
  method: string;
  /** Node parameter values to invoke with. */
  parameters: Record<string, GraphJsonValue>;
  /** Optional method payload. */
  payload?: GraphJsonValue;
}

/** Runtime context handed to a node method implementation. */
export interface GraphNodeMethodContext {
  /** Opaque caller request context. */
  requestContext?: unknown;
  /** Credential references authorized for the invocation. */
  credentials?: GraphCredentialReference[];
  /** Additional metadata. */
  metadata?: Record<string, GraphJsonValue>;
}

/** A catalogue-exposed node method implementation. */
export type GraphNodeMethod = (
  request: GraphNodeMethodRequest,
  context: GraphNodeMethodContext
) => Promise<GraphJsonValue>;

/**
 * Registration hook that resolves the effective
 * {@link GraphResolvedNodeManifest} for a node instance (dynamic ports
 * expanded), overriding the static manifest resolution.
 */
export type GraphResolvedManifestProvider = (
  instance: GraphNodeInstance,
  context?: GraphNodeResolutionContext
) => Promise<GraphResolvedNodeManifest> | GraphResolvedNodeManifest;

/**
 * A catalogue registration (DECAF-50 §4.12): the published manifest plus the
 * executor that runs the node, and optionally declared-method implementations
 * and a resolved-manifest provider.
 */
export interface GraphNodeRegistration {
  /** Published node manifest. */
  manifest: GraphNodeManifest;
  /** Executor that performs the node's work. */
  executor: GraphNodeExecutor;
  /** Implementations for the manifest's declared methods. */
  methods?: Record<string, GraphNodeMethod>;
  /** Optional dynamic-manifest resolution provider. */
  resolveManifest?: GraphResolvedManifestProvider;
}

/** Options for {@link GraphNodeCatalogue.register}. */
export interface GraphNodeRegistrationOptions {
  /** Replace an existing registration for the same kind. */
  replace?: boolean;
}

/**
 * Identity helper that types a registration payload as a
 * {@link GraphNodeRegistration} for catalogue registration.
 */
export function defineGraphNode(
  registration: GraphNodeRegistration
): GraphNodeRegistration {
  return registration;
}

/** Returns the method manifests declared by a node manifest. */
export function declaredGraphNodeMethods(
  manifest: GraphNodeManifest
): GraphNodeMethodManifest[] {
  return manifest.methods ?? [];
}
