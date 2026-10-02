# AGENTS.md — as-graph

`@decaf-ts/as-graph` is a **backend-only** module. No UI/Angular/storybook
imports anywhere. UI graph work lives in `for-angular/graph`.

## Invariant — code changes MUST update the backend graph skills

Any change to as-graph code MUST be reflected in the matching backend graph
skill(s) in the company skills catalog in the same working change. This covers
node classes, the `@node`/`@port`/`@input`/`@output`/`@connection` decorators
and port wrappers, the node property taxonomy, `@uielement` usage, the locale JSON
(`assets/i18n/en.json`), auth/namespaces, and the serialized
`GraphWorkflowDocument` format. A code change that leaves its skill stale is
**incomplete** — do not consider the change done until the skill is updated.

Skill map (company skills catalog, `/company/skills/decaf-ts/`):

| Code area | Skill to update |
|:----------|:----------------|
| Module map, import surfaces, architectural invariants | `/company/skills/decaf-ts/as-graph/SKILL.md` |
| Node classes, `@node` options, `@port` + `@input`/`@output`/`@connection`, property taxonomy, `@uielement`, `GraphValueTemplate`, locale-key structure | `/company/skills/decaf-ts/as-graph/nodes/SKILL.md` |
| Workflows via code or serialized `GraphWorkflowDocument`, builder/serializer, persistence | `/company/skills/decaf-ts/as-graph/workflows/SKILL.md` |
| Engine boot/config, validation gate, planning, events/SSE, loops, pinning, runs, NestJS wiring, `./ram` persistence | `/company/skills/decaf-ts/as-graph/engine/SKILL.md` |
| Auth: optional/Keycloak-automatic, `@namespace()`, decomposition, `GraphAuthData` | `/company/skills/decaf-ts/as-graph/auth/SKILL.md` |
| `@namespace(...)` in `@decaf-ts/integrations` | `/company/skills/decaf-ts/integrations/graph/SKILL.md` |
| `@uielement`/`@hidden`/`@uimodel` binding used by node properties | `/company/skills/decaf-ts/ui-decorators/graph/SKILL.md` |

## Canonical rules document

`workdocs/ai/project/technical-docs/design-specification/08-graph-design.md`
(umbrella repo root; **§0**) is the canonical rules document for the node
rules, locale-key structure, auth model, and serialized format. Skills reference
it; do not fork or restate its normative content.

## Rules

- Read the affected skill(s) before changing code; update them in the same change.
- Keep every skill backend-only; leave renderer/UI guidance to `for-angular/graph`.
- If a rule is unclear, ask the board/manager — do not guess.
