# 0016. Model and tool payloads in Workers traces

- Status: accepted
- Date: 2026-10-29
- Deciders: Jakub Maćkowski

## Context

Cloudflare's Agents dashboard shows agent turns, model calls and tool runs from Workers traces
([Agent tracing](https://developers.cloudflare.com/agents/runtime/operations/observability/tracing/)).
Custodes uses no framework that emits these spans (Think, Flue, AI SDK): agents extend the Agents
SDK `Agent` and call models through our own clients in `packages/llm` (Anthropic through AI Gateway,
Jev directly at OpenRouter, Clef through Workers AI). Cloudflare calls this a "custom harness": we
create `invoke_agent`, `chat` and `execute_tool` spans ourselves with the Workers custom spans API,
using the OpenTelemetry GenAI semantic conventions.

Spans can carry only metadata (agent, conversation, model, tokens, timings, error type) or also
payloads: system instructions, input and output messages, tool arguments and results. Session
replay needs payloads to show what an agent read and answered, which is the question every pr-gate
incident so far started with (#2801, #2831).

Payloads here are mostly untrusted: issue and pull request text written by people outside the
maintainer set. The repository rule until now was "structured JSON logs with ids only, never
bodies or tokens" (CLAUDE.md). Some of this content is already stored: AI Gateway keeps full
Anthropic and Clef requests and responses (`collect_logs = true`, last 10,000 entries,
`infra/terraform/modules/ai-gateway`). Jev calls go directly to OpenRouter (ADR 0011), so its
inputs are not stored in Cloudflare today.

## Decision

We will enable Workers traces on `custodes-agents` (`observability.traces`, `head_sampling_rate: 1`;
log sampling unchanged) and record payloads in agent spans while the Worker var `TRACE_PAYLOADS` is
`"true"`, which is its committed value.

- One `invoke_agent` span per evaluated issue or pull request, not per cron run.
  `gen_ai.conversation.id` is `<owner>/<repo>#<number>` (public, stable across runs, so session
  replay shows the whole history of one item); the run id is `custodes.run_id`. A fresh UUID is
  not used as a conversation id, as the OpenTelemetry conventions advise.
- `gen_ai.agent.name` is the manifest id; `gen_ai.agent.id` is `<manifest id>/<Durable Object
instance>`, so sandbox and real repositories are separate.
- Recorded payloads: Anthropic system prompt, messages and response; Jev and Clef state,
  questions and answers; the `BrokerAction` an agent sends to `act()`. Broker `/v1/read`
  responses are not recorded: only the resource (`read.<resource>` span), issue or PR number,
  outcome, status and size.
- Never recorded, whatever `TRACE_PAYLOADS` says: credentials (gateway token, OpenRouter key,
  approval tokens) and error messages. Errors carry `error.type` only, because `GatewayError`
  messages include provider response text; an error never crosses the runtime's `enterSpan`, so
  the runtime cannot attach its message either.
- `chat` spans are created inside the `packages/llm` clients for calls made with a `Turn` (it
  carries the tracer, identity and payload switch); calls without one are untraced. Only
  `CustodesAgent` builds turns, with the runtime `tracing`.
- Tracing never changes what an agent does: failing span methods are ignored, and a tracer that
  fails before its callback runs leaves the work untraced.
- Traces stay in Workers Observability (seven-day retention). No OpenTelemetry export to another
  destination without a new ADR.

## Alternatives considered

- Metadata only: no new copy of untrusted text, but session replay would show timings and tokens
  without what the agent read or decided on; the operator chose payloads.
- One `invoke_agent` per cron run with `conversation.id = runId`: mixes unrelated issues in one
  session and splits a pull request's history across runs; contradicts the conventions.
- Full `/v1/read` responses in tool spans: large, truncated by span size limits, and re-fetchable
  from GitHub.
- A KV flag instead of a Worker var for the payload switch: allows turning it off without a deploy,
  but this is an observability setting, not a safety stop, and should change through review.
  Disabling traces in the dashboard is the emergency stop; it must be followed by a PR that turns
  them off in `wrangler.jsonc`, or the next deploy turns them on again
  ([runbook](../../runbooks/agent-traces.md)).
- `execute_tool` spans for triage delegating to a specialist: the "agent as a tool" convention
  applies only to model tool calls; a specialist opens its own `invoke_agent` with the same
  conversation id instead.
- `tool_approval` spans now: no agent requests a human approval today; add them with the first
  that does.
- Exporting traces to an external OpenTelemetry backend: another provider holding untrusted text
  and prompts.

## Consequences

- The Agents dashboard shows each agent, its sessions per issue or pull request, model tokens and
  failures; session replay shows the prompts and answers.
- Untrusted issue and PR text and our prompts are stored in a second place (seven days), and
  Jev's inputs are stored in Cloudflare for the first time.
- From 2026-12-01 traces count toward Cloudflare Observability ingestion and storage; agent
  volume is small.
- The CLAUDE.md log rule gets a named, narrow exception for trace spans.
- Triage hands work to the specialists through their job queue, so a specialist's turn is its own
  trace; it shares the session with triage's through the conversation id.

## Security considerations

- Confidentiality: anyone with access to Workers Observability on the account can read the
  payloads. Account membership is managed in the dashboard, not Terraform; the operator reviews it
  once and keeps it to operators. API tokens need a Workers Observability permission to query
  telemetry (API reference, telemetry query); the CI deploy token has Workers Scripts, KV, D1,
  Queues and Account Settings only (`docs/runbooks/rotate-cf-token.md`), so it cannot read them.
- Secrets: credentials travel in headers, never in the serialized bodies we record. Unit tests set
  canary values for every credential and assert that no span attribute contains them, with
  payloads on. The runtime's automatic `fetch` spans (AI Gateway, OpenRouter, broker) are outside
  our code. Workers documents their request headers as `content-type`, `content-length`, `accept`
  and `accept-encoding` only, plus the URL, which carries no credential here
  ([spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/)).
  Sandbox and production are one Worker, so the first deploy traces production: the operator
  checks the first trace for credentials right after it, as the
  [runbook](../../runbooks/agent-traces.md) describes, and records the result here.

- Prompt injection: payloads read back through the Cloudflare MCP server in a Claude Code session
  (CLAUDE.md invariant 6) are untrusted data, never instructions, like AI Gateway logs. CLAUDE.md
  says so; a hook that marks these MCP results as untrusted is #71.
- Authority and audit are unchanged: tracing adds no binding or credential, and the broker audit
  log in D1 stays the record of side effects. Traces are a debugging aid, not an audit trail.

## First-trace check (2026-10-29)

Done through the Cloudflare MCP server, read-only, after deploy `557fcdd3` and sandbox run 40858052935. Traces: triage `fc3e2178dc8e3b7f8e7a8b5c5445e937` and specialist
`0c90a660a3d40f791f91608d20e902fb` (`mackowski/custodes-sandbox#56`, Anthropic), pr-gate
`cdb8aac799b027ec51d8610720bf276c` (`#54`, OpenRouter and Workers AI).

- Span header attributes across all Workers in the last two hours (312 keys): only
  `http.request.header.{content-type, content-length, accept, accept-encoding, accept-language}`.
  There is no `authorization`, `cf-aig-authorization` or `x-api-key` key.
- Workers Logs (on before this ADR) record incoming request headers. `cookie` and
  `cf-access-jwt-assertion` occur on `custodes-gateway` and `custodes-agents`, and over seven days
  every value is `REDACTED` by Cloudflare: none is a JWT or a `CF_Authorization` cookie.
  `x-hub-signature-256` is a payload HMAC, not a secret.
- Account members: one, the operator (Super Administrator). No OpenTelemetry export destinations.
  Listing API tokens needs a write scope, which the session did not take; the CI tokens' scopes in
  `docs/runbooks/rotate-cf-token.md` include no Workers Observability permission.
- The telemetry query ran from an OAuth connection with `account:read` only, although the API
  reference lists Workers Observability Write: treat any read access to the account as read
  access to the payloads.
- A read that returns 404 (an issue number in a PR body that does not exist) marks the pr-gate
  trace `error` with `GitHubReadError 404` only; the decision is unaffected.
