/**
 * @module as-graph/shared/graph/document/GraphLoopBodyLayout
 * @summary Converts a loop body between its two representations.
 * @description A loop node's body is canonically a nested workflow document
 * (`node.loop.body`). An editor draws it differently: the body nodes sit on
 * the same canvas as the loop node, chained from the loop's body-entry port
 * (`item` on a foreach, `body` on a while/until) and back into its `loop`
 * port. The two forms carry the same information, and both directions live
 * here so there is exactly one implementation:
 *
 * - {@link graphNestLoopBodies} — canvas → canonical. The engine applies it
 *   to every submitted document before validation, so a document authored in
 *   the canvas form validates and runs.
 * - {@link graphFlattenLoopBodies} — canonical → canvas. An editor applies it
 *   on load so a persisted body is drawn instead of hidden.
 *
 * Both are pure, JSON-in/JSON-out, and frontend-safe.
 */
import type { GraphEdgeInstance } from "./GraphEdgeInstance";
import type { GraphEndpoint } from "./GraphEndpoint";
import type { GraphJsonValue } from "./GraphJsonValue";
import type { GraphNodeInstance } from "./GraphNodeInstance";
import type { GraphWorkflowDocument } from "./GraphWorkflowDocument";

/** The connection port a loop body's last node chains back into. */
export const GRAPH_LOOP_BODY_EXIT_PORT = "loop";

/** Body-entry port per loop kind: the port the first body node hangs off. */
export const GRAPH_LOOP_BODY_ENTRY_PORTS: Readonly<Record<string, string>> = {
  "core.loop.foreach": "item",
  "core.loop.while": "body",
  "core.loop.until": "body",
};

/** Instance metadata key recording which loop a flattened body node belongs to. */
export const GRAPH_LOOP_PARENT_METADATA_KEY = "loopParent";

/** Instance metadata key marking an editor placeholder ("+ Add node"). */
export const GRAPH_GHOST_METADATA_KEY = "ghost";

/** A problem found while nesting a canvas-form loop body. */
export interface GraphLoopBodyLayoutIssue {
  /** The loop node the problem belongs to. */
  loopId: string;
  /** Stable problem code. */
  code: "loop.body-escapes" | "loop.body-shared";
  /** What is wrong. */
  message: string;
  /** The edge or node at fault. */
  subject: string;
}

/** Result of {@link graphNestLoopBodies}. */
export interface GraphNestedLoopBodies {
  /** The document with every canvas-form body moved into `node.loop.body`. */
  document: GraphWorkflowDocument;
  /** Whether anything was converted. */
  changed: boolean;
  /** Bodies that could not be nested cleanly. */
  issues: GraphLoopBodyLayoutIssue[];
}

function nodeIdOf(endpoint: GraphEndpoint | undefined): string | undefined {
  return endpoint?.scope === "node" ? endpoint.nodeId : undefined;
}

function isGhost(node: GraphNodeInstance | undefined): boolean {
  return node?.metadata?.[GRAPH_GHOST_METADATA_KEY] === true;
}

