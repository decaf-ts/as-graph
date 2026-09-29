### Description

`@decaf-ts/as-graph` is the graph module for Decaf: a framework-neutral **workflow document
model**, a trusted **node catalogue**, and a reference **execution engine** that runs canonical
workflow documents.

It exists so that graph authoring (the editor/UI) and graph execution (the backend) share one
authoritative contract instead of two drifting copies. The same manifest a UI renders in a node palette
is the manifest the backend validator resolves against, and the same workflow document a UI saves is the
document the backend executes.

The module is split into three public entry points:

| Entry point | Contents | Audience |
| --- | --- | --- |
| `@decaf-ts/as-graph` | Engine, planning, validation, loops, pinning, run lifecycle, value store, and the built-in node classes | Backend / Node.js |
| `@decaf-ts/as-graph/shared` | Decorated-node/workflow metadata contracts, the canonical workflow document and its (de)serialization, manifest catalogue types, frontend-safe execution-state contracts | UI + backend |
| `@decaf-ts/as-graph/nest` | NestJS controllers, services, models and dynamic module hosting the engine over HTTP/SSE | NestJS backend |

#### The shared-vs-engine boundary rule

**NOTHING backend-specific may live in `shared`.** The `shared` entry point must stay importable
from a browser bundle, so it contains only code the UI must also know about: metadata contracts,
the document model, manifests, schemas, constants, and frontend-safe execution-state projections. It
must never import — directly or transitively — the execution engine, the planner, the run lifecycle, the
value store, Node built-ins, or NestJS. The standard export (`.`) builds on `shared` and adds the
backend-only machinery.

The boundary is enforced by construction:

- `src/shared/**` imports only from `src/shared/**` (plus the Decaf UI/decoration packages), never
  from `src/engine/**`, `src/node/**`, `src/nest/**`, or `src/log/**`.
- `src/index.ts` re-exports `./engine` and `./node`; the engine imports `shared`, never the reverse.

#### Folder structure

```text
src/
├── shared/     # UI-known contracts; import from "@decaf-ts/as-graph/shared"
│   ├── graph/
│   │   ├── document/     # canonical workflow document, builder, reader, (de)serializer
│   │   ├── catalog/      # node manifests, schemas, parameter/port declarations
│   │   ├── decorators.ts # @node, @graph, @port, @input, @output, @connection, @pinnable
│   │   ├── constants.ts  # GraphKeys, statuses, visual states, event types
│   │   ├── reader.ts     # metadata readers (ports, nodes, workflows)
│   │   └── snapshot.ts   # frontend-safe execution snapshots
│   └── ui/               # framework-neutral view models for the graph UI
├── node/       # built-in @node classes (triggers, flow control, utility, loops, agent)
├── engine/     # execution engine (planning, validation, loops, pinning, runs, store, catalog)
├── nest/       # NestJS HTTP/SSE wiring for the engine
└── log/        # run-log channel
```

The graph **workflow document** is the single executable artifact. Decorated workflow classes are
compiled into a canonical `GraphWorkflowDocument` (`GraphDecoratedWorkflowCompiler` /
`GraphWorkflowDocumentBuilder`) before execution; the engine never executes a raw decorated definition.

#### Architecture

The canonical document model and the engine execution flow are rendered from the PlantUML sources in
`workdocs/uml/` (sources alongside the images):

![Workflow document model](./workdocs/uml/diagram.png)

![Engine execution flow](./workdocs/uml/engine-execution.png)
