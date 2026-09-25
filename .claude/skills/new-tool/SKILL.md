---
name: new-tool
description: Add a new GitHub side effect (BrokerAction variant) that agents may request - schema, broker execution, policy enum, tests, docs. Use when an agent needs a capability the broker does not have yet.
argument-hint: <action.type> "<what it does>"
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(pnpm *)
skills:
  - custodes-conventions
---

# New broker action: $ARGUMENTS

Adding an action widens what _every_ agent could be granted, so keep it narrow and test the
denial path first.

1. `packages/schema/src/actions.ts`: add a `z.object({ type: z.literal('$0'), ... })` variant with
   tight bounds (max lengths, positive ints, enums). `BrokerActionType` updates automatically.
2. `packages/github/src/api.ts`: add the REST call to `GitHubRest` and a `case '$0'` in
   `executeAction`. Text bodies must go through `decorate()` so trailers are appended.
3. `packages/email/src/templates.ts`: add a `case` to `summariseAction`.
4. Tests: `packages/schema/test` (bounds), `packages/github/test/api.test.ts` (request shape, no
   body leak in errors), `packages/core/test/policy-eval.test.ts` (denied when not in policy).
5. Docs: add a row to the actions table in `docs/architecture/security-controls.md` including the
   fine-grained PAT permission it requires.
6. Do **not** add it to any agent's policy in the same PR unless the task says so.
7. `pnpm typecheck && pnpm test`.
