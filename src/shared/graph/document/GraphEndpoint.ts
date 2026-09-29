/**
 * Endpoint that refers to a workflow-level port.
 */
export type GraphWorkflowEndpoint = {
  scope: "workflow";
  port: string;
};

/**
 * Endpoint that refers to a node's port.
 */
export type GraphNodeEndpoint = {
  scope: "node";
  nodeId: string;
  port: string;
};

/**
 * Union of the endpoint scopes an edge may connect.
 */
export type GraphEndpoint = GraphWorkflowEndpoint | GraphNodeEndpoint;

/**
 * Type guard for {@link GraphWorkflowEndpoint}.
  * @returns {boolean} Whether `value` is a GraphWorkflowEndpoint.
*/
export function isGraphWorkflowEndpoint(endpoint: GraphEndpoint): endpoint is GraphWorkflowEndpoint {
  return endpoint.scope === "workflow";
}

/**
 * Type guard for {@link GraphNodeEndpoint}.
  * @returns {boolean} Whether `value` is a GraphNodeEndpoint.
*/
export function isGraphNodeEndpoint(endpoint: GraphEndpoint): endpoint is GraphNodeEndpoint {
  return endpoint.scope === "node";
}

/**
 * Type guard for {@link GraphEndpoint}, checking the fields allowed by each scope.
  * @returns {boolean} Whether `value` is a GraphEndpoint.
*/
export function isGraphEndpoint(value: unknown): value is GraphEndpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record["scope"] === "workflow") {
    return typeof record["port"] === "string" && Reflect.ownKeys(record).length === 2;
  }
  if (record["scope"] === "node") {
    return (
      typeof record["nodeId"] === "string" &&
      typeof record["port"] === "string" &&
      Reflect.ownKeys(record).length === 3
    );
  }
  return false;
}