function stringParameter(
  node: GraphNodeInstance,
  key: string,
  fallback: string
): string {
  const value = node.parameters?.[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Names of the workflow ports a loop kind's body document exposes.
 *
 * @param loop - The loop node instance.
 * @returns The body's input and output port ids.
 */
export function graphLoopBodyBoundaryOf(loop: GraphNodeInstance): {
  input: string;
  output: string;
} {
  if (loop.kind === "core.loop.foreach") {
    return {
      input: stringParameter(loop, "itemPort", "item"),
      output: stringParameter(loop, "resultPort", "result"),
    };
  }
  const state = stringParameter(loop, "statePort", "state");
  return {
    input: stringParameter(loop, "inputPort", state),
    output: stringParameter(loop, "outputPort", state),
  };
}

function withoutLoopParent(node: GraphNodeInstance): GraphNodeInstance {
  if (!node.metadata || !(GRAPH_LOOP_PARENT_METADATA_KEY in node.metadata)) {
    return node;
  }
  const metadata = { ...node.metadata };
  delete metadata[GRAPH_LOOP_PARENT_METADATA_KEY];
  const next: GraphNodeInstance = { ...node };
  if (Object.keys(metadata).length > 0) next.metadata = metadata;
  else delete next.metadata;
  return next;
}

/**
 * Moves every canvas-form loop body into its loop node's `loop.body`.
 *
 * A body is recognised structurally: edges leaving a loop node's body-entry
 * port start it, edges entering the loop node's `loop` port end it, and every
 * node reachable from the entry without passing through the loop node belongs
 * to it. Editor placeholders (ghost nodes) and their edges are dropped. A loop
 * that has no canvas-form body keeps whatever `loop.body` it already carries;
 * a canvas-form body replaces a stale nested one. Nested loops are handled
 * innermost-first, so a loop drawn inside another loop's body ends up nested
 * inside that body.
 *
 * A body node that also feeds a node outside the body cannot be nested (the
 * value would have to leave the loop mid-iteration); it is reported as an
 * issue and that loop is left untouched for the validator to reject.
 *
 * @param document - A document in canvas form, canonical form, or a mix.
 * @returns The canonical document, whether it changed, and any issues.
 */
export function graphNestLoopBodies(
  document: GraphWorkflowDocument
): GraphNestedLoopBodies {
  const issues: GraphLoopBodyLayoutIssue[] = [];
  let nodes: GraphNodeInstance[] = [...(document.nodes ?? [])];
  let edges: GraphEdgeInstance[] = [...(document.edges ?? [])];
  let changed = false;

  // Editor placeholders never reach the canonical document.
  const ghosts = new Set(nodes.filter(isGhost).map((node) => node.id));
  if (ghosts.size > 0) {
    nodes = nodes.filter((node) => !ghosts.has(node.id));
    edges = edges.filter(
      (edge) =>
        !ghosts.has(nodeIdOf(edge.source) ?? "") &&
        !ghosts.has(nodeIdOf(edge.target) ?? "")
    );
    changed = true;
  }

  const loopIds = nodes
    .filter((node) => GRAPH_LOOP_BODY_ENTRY_PORTS[node.kind] !== undefined)
    .map((node) => node.id);

  const bodyOf = (loopId: string): Set<string> | undefined => {
    const loop = nodes.find((node) => node.id === loopId);
    if (!loop) return undefined;
    const entryPort = GRAPH_LOOP_BODY_ENTRY_PORTS[loop.kind];
    const starts = edges.filter(
      (edge) =>
        nodeIdOf(edge.source) === loopId &&
        edge.source.port === entryPort &&
        nodeIdOf(edge.target) !== undefined &&
        nodeIdOf(edge.target) !== loopId
    );
    if (starts.length === 0) return undefined;
    const members = new Set<string>();
    const queue = starts.map((edge) => nodeIdOf(edge.target) as string);
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (current === loopId || members.has(current)) continue;
      members.add(current);
      for (const edge of edges) {
        if (nodeIdOf(edge.source) !== current) continue;
        const target = nodeIdOf(edge.target);
        if (target && target !== loopId) queue.push(target);
      }
    }
    return members;
  };

  // Innermost first: a loop whose body contains no other loop with a
  // canvas-form body is nested before the loops around it.
  const pending = new Set(loopIds);
  let progressed = true;
  while (pending.size > 0 && progressed) {
    progressed = false;
    for (const loopId of [...pending]) {
      const members = bodyOf(loopId);
      if (!members) {
        pending.delete(loopId);
        progressed = true;
        continue;
      }
      const containsPendingLoop = [...members].some(
        (id) => id !== loopId && pending.has(id) && bodyOf(id) !== undefined
      );
      if (containsPendingLoop) continue;
      pending.delete(loopId);
      progressed = true;

      let loop = nodes.find((node) => node.id === loopId) as GraphNodeInstance;
      const entryPort = GRAPH_LOOP_BODY_ENTRY_PORTS[loop.kind];
      let boundary = graphLoopBodyBoundaryOf(loop);
      if (boundary.input === boundary.output) {
        // A document's workflow port ids are unique across inputs and
        // outputs, so a body cannot read and write the same port name. A
        // while/until loop left on its defaults gets distinct body ports.
        loop = {
          ...loop,
          parameters: { ...loop.parameters, inputPort: "in", outputPort: "out" },
        };
        boundary = { input: "in", output: "out" };
      }

      const escaping = edges.filter(
        (edge) =>
          members.has(nodeIdOf(edge.source) ?? "") &&
          !members.has(nodeIdOf(edge.target) ?? "") &&
          nodeIdOf(edge.target) !== loopId
      );
      if (escaping.length > 0) {
        for (const edge of escaping) {
          issues.push({
            loopId,
            code: "loop.body-escapes",
            message: `Edge '${edge.id}' leaves the body of loop '${loopId}' without passing through its '${GRAPH_LOOP_BODY_EXIT_PORT}' port`,
            subject: edge.id,
          });
        }
        continue;
      }

      const bodyNodes: GraphNodeInstance[] = [];
      const bodyEdges: GraphEdgeInstance[] = [];
      const keptEdges: GraphEdgeInstance[] = [];
      for (const edge of edges) {
        const source = nodeIdOf(edge.source);
        const target = nodeIdOf(edge.target);
        const fromLoopEntry =
          source === loopId &&
          edge.source.port === entryPort &&
          members.has(target ?? "");
        const intoLoopExit =
          target === loopId &&
          edge.target.port === GRAPH_LOOP_BODY_EXIT_PORT &&
          members.has(source ?? "");
        if (fromLoopEntry) {
          bodyEdges.push({
            ...edge,
            type: "data",
            source: { scope: "workflow", port: boundary.input },
          });
        } else if (intoLoopExit) {
          bodyEdges.push({
            ...edge,
            type: "data",
            target: { scope: "workflow", port: boundary.output },
          });
        } else if (members.has(source ?? "") && members.has(target ?? "")) {
          bodyEdges.push(edge);
        } else if (members.has(target ?? "") && source !== loopId) {
          // A value from outside the loop cannot be read mid-iteration.
          issues.push({
            loopId,
            code: "loop.body-shared",
            message: `Edge '${edge.id}' feeds a node inside the body of loop '${loopId}' from outside the loop`,
            subject: edge.id,
          });
          keptEdges.push(edge);
        } else {
          keptEdges.push(edge);
        }
      }
      for (const node of nodes) {
        if (members.has(node.id)) bodyNodes.push(withoutLoopParent(node));
      }
      const previous = loop.loop?.body;
      const body: GraphWorkflowDocument = {
        id: previous?.id ?? `${document.id}::${loopId}::body`,
        name: previous?.name ?? `${loopId} body`,
        inputs: [{ id: boundary.input }],
        outputs: [{ id: boundary.output }],
        nodes: bodyNodes,
        edges: bodyEdges,
      };
      nodes = nodes
        .filter((node) => !members.has(node.id))
        .map((node) =>
          node.id === loopId
            ? { ...loop, loop: { ...(loop.loop ?? {}), body } }
            : node
        );
      edges = keptEdges;
      changed = true;
    }
  }

  // A dangling self-connection (loop.item → loop.loop) carries nothing.
  const before = edges.length;
  edges = edges.filter((edge) => {
    const source = nodeIdOf(edge.source);
    const kind = nodes.find((node) => node.id === source)?.kind ?? "";
    return !(
      source !== undefined &&
      source === nodeIdOf(edge.target) &&
      GRAPH_LOOP_BODY_ENTRY_PORTS[kind] === edge.source.port &&
      edge.target.port === GRAPH_LOOP_BODY_EXIT_PORT
    );
  });
  if (edges.length !== before) changed = true;

  return {
    document: changed ? { ...document, nodes, edges } : document,
    changed,
    issues,
  };
}

/**
 * Draws every nested loop body on its parent document's canvas.
 *
 * The inverse of {@link graphNestLoopBodies}: body nodes become siblings of
 * the loop node (tagged with their loop in `metadata.loopParent`), an edge
 * from the body's input boundary becomes an edge from the loop's body-entry
 * port, and an edge to the body's output boundary becomes an edge into the
 * loop's `loop` port. The loop keeps its other loop settings; `loop.body` is
 * emptied of nodes and edges, to be rebuilt by nesting. A body node whose id
 * collides with a node already on the canvas is prefixed with its loop id.
 *
 * @param document - A canonical document.
 * @returns The canvas-form document (the same object when there is no body).
 */
export function graphFlattenLoopBodies(
  document: GraphWorkflowDocument
): GraphWorkflowDocument {
  let nodes: GraphNodeInstance[] = [...(document.nodes ?? [])];
  const edges: GraphEdgeInstance[] = [...(document.edges ?? [])];
  let changed = false;
  const queue = nodes
    .filter((node) => GRAPH_LOOP_BODY_ENTRY_PORTS[node.kind] !== undefined)
    .map((node) => node.id);

  while (queue.length > 0) {
    const loopId = queue.shift() as string;
    const loop = nodes.find((node) => node.id === loopId);
    const body = loop?.loop?.body;
    if (!loop || !body || (body.nodes ?? []).length === 0) continue;
    const entryPort = GRAPH_LOOP_BODY_ENTRY_PORTS[loop.kind];
    const taken = new Set(nodes.map((node) => node.id));
    const rename = new Map<string, string>();
    for (const node of body.nodes) {
      let id = node.id;
      if (taken.has(id)) id = `${loopId}::${node.id}`;
      taken.add(id);
      rename.set(node.id, id);
    }
    const mapEndpoint = (
      endpoint: GraphEndpoint,
      role: "source" | "target"
    ): GraphEndpoint =>
      endpoint.scope === "node"
        ? { ...endpoint, nodeId: rename.get(endpoint.nodeId) ?? endpoint.nodeId }
        : role === "source"
          ? { scope: "node", nodeId: loopId, port: entryPort }
          : { scope: "node", nodeId: loopId, port: GRAPH_LOOP_BODY_EXIT_PORT };
    for (const node of body.nodes) {
      const id = rename.get(node.id) as string;
      nodes.push({
        ...node,
        id,
        metadata: {
          ...(node.metadata ?? {}),
          [GRAPH_LOOP_PARENT_METADATA_KEY]: loopId as GraphJsonValue,
        },
      });
      if (GRAPH_LOOP_BODY_ENTRY_PORTS[node.kind] !== undefined) queue.push(id);
    }
    const edgeIds = new Set(edges.map((edge) => edge.id));
    for (const edge of body.edges ?? []) {
      let id = edge.id;
      if (edgeIds.has(id)) id = `${loopId}::${edge.id}`;
      edgeIds.add(id);
      edges.push({
        ...edge,
        id,
        source: mapEndpoint(edge.source, "source"),
        target: mapEndpoint(edge.target, "target"),
      });
    }
    nodes = nodes.map((node) =>
      node.id === loopId
        ? {
            ...node,
            loop: { ...node.loop!, body: { ...body, nodes: [], edges: [] } },
          }
        : node
    );
    changed = true;
  }
  return changed ? { ...document, nodes, edges } : document;
}
