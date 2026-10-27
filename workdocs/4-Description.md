### Description

`@decaf-ts/as-graph` is the graph module for Decaf: a framework-neutral **workflow document
model**, a trusted **node catalogue**, and a reference **execution engine** that runs canonical
workflow documents.

It exists so that graph authoring (the editor/UI) and graph execution (the backend) share one
authoritative contract instead of two drifting copies. The same manifest a UI renders in a node palette
is the manifest the backend validator resolves against, and the same workflow document a UI saves is the
document the backend executes.

The module is split into multiple public entry points:

| Entry point | Contents | Audience |
| --- | --- | --- |
| `@decaf-ts/as-graph` | Engine, planning, validation, auth, loops, pinning, run lifecycle, value store, and the engine-neutral built-in node classes (Mastra-dependent node classes ship only from `@decaf-ts/as-graph/mastra/nodes`) | Backend / Node.js |
| `@decaf-ts/as-graph/shared` | Decorated-node/workflow metadata contracts, the canonical workflow document and its (de)serialization, manifest catalogue types, frontend-safe execution-state contracts | UI + backend |
| `@decaf-ts/as-graph/nest` | NestJS controllers, services, models and dynamic module hosting the engine over HTTP/SSE | NestJS backend |
| `@decaf-ts/as-graph/ram` | Adapter-backed persistence: the run/run-event/value model classes (`GraphRunModel`, `GraphRunEventModel`, `GraphValueModel`), their `@repository()` classes, and the `RamGraphRunStore` / `RamGraphRunEventStore` stores | Backend / Node.js |
| `@decaf-ts/as-graph/workflows` | Engine-neutral demo workflow fixture registry (`basicWorkflowFixtures`) plus the shared fixture types/builders — demo/test content, not part of the engine contract | Demo / test |
| `@decaf-ts/as-graph/workflows/mastra` | Mastra capability fixture registry (`mastraWorkflowFixtures`), composite workflows, deterministic host fakes, and the `MASTRA_FEATURE_CAPABILITIES` coverage matrix | Demo / test |

#### The shared-vs-engine boundary rule

**NOTHING backend-specific may live in `shared`.** The `shared` entry point must stay importable
from a browser bundle, so it contains only code the UI must also know about: metadata contracts,
the document model, manifests, schemas, constants, and frontend-safe execution-state projections. It
must never import — directly or transitively — the execution engine, the planner, the run lifecycle, the
value store, Node built-ins, or NestJS. The standard export (`.`) builds on `shared` and adds the
backend-only machinery.

The boundary is enforced by construction:

- `src/shared/**` imports only from `src/shared/**` (plus the Decaf UI/decoration packages), never
  from `src/engine/**`, `src/node/**`, `src/nest/**`, `src/ram/**`, or `src/log/**`.
- `src/index.ts` re-exports `./engine` and `./node`; the engine imports `shared`, never the reverse.
  The dedicated `./ram` export is backend-only and is imported by the `nest` wiring, never by `shared`.

#### Folder structure

```text
src/
├── shared/     # UI-known contracts; import from "@decaf-ts/as-graph/shared"
│   ├── graph/
│   │   ├── document/     # canonical workflow document, builder, reader, (de)serializer
│   │   ├── catalog/      # node manifests, schemas, parameter/port declarations
│   │   ├── decorators.ts # @node, @graph, @port, @input, @output, @connection, @pinnable
│   │   ├── auth.ts       # namespace/role auth requirements carried on nodes and workflows
│   │   ├── constants.ts  # GraphKeys, statuses, visual states, event types
│   │   ├── reader.ts     # metadata readers (ports, nodes, workflows)
│   │   └── snapshot.ts   # frontend-safe execution snapshots
│   └── ui/               # framework-neutral view models for the graph UI
├── node/       # engine-neutral built-in @node classes, one folder per node: node/<category>/<sub>/<node>/node.ts
│               # (triggers, flow, data, io, storage, devops, comms, utility, boundary)
├── engine/     # execution engine (planning, validation, auth, credentials, loops, pinning, runs, store, catalog)
├── nest/       # NestJS HTTP/SSE wiring for the engine
├── ram/        # adapter-backed run/run-event persistence (RamGraphRunStore, RamGraphRunEventStore)
├── mastra/     # Mastra execution backend; mastra/nodes/ owns the Mastra-dependent node classes and registry
├── typeorm/    # durable Postgres adapter factory for the as-graph decaf tables
├── dagster/    # Dagster execution backend (host-injected DagsterClient port)
├── workflows/  # demo workflow registries: basic/ (engine-neutral fixtures, /workflows export)
│               # and mastra/ (Mastra capability fixtures + coverage matrix, /workflows/mastra export)
├── assets/     # locale JSON for @uielement strings (i18n/en.json, shipped via package files)
└── log/        # run-log channel
```

The graph **workflow document** is the single executable artifact. Decorated workflow classes are
compiled into a canonical `GraphWorkflowDocument` (`GraphDecoratedWorkflowCompiler` /
`GraphWorkflowDocumentBuilder`) before execution; the engine never executes a raw decorated definition.

#### Execution and persistence semantics

The document topology **is** the concurrency model: multiple `data` connections out of one output port
fan out and execute concurrently, and multiple connections into one input port fan in and are joined
before the target node runs. There is no dedicated `parallel` node kind (`core.data.merge` is a data-transform node, not an
execution branch merge). Node classes
carry their behaviour on the **instance** `execute` method (parameters are hydrated onto the instance
before it runs), and each kind is described by a `GraphNodeManifest` compiled from `@node`/`@input`/
`@output` metadata.

Before any node executes, `GraphAuthValidator` authorizes the authenticated principal against the
workflow's declared auth requirements and every plan node's required namespaces, and fails closed when
a declared requirement is not granted (see [NestJS](#nestjs) for how the principal reaches the engine).

Run lifecycle records, run event envelopes and cached/pinned values are persisted through
adapter-backed `@repository()` stores from the `@decaf-ts/as-graph/ram` export; the engine itself keeps
only per-execution runtime values in-process. The `InMemoryGraphRunStore`/`InMemoryGraphRunEventStore`
classes exported from the main entry point are in-process test doubles, not production persistence.

#### Architecture

The canonical document model and the engine execution flow are rendered from the PlantUML sources in
`workdocs/uml/` (sources alongside the images):

![Workflow document model](./workdocs/uml/diagram.png)

![Engine execution flow](./workdocs/uml/engine-execution.png)
