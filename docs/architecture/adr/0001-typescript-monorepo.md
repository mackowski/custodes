# 0001. TypeScript pnpm monorepo

- Status: accepted
- Date: 2026-09-25
- Deciders: Jakub Maćkowski

## Context

The Cloudflare Agents SDK is TypeScript-only. The CLI, shared schemas and Workers must agree on
wire formats, and one toolchain means one lint/test/scan pipeline to secure.

## Decision

We will use a single pnpm workspace with `packages/*` (libraries), `workers/*` (deployables) and
`apps/*` (CLI). Wire formats are zod schemas in `@custodes/schema` and inferred everywhere.

## Alternatives considered

- Go CLI: a static binary is attractive, but it duplicates types and doubles the supply chain.
- Separate repos per Worker: simpler deploy isolation, but schema drift between broker and agents
  is exactly the failure we want to make impossible.

## Consequences

One `pnpm check` validates everything; workspace packages are consumed from source, so Workers
bundle them with wrangler and the CLI bundles them with tsup.

## Security considerations

Exact version pins, `minimumReleaseAge`, and allow-listed build scripts apply to the whole tree.
