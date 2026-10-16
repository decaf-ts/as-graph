### How to Use

- [Initial Setup](./workdocs/tutorials/For%20Developers.md#_initial-setup_)
- [Installation](./workdocs/tutorials/For%20Developers.md#installation)
- [Scripts](./workdocs/tutorials/For%20Developers.md#scripts)
- [Linting](./workdocs/tutorials/For%20Developers.md#testing)
- [CI/CD](./workdocs/tutorials/For%20Developers.md#continuous-integrationdeployment)
- [Publishing](./workdocs/tutorials/For%20Developers.md#publishing)
- [Structure](./workdocs/tutorials/For%20Developers.md#repository-structure)
- [IDE Integrations](./workdocs/tutorials/For%20Developers.md#ide-integrations)
  - [VSCode(ium)](./workdocs/tutorials/For%20Developers.md#visual-studio-code-vscode)
  - [WebStorm](./workdocs/tutorials/For%20Developers.md#webstorm)
- [Considerations](./workdocs/tutorials/For%20Developers.md#considerations)

#### Installation

```bash
npm install @decaf-ts/as-graph
```

#### Entry points

| Import | Contains |
| --- | --- |
| `@decaf-ts/as-graph` | Backend engine: `GraphExecutionEngine`, planning, validation, auth, loops, pinning, run lifecycle, value store, the built-in node classes, and the node-kind persistence service (`GraphNodeModelService`) |
| `@decaf-ts/as-graph/shared` | UI-known contracts: `@node`/`@graph`/`@port` decorators, the canonical `GraphWorkflowDocument` and its builder/reader/serializer, manifest catalogue types, the persistable `GraphNodeModel` catalogue row with its manifest converters, constants, and frontend-safe execution-state projections |
| `@decaf-ts/as-graph/nest` | NestJS HTTP/SSE wiring: catalogue, workflow persistence and run-lifecycle controllers |
| `@decaf-ts/as-graph/ram` | Adapter-backed persistence: `GraphRunModel`/`GraphRunEventModel`/`GraphValueModel` and their `@repository()` classes, the `GraphNodeRepository` node-kind rows, the `RamGraphRunStore`/`RamGraphRunEventStore` stores, and the `createRamGraphAdapter` helper |
| `@decaf-ts/as-graph/mastra` | Mastra execution backend: `MastraGraphExecutionBackend`, the workflow compiler, condition/event bridges, schema converter, resume guard, and the Mastra capability table. Runs canonical documents on a host-injected `@mastra/core` runtime (pinned `1.74.0`) |
| `@decaf-ts/as-graph/dagster` | Dagster execution backend: `DagsterGraphExecutionBackend`, the workflow translator, event bridge, result mapper, capability table (`DAGSTER_CAPABILITY_TABLE`), and Dagster identifier/condition-grammar helpers. Driven through a host-injected `DagsterClient` port against the pinned engine contract (`1.13.25`; Dagster is Python-side, there is no JavaScript runtime dependency) |

The `exports` map in `package.json` is:

```jsonc
{
  "exports": {
    ".": {
      "import": { "types": "./lib/types/index.d.mts", "default": "./lib/esm/index.js" },
      "require": { "types": "./lib/types/index.d.cts", "default": "./lib/cjs/index.cjs" },
      "default": "./lib/esm/index.js"
    },
    "./shared": {
      "import": { "types": "./lib/types/shared/index.d.mts", "default": "./lib/esm/shared/index.js" },
      "require": { "types": "./lib/types/shared/index.d.cts", "default": "./lib/cjs/shared/index.cjs" },
      "default": "./lib/esm/shared/index.js"
    },
    "./nest": {
      "import": { "types": "./lib/types/nest/index.d.mts", "default": "./lib/esm/nest/index.js" },
      "require": { "types": "./lib/types/nest/index.d.cts", "default": "./lib/cjs/nest/index.cjs" },
      "default": "./lib/esm/nest/index.js"
    },
    "./ram": {
      "import": { "types": "./lib/types/ram/index.d.mts", "default": "./lib/esm/ram/index.js" },
      "require": { "types": "./lib/types/ram/index.d.cts", "default": "./lib/cjs/ram/index.cjs" },
      "default": "./lib/esm/ram/index.js"
    },
    "./mastra": {
      "import": { "types": "./lib/types/mastra/index.d.mts", "default": "./lib/esm/mastra/index.js" },
      "require": { "types": "./lib/types/mastra/index.d.cts", "default": "./lib/cjs/mastra/index.cjs" },
      "default": "./lib/esm/mastra/index.js"
    },
    "./dagster": {
      "import": { "types": "./lib/types/dagster/index.d.mts", "default": "./lib/esm/dagster/index.js" },
      "require": { "types": "./lib/types/dagster/index.d.cts", "default": "./lib/cjs/dagster/index.cjs" },
      "default": "./lib/esm/dagster/index.js"
    }
  }
}
```

#### Shared vs. engine boundary

Import UI-known code from `@decaf-ts/as-graph/shared` and backend code from
`@decaf-ts/as-graph`. **Nothing backend-specific may live in `shared`**: the shared entry point is
imported by browser bundles, so it must stay free of the engine, planner, run lifecycle, value store,
Node built-ins, and NestJS. See [Description](#description) for the full rule.

#### Defining a node

A node kind is a `@node`-decorated class extending `GraphNode<INPUT, OUTPUT>`. Decorated properties
declare its ports, and the **instance** `execute` method carries its behaviour. Configuration
properties are `@input`-decorated model properties rendered through for-angular webcomponents —
`@uielement("ngx-decaf-crud-field", …)` for plain fields — whose `label`/`placeholder` are locale keys
resolved from the locale assets (see [Built-in node kinds](#built-in-node-kinds)). Output ports are
data, not configuration, so they carry only `@output`:

```typescript
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { node, input, output } from "@decaf-ts/as-graph/shared";
import { GraphNode } from "@decaf-ts/as-graph";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "@decaf-ts/as-graph";

interface DoubleNodeInput {
  value: unknown;
}

interface DoubleNodeOutput {
  out: unknown;
}

@node("example.double", {
  kind: "example.double",
  category: "Utility",
  labels: ["example", "math"],
})
@model()
export class DoubleNode extends GraphNode<DoubleNodeInput, DoubleNodeOutput> {
  override execute(
    request: GraphNodeExecutionRequest<DoubleNodeInput>
  ): GraphExecutionValues {
    return { out: Number(request.inputs["value"]) * 2 };
  }

  @required()
  @uielement("ngx-decaf-crud-field", { label: "example.double.value.label" })
  @input({ handle: "value" })
  value!: unknown;

  @required()
  @output({ handle: "out" })
  out!: unknown;
}
```

The class is both the published manifest source and the executable behaviour: the catalogue compiles
the `@node`/`@input`/`@output` metadata into a `GraphNodeManifest` with `graphNodeManifest` and pairs
it with the class's `execute` through a `GraphNodeRegistration`. The executor instantiates the class
and invokes the instance `execute` (the built-in registrations hydrate the executing node's
`parameters` onto the instance first, so `execute` can read its own configuration as `this.*`):

```typescript
import {
  GraphNodeCatalogue,
  defineGraphNode,
  registerBuiltInGraphNodes,
} from "@decaf-ts/as-graph";
import { graphNodeManifest } from "@decaf-ts/as-graph/shared";
import { DoubleNode } from "./double-node";

const catalogue = new GraphNodeCatalogue();
registerBuiltInGraphNodes(catalogue); // the built-in node kinds
catalogue.register(
  defineGraphNode({
    manifest: graphNodeManifest(DoubleNode, { name: "Double" }),
    executor: {
      execute: (request, context) => new DoubleNode().execute(request, context),
    },
  })
);
```

#### Built-in node kinds

The built-in kinds are declared one folder per node under
`node/<category>/<sub>/<node>/node.ts` and are registered from their `@node` metadata:

| Group | Kinds |
| --- | --- |
| Triggers | `core.trigger.manual`, `core.trigger.webhook`, `core.trigger.schedule`, `core.trigger.event`, `core.trigger.form`, `core.trigger.chat` |
| Flow | `core.flow.if`, `core.flow.switch`, `core.flow.delay`, `core.flow.errorBoundary`, `core.flow.humanApproval`, `core.flow.log`, `core.flow.break` |
| Utility | `core.utility.code`, `core.utility.map`, `core.utility.log` |
| Loops | `core.loop.foreach`, `core.loop.while`, `core.loop.until` |
| Agent | `core.agent` |
| Boundary | `graph-input-value-node` (`GraphNode<void, …>` — reusable value node whose single `value` output may feed multiple targets), `graph-output-value-node` (`GraphNode<…, void>` — terminal sink whose `value` input receives the workflow result; it has **no output port** — the engine captures workflow outputs from the `$workflow` boundary edges into it) |

There are no `parallel` or `merge` node kinds: the graph itself parallelizes on multiple connections
to an output port (native fan-out) and syncs on multiple connections into an input port (native
fan-in). Notable per-node properties:

- `core.utility.code` — `timeoutMs` (node property forwarded to the code sandbox evaluator) and the
  `code` editor field (`@uielement("code-editor", …)`).
- `core.trigger.schedule` — `cron`, mapped to the for-angular Cron input
  (`@uielement("app-cron-selector-field", …)`), with timezone support.
- `core.trigger.form` / `core.trigger.webhook` — `schema`, a `ModelBuilder`-produced model rendered
  with the for-angular model-builder webcomponent (`@uielement("ngx-decaf-model-builder", …)`); the
  resulting `payload` output is a plain data port.

`@uielement` labels and placeholders are locale keys, not hardcoded strings: the strings live in
`assets/i18n/en.json`, shipped in the published package.

#### Building a workflow document

Workflow documents are canonical `GraphWorkflowDocument`s built with the fluent
`GraphWorkflowDocumentBuilder`. A document declares its boundary ports, its node instances and the
`data` edges that route values between them:

```typescript
import { GraphWorkflowDocumentBuilder } from "@decaf-ts/as-graph/shared";

const document = new GraphWorkflowDocumentBuilder("double", "Double")
  .addInput({ id: "x", label: "x" })
  .addOutput({ id: "result", label: "Result" })
  .addNode({ id: "doubler", kind: "example.double", parameters: {} })
  .addEdge({
    id: "e1",
    type: "data",
    source: { scope: "workflow", port: "x" },
    target: { scope: "node", nodeId: "doubler", port: "value" },
  })
  .addEdge({
    id: "e2",
    type: "data",
    source: { scope: "node", nodeId: "doubler", port: "out" },
    target: { scope: "workflow", port: "result" },
  })
  .build();
```

`build()` validates the document (unique ids, valid endpoints, JSON-safe values) and freezes a
defensive copy. Decorated workflow classes can be compiled into the same shape with
`GraphDecoratedWorkflowCompiler`. Use `graphWorkflowDocumentSerializer` /
`graphWorkflowDocumentDeserializer` for save/load round-trips.

#### Executing a workflow document

`GraphExecutionEngine` is a Decaf `ClientBasedService`: construct it with no arguments and pass its
`GraphExecutionEngineConfig` to `await engine.boot(config)`. `execute(document, inputs)` validates the
document through the nine-stage gate, authorizes the principal against the workflow's and every node's
declared namespaces/roles (fail closed on ungranted requirements), resolves it against the trusted
catalogue, plans it into topological layers, and executes them. It returns a `GraphExecutionResult`
with per-node results and the workflow outputs:

```typescript
import {
  GraphExecutionEngine,
  GraphNodeExecutorRegistry,
  GraphNodeCatalogue,
  registerBuiltInGraphNodes,
} from "@decaf-ts/as-graph";
import { createRamGraphAdapter } from "@decaf-ts/as-graph/ram";

const catalogue = new GraphNodeCatalogue();
registerBuiltInGraphNodes(catalogue);
// register custom kinds on `catalogue` (see "Defining a node")

const registry = new GraphNodeExecutorRegistry(catalogue);
const adapter = await createRamGraphAdapter(); // or your production adapter
const engine = new GraphExecutionEngine();
await engine.boot({ registry, valueAdapter: adapter });

const result = await engine.execute(document, { x: 21 });

console.log(result.status);         // "succeeded"
console.log(result.outputs.result); // 42
console.log(result.nodeResults["doubler"].outputs); // { out: 42 }
```

The engine emits structured events (workflow/node/edge lifecycle, visual state changes and the run-log
channel) through Decaf's Observable pipeline. Register an observer with `engine.observe({ refresh })`.
Pinnable nodes are cached and replayed with `engine.pinNode(...)` / `engine.unpinNode(...)`.

#### Execution backends

`GraphExecutionEngine` delegates actual execution to a pluggable
`GraphExecutionBackend` — the engine's analogue of Decaf's persistence `Adapter`
seam. The facade always owns validation, catalogue resolution, authorization,
planning, event sequencing, and observer dispatch; a backend only runs the
resolved plan and/or canonical document and reports every transition through the
facade-owned event sink. It can never bypass the pre-execution gate.

The default backend is a fresh `LocalGraphExecutionBackend` (flavour `local`, the
built-in reference interpreter) per engine: it executes in-process, runs code-mode
surfaces host-side through the configured `codeSandboxEvaluator`, and backs the
engine-agnostic workflow listing/lookup with the `workflowStore` port from the
engine config. Remote/translated backends are supplied through
`GraphExecutionEngineConfig.backend` (initialize the backend with its own host
config first — see below).

Registration and lookup mirror Decaf's persistence-adapter registry through the
static `GraphExecutionBackendRegistry`: `register(flavour, backend)` (the built-in
backends self-register under their flavour on construction), `get(flavour?)`,
`getOrFail(flavour)`, `setCurrent(flavour)` / `current` / `currentFlavour`,
`list()`, and `clear()` (test isolation). The current flavour is never changed
implicitly — hosts opt into a non-default backend explicitly, so concurrently
booted engines never share per-run state.

A backend declares its contract to the facade:

| Declaration | Meaning |
| --- | --- |
| `local` | Whether the backend executes in-process. |
| `codeMode` | `"hostSide"` (code-mode surfaces run through the facade-owned sandbox evaluator) or `"unsupported"`. The facade fails closed with `GRAPH_CODE_MODE_UNSUPPORTED_BACKEND` before delegating a code-mode workflow to any backend that is not local and not `"hostSide"`. |
| `capabilities` | Optional `GraphBackendCapabilities` (`codeMode` plus `workflows: { list, get }`). When omitted, the facade derives them from the declared `codeMode` and the presence of the optional `listWorkflows`/`getWorkflow` methods (`resolveGraphBackendCapabilities`), so an unsupported operation is reported as `not_supported` instead of silently returning an empty result. |
| optional methods | `listWorkflows` / `getWorkflow` (workflow catalogue seam), `seedWorkflows` (workflow seeding seam), `cancel`, `resume`, `release`, `dispose`. |

Engine-level reads of the active backend: `engine.backend`,
`engine.backendCapabilities`, `engine.listWorkflows()` (active backend),
and the flavour-scoped `engine.listEngineWorkflows(flavour)` /
`engine.getEngineWorkflow(flavour, workflowId)` counterparts, which fail closed
with `GRAPH_EXECUTION_BACKEND_NOT_REGISTERED` (unknown flavour) or
`GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED` (no listing/lookup support).

##### Workflow seeding

Every backend exposes an optional `seedWorkflows(documents)` seam so a host can
register canonical `GraphWorkflowDocument`s into the driver's own persistence at
boot — each driver seeds into its own storage and serves the seeded entries
through its normal `listWorkflows`/`getWorkflow` path:

- `local` persists each document through the wired `workflowStore` write path
  (`saveDocument`), so seeding honours the same boundary validation and
  ownership rules as any other write, and fails closed with
  `GRAPH_BACKEND_SEED_NOT_SUPPORTED` when no writable store is configured.
- `mastra` registers the documents in its compiled-workflow cache, so seeded
  entries are served exactly like a workflow recorded by `execute`; seeded
  entries are owner-less and therefore visible to every caller.
- `dagster` adds the documents to its read-only catalogue map alongside the
  deployment's jobs — a host boot action, never an authoring surface: authoring
  capabilities stay `not_supported`.

The engine facade wires it at boot: passing
`seedWorkflows: GraphWorkflowDocument[]` in the `GraphExecutionEngineConfig`
(or `GraphExecutionModuleOptions.seedWorkflows` for the NestJS module) makes the
engine call the active backend's `seedWorkflows` during `boot()`, failing closed
with `GRAPH_BACKEND_SEED_NOT_SUPPORTED` when the backend does not implement it.

##### Mastra backend (`@decaf-ts/as-graph/mastra`)

`MastraGraphExecutionBackend` translates the canonical document into a Mastra
workflow, runs it on the injected `@mastra/core` runtime (pinned `1.74.0`),
bridges Mastra's `fullStream` onto the facade event sink, and enforces the
schema-safe resume guard on every resume payload. It reports `codeMode:
"unsupported"` (code-mode surfaces currently fail closed) and surfaces
`workflowList`/`workflowLookup` over its compiled-workflow cache. Its full
per-feature capability table (`MASTRA_FEATURE_CAPABILITIES`) declares, per
feature, `SUPPORTED` / `NOT_SUPPORTED` / `EXTENSION_POINT` / `PARTIAL` — e.g.
`whileUntil`, `foreach`, `humanApproval`, and `durableExecution` are supported;
`parallel` and `dynamicTopology` are not translated; `suspendResume` is an
extension point through the optional backend `resume?()`.

```typescript
import { MastraGraphExecutionBackend } from "@decaf-ts/as-graph/mastra";

const backend = new MastraGraphExecutionBackend(); // self-registers under the "mastra" flavour
await backend.initialize({
  mastra,              // the host's @mastra/core runtime instance
  agents,              // optional agent map for agent/LLM nodes
  stepHandlers,        // optional MastraNodeStepHandler[] for custom node kinds
  suspendStateReader,  // optional, for suspend/resume runs
  maxResumeBytes,      // optional resume payload byte cap
});
// pass `backend` via GraphExecutionEngineConfig.backend
```

The flavour constant is `MASTRA_BACKEND_FLAVOUR` (`"mastra"`); unsupported node
kinds and unsafe/invalid resume payloads fail loudly with
`GRAPH_MASTRA_UNSUPPORTED_KIND` / `GRAPH_MASTRA_RESUME_*` errors.

##### Dagster backend (`@decaf-ts/as-graph/dagster`)

`DagsterGraphExecutionBackend` translates the canonical document into Dagster
job/schedule/sensor artifacts and dispatches execution through a host-injected
`DagsterClient` port — Dagster is a Python orchestration engine with no official
JavaScript runtime, so the client (and any op body for custom node kinds) is
always host-supplied. The pin recorded in the package is `1.13.25`
(`DAGSTER_PINNED_VERSION`, sourced from PyPI), which the generated artifacts
target. The backend reports `codeMode: "unsupported"` (code-mode workflows are
rejected before translation with `GRAPH_DAGSTER_CODE_MODE_UNSUPPORTED`), and
workflow listing/lookup is supported exactly when the wired client port exposes
`listJobs`/`getJob` (`dagsterBackendCapabilities(client)`).

The exported `DAGSTER_CAPABILITY_TABLE` declares, per feature, whether Dagster
supports it natively, not at all, or only through an extension point: sequential
nodes, `if`/`switch` routing, `foreach` (DynamicOut fan-out), schedule triggers,
and webhook/event/form/chat triggers (sensors) are supported; `while`/`until`
loops, suspend/resume, human approval, and code-mode surfaces are declared
`not_supported` so translation fails loudly rather than silently dropping them;
manual triggers and agent/custom node kinds are extension points
(`DagsterOpResolver` supplies the fixed op body; unmapped kinds fail loudly).

```typescript
import { DagsterGraphExecutionBackend } from "@decaf-ts/as-graph/dagster";

const backend = new DagsterGraphExecutionBackend(); // self-registers under the "dagster" flavour
await backend.initialize({
  client,      // host-injected DagsterClient port (required)
  opResolver,  // optional DagsterOpResolver for non-built-in kinds
  tags,        // optional default run tags
});
// pass `backend` via GraphExecutionEngineConfig.backend
```

#### Persistence (`@decaf-ts/as-graph/ram`)

Run lifecycle and cached/pinned-value persistence always flows through Decaf repositories over a
**provided** adapter — the stores never create one implicitly. The `./ram` export contains:

| Export | Role |
| --- | --- |
| `GraphRunModel` / `GraphRunRepository` | Run lifecycle records (durable run history), persisted as `graph_run` rows |
| `GraphRunEventModel` / `GraphRunEventRepository` | Run event envelopes (SSE replay/audit), persisted as `graph_run_event` rows; live subscribers stay in-process |
| `GraphValueModel` / `GraphValueRepository` | Cached/pinned graph values (must survive restarts for pinning), persisted as `graph_value` rows; per-execution runtime values are not persisted |
| `GraphNodeRepository` | Node-kind catalogue rows (one row per registered kind, persisted as `graph_node`); the `GraphNodeModel` row class lives in `./shared` so backend stores and UI listing/forms share it |
| `RamGraphRunStore` / `RamGraphRunEventStore` | Adapter-backed `GraphRunStore`/`GraphRunEventStore` implementations; construct with an initialized adapter |
| `createRamGraphAdapter(alias?)` | Creates and initializes a `RamAdapter` (tests); production passes a durable adapter (e.g. TypeORM) |
| `createGraphValueRepository(adapter)` | Factory for a fresh `GraphValueRepository` instance over the provided adapter |

```typescript
import { RamGraphRunStore, createRamGraphAdapter } from "@decaf-ts/as-graph/ram";

const adapter = await createRamGraphAdapter();
const runStore = new RamGraphRunStore(adapter);
```

The `InMemoryGraphRunStore`/`InMemoryGraphRunEventStore` classes exported from the main entry point
are in-process test doubles for the SSE/concurrency test suites; they are not exported from `./ram`
and must not be used as production persistence. In a NestJS host,
`GraphExecutionModule.forRoot({ valueAdapter, runAdapter })` wires these adapter-backed stores
automatically (see [NestJS](#nestjs)).

#### Consuming `shared` from a UI

A UI bundle imports only from `@decaf-ts/as-graph/shared` and stays engine-free:

```typescript
import {
  GraphWorkflowDocumentBuilder,
  graphWorkflowDocumentDeserializer,
  graphNodeManifest,
  graphVisualStyleOf,
  graphCategoryStyleOf,
} from "@decaf-ts/as-graph/shared";
import { DoubleNode } from "./double-node";

// Render a palette from the same manifests the backend executes.
const manifest = graphNodeManifest(DoubleNode, { name: "Double" });

// Build or load the canonical document the backend will run.
const document = graphWorkflowDocumentDeserializer(savedJson);

// Resolve run feedback from engine events without importing the engine.
const style = graphVisualStyleOf(event.payload.state);
```

`shared/ui` adds framework-neutral view models (`GraphNodeView`, `GraphWorkflowView`) that project
manifests, documents and engine run results into DOM-free render inputs.

#### NestJS

`GraphExecutionModule.forRoot(options)` wires the engine into a NestJS app: the node catalogue API
(`GET /graph/node-types`, `GET /graph/node-types/:kind`, `POST /graph/node-types/:kind/resolve`), canonical
workflow persistence (`PUT|GET /graph/workflows/:workflowId`, `GET /graph/workflows` ownership-filtered
summaries, `POST /graph/workflows/validate`), the asynchronous run lifecycle (`POST /graph/runs` → `202`,
`GET /graph/workflows/:workflowId/runs` per-workflow run listing, `GET /graph/runs/:runId/events` SSE,
`DELETE /graph/runs/:runId`), and the read-only engine capability API (`GET /graph/engines`,
`GET /graph/engines/:engineId`, `GET /graph/engines/:engineId/workflows`,
`GET /graph/engines/:engineId/workflows/:workflowId`).
The engine provider is a Decaf `ClientBasedService`: the module constructs `new GraphExecutionEngine()`
and initializes it with `await engine.boot(config)`.

The module also mirrors the populated node catalogue into repository-backed rows at boot: a
`GraphNodeModelService` provider upserts every registered node-kind manifest as a `GraphNodeModel`
row (`syncFromCatalogue`), so node kinds are exposed through repository/adapter CRUD and listing
(`GraphNodeRepository`) for whichever engine the host booted — mirroring the
`GraphWorkflowService`/`GraphRunModelService` persistence pattern.

The engine capability API serves a statically-derived, boot-time capability manifest
(`GraphEngineCapabilityService`): it is built once from the backends registered in the
`GraphExecutionBackendRegistry`, only allowlisted flavours (`local`, `mastra`, `dagster`) are advertised,
and no remote engine is ever probed. Every `detail` is a static, reviewed literal — no secrets and no
dynamic engine output. The manifest shape:

```typescript
{
  engines: [
    {
      engineId: "local",          // backend flavour (allowlisted id)
      displayName: "Local (built-in)",
      local: true,
      pinnedEngineVersion: "built-in", // "1.13.25" for dagster, "1.74.0" for mastra
      capabilities: [
        { feature: "codeMode", verdict: "SUPPORTED", detail?: "…" },
        { feature: "workflowList", verdict: "NOT_SUPPORTED" },
        // …
      ],
    },
    // …
  ],
  defaultEngineId: "local",
}
```

The three-value verdict vocabulary (`SUPPORTED` / `NOT_SUPPORTED` / `EXTENSION_POINT`) is normalized
from the wrapper capability tables, so a partially-supported feature is never advertised as a usable
toggle. The workflow listing/lookup routes resolve through the engine-agnostic facade
(`listEngineWorkflows` / `getEngineWorkflow`) and answer `404` for an unknown engine id and `501` when
the selected engine declares no listing/lookup support. Engines are selected by allowlisted id only and
routes never reflect arbitrary query input; authentication defaults to `"required"` (a request without
an authenticated owner user is rejected with `401`) and can be relaxed to `"optional"` per host.

`GraphExecutionModuleOptions`:

| Option | Meaning |
| --- | --- |
| `initAdapter` / `adapterUser` | Secure-default adapter bootstrap: only `initAdapter: true` installs a standalone `RamAdapter`; otherwise the host must have configured a Decaf adapter via `DecafModule.forRoot(...)`, and construction fails closed with a `GraphStoreError` when none is current |
| `valueAdapter` | Adapter backing cached/pinned value persistence; falls back to the globally configured adapter (`Adapter.current`) |
| `runAdapter` | Adapter backing run and run-event persistence; falls back to `valueAdapter`, then to `Adapter.current`. Runs and run events always persist through the adapter-backed `@repository()` stores (`RamGraphRunStore` / `RamGraphRunEventStore`) — never a process-local map |
| `seedWorkflows` | Canonical workflow documents seeded into the active backend at boot through the backend's `seedWorkflows` seam (see [Workflow seeding](#workflow-seeding)) |
| `credentialAuthorizer` | Stage-8 credential existence/authorization hook wired into the engine's document validator; without it, credential checks are shape/type-only |
| `authHandler` | `AuthHandler` class installed via `DecafAuthModule.forRoot` (the for-nest pattern; typical values: `KeycloakAuthHandler` / `KeycloakNamespaceAuthHandler` from `@decaf-ts/integrations/nest`). It primes every request context with the authenticated `user` / `roles` / `namespaces` / `organization`, which `GraphAuthValidator` authorizes each workflow and node against |
| `authGlobal` | When `true` (default when `authHandler` is set), the auth interceptor is registered globally; `false` installs the handler without a global interceptor (routes opt in with `@Auth()`) |
| `authLogAccess` | When `true` (and `authHandler` is set), the handler emits OCSF-style access logs |
| `catalogue` / `workflows` / `runs` | Per-API authentication enforcement plus backend-enforced rate limits (`resolve`/`methods`) and document/run resource limits |
| `engines` | Options for the engine capability HTTP API: `auth` (`"required"` default / `"optional"`), `defaultEngineId` (the advertised default; ignored when it is not a registered, allowlisted engine id — the current backend flavour is used instead), and `rateLimit` (`windowMs`/`maxRequests`, default 120 requests per 60-second window on the `engines` throttler bucket) |

Without an `authHandler`, no auth middleware or interceptor is installed and graph auth requirements
fail closed. The engine's `GraphAuthValidator` runs before any node executes: it validates the
workflow-level auth requirements and every plan node's required namespaces against the principal and
throws `ForbiddenError` on the first ungranted requirement.

```typescript
import { GraphExecutionModule } from "@decaf-ts/as-graph/nest";
import { KeycloakAuthHandler } from "@decaf-ts/integrations/nest";

@Module({
  imports: [
    GraphExecutionModule.forRoot({
      // host-configured adapter via DecafModule.forRoot(...), or initAdapter: true
      // for the standalone RamAdapter
      authHandler: KeycloakAuthHandler,
      authGlobal: true,
      authLogAccess: true,
    }),
  ],
})
export class AppModule {}
```

#### Running each backend + UI combination

The standalone host (`bin.as-graph-server`, `lib/cjs/nest/graph/main.cjs`) boots exactly one engine
variant, selected by `GRAPH_BACKEND_ENGINE`, and serves the C20 capability manifest
(`GET /graph/engines`) plus the per-engine workflow catalogue
(`GET /graph/engines/{engineId}/workflows`). The for-angular graph page talks to it over
`http://localhost:3000` (`GRAPH_BACKEND_URL`) and needs no code change when the variant changes — it
lists whatever the backend advertises and gates its actions on the served capabilities.

**Build first.** The scripts run the compiled entrypoint, so `npm run build` (or `build:prod`) must
have produced `lib/cjs/nest/graph/main.cjs`.

| Combination | Boot the backend | Run the UI | Backend port | Extra prerequisites |
| --- | --- | --- | --- | --- |
| standard (local engine) | `npm run start:backend` / `start:backend:local` | `npm run start` (for-angular, `:8110`) | `3000` | none — built-in reference interpreter |
| mastra | `npm run start:backend:mastra` | `npm run start` (for-angular, `:8110`) | `3000` | `@mastra/core` peer installed (`^1.77.0`) |
| dagster | `npm run start:backend:dagster` | `npm run start` (for-angular, `:8110`) | `3000` | a Dagster gateway + `DAGSTER_GRAPHQL_URL` (see below) |

From `for-angular`, `npm run start:dev` (local), `start:dev:mastra`, and `start:dev:dagster` boot
the backend and the UI together with `concurrently`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GRAPH_BACKEND_ENGINE` | `local` | `local` \| `mastra` \| `dagster`; an unknown value fails closed with `GRAPH_BACKEND_ENGINE_UNKNOWN` |
| `GRAPH_BACKEND_PORT` | `3000` | Backend HTTP port (the standalone binary also accepts the port as its first argument) |
| `DAGSTER_GRAPHQL_URL` | unset | Read-only Dagster client target. Without it the dagster backend still boots and serves the manifest, but the catalogue reports `NOT_SUPPORTED` (`501`) |
| `DAGSTER_EXECUTION_ENABLED` | `false` | Opt-in gate for launching/replaying existing Dagster runs |
| `GRAPH_BACKEND_URL` | `http://localhost:3000` | for-angular injection token for the backend base URL (a provider override, not an env var) |

The host binds to `127.0.0.1` and only admits `http://localhost`/`http://127.0.0.1` CORS origins
(development posture, SAA-595 F5).

##### Demo workflow seeding

The standalone host seeds the demo workflow fixture registry into whichever
engine it boots: `loadGraphDemoWorkflows()` (exported from
`@decaf-ts/as-graph/nest`) imports the `graphWorkflowFixtures` registry from
`src/workflows` and passes its canonical documents as `seedWorkflows`, so each
driver's catalogue lists the full fixture set out of the box. The registry is
test-only content — `npm pack` excludes `lib/**/workflows` — so a
release-packaged host boots with an empty seed set and its catalogues behave
exactly as before (the mastra catalogue starts empty; the dagster catalogue
needs a wired client).

##### Standard (local engine)

No backing service. Build the backend, boot it, and run the UI in a second terminal:

```bash
# as-graph
npm run build && npm run start:backend        # http://127.0.0.1:3000 (engine: local)
# for-angular
npm run start                                 # http://localhost:8110
```

Verify the backend advertises the local engine:

```bash
curl -s http://127.0.0.1:3000/graph/engines   # .defaultEngineId == "local"
```

Open the workflow catalog (`http://localhost:8110/workflows`); the workflow table lists the
workflows persisted in the backend's local engine store, including the seeded demo fixture set.

##### Mastra

In-process; the only prerequisite is the `@mastra/core` peer dependency (pinned `^1.77.0`),
resolved by `npm install` in `as-graph`. The host lazily builds a real `@mastra/core` runtime.

```bash
npm run start:backend:mastra                  # engine: mastra, still on :3000
```

The Mastra catalogue lists the workflows registered in the process: the seeded demo fixture set
(see [Demo workflow seeding](#demo-workflow-seeding)) plus every workflow already compiled/executed
in the process (its `workflowList`/`workflowLookup` capability). The manifest advertises the mastra
engine and its per-feature verdicts.

##### Dagster

Dagster is Python-side and has no JavaScript runtime, so the backend lists/executes through a
host-injected `DagsterClient` built from `DAGSTER_GRAPHQL_URL`. Provision the pinned gateway fixture
(Docker; Dagster `1.13.25`) with the integration harness:

```bash
# as-graph: boot + seed the pinned gateway and persist its GraphQL URL
npm run prepare-it-tests                      # publishes the gateway at http://127.0.0.1:3300/graphql
DAGSTER_GRAPHQL_URL=http://127.0.0.1:3300/graphql npm run start:backend:dagster
npm run teardown-it-tests                     # when done
```

Without `DAGSTER_GRAPHQL_URL` the dagster host still boots and serves the manifest; with the
seeded fixture set its catalogue lists those fixtures read-only, while a release-packaged host
with an empty seed set answers `501` (`NOT_SUPPORTED`). To run against an already-running Dagster, set
`DAGSTER_GRAPHQL_URL` yourself and skip `prepare-it-tests`.

> **Environment note (CI sandbox):** inside a container (`/.dockerenv`), the fixture joins the
> runner's network namespace and binds `127.0.0.1:3000`, which collides with the graph backend's
> default port. On a normal host the fixture is published at `127.0.0.1:3300`, so there is no
> collision. Because the for-angular UI is wired to `http://localhost:3000`, run the Dagster gateway
> on a host (or another namespace) and keep the graph backend on `3000` when exercising the UI +
> dagster combination.

##### Verifying the UI lists a backend's scenarios

1. `GET /graph/engines` returns the manifest with `defaultEngineId` equal to the booted variant.
2. `GET /graph/engines/{engineId}/workflows` returns that engine's catalogue (`200`), or `501` when
   the engine declares no listing support (dagster without a client and without seeded fixtures).
3. In the UI the workflow table shows the catalogue rows and gates create/run/save per the manifest
   verdicts; switching variants requires no UI code change.

##### Running each variant's test suite

| Variant | Command |
| --- | --- |
| standard (local) | `npm run test:integration:standard` |
| mastra | `npm run test:integration:mastra` |
| dagster | `npm run prepare-it-tests` then `npm run test:integration:dagster` (or `npm run teardown-it-tests` after) |
| backend host boot (all variants + standalone binary) | `npm run test:integration:backend` |

The dagster suite needs the gateway fixture (`prepare-it-tests`) and Docker; it skips honestly when
no gateway is prepared. The standalone-binary boot test needs the `lib/cjs` build and skips when it
is absent.

#### Scripts

| Script | Purpose |
| --- | --- |
| `npm run build` / `build:prod` | Compile ESM + CJS + types |
| `npm run start:backend` / `start:backend:local` | Boot the standalone host with the built-in local engine (`:3000`) |
| `npm run start:backend:mastra` | Boot the standalone host with the Mastra engine (`GRAPH_BACKEND_ENGINE=mastra`) |
| `npm run start:backend:dagster` | Boot the standalone host with the Dagster engine (`GRAPH_BACKEND_ENGINE=dagster`) |
| `npm run test:integration:standard` / `:mastra` / `:dagster` | Run one engine variant's integration suite |
| `npm run test:integration:backend` | Run the host-boot integration suite (all variants + standalone binary) |
| `npm run prepare-it-tests` / `teardown-it-tests` | Provision / stop the pinned Dagster gateway fixture |
| `npm run test:unit` / `test:integration` / `test:e2e` | Run the Jest unit / integration / e2e suites |
| `npm run test:all` | Run the entire Jest suite (unit, integration, e2e) |
| `npm run test:dist` | Re-run the full suite against the compiled `lib` and `dist` outputs |
| `npm run test:circular` | Check the source for circular dependencies |
| `npm run coverage` | Test run with coverage into `workdocs/reports/coverage` |
| `npm run lint` / `lint-fix` | ESLint |
| `npm run docs` | Build the generated JSDoc site into `docs/` |
| `npm run uml` / `drawings` | Render `workdocs/uml/*.puml` and `workdocs/drawings/*.drawio` into `workdocs/resources` |
| `repo:readme` | Regenerate `README.md` from `workdocs/Readme.md` |
