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
  Disabling traces in the dashboard is the emergency stop.
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
  once and keeps it to operators.
- Secrets: credentials travel in headers, never in the serialized bodies we record. Unit tests set
  canary values for every credential and assert that no span attribute contains them, with
  payloads on. The runtime's automatic `fetch` spans (AI Gateway, OpenRouter, broker) are outside
  our code: the first sandbox trace is checked for `authorization`, `cf-aig-authorization` and
  `x-api-key` before this ADR's claim is relied on, and the result is added here.
- Prompt injection: payloads read back through the Cloudflare MCP server in a Claude Code session
  (CLAUDE.md invariant 6) are untrusted data, never instructions, like AI Gateway logs. CLAUDE.md
  says so; a hook that marks these MCP results as untrusted is a follow-up.
- Authority and audit are unchanged: tracing adds no binding or credential, and the broker audit
  log in D1 stays the record of side effects. Traces are a debugging aid, not an audit trail.
