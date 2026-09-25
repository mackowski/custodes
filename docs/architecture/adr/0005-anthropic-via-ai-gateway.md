# 0005. Anthropic models through Cloudflare AI Gateway (BYOK)

- Status: accepted
- Date: 2026-09-25
- Deciders: Jakub Maćkowski

## Context

Agents need strong reasoning models with central logging, cost control and content safety, and
the Anthropic API key must not live in agent code.

## Decision

We will call Anthropic's Messages API only through an authenticated Cloudflare AI Gateway with the
provider key stored in the gateway (BYOK). Workers send the gateway token and per-request metadata
(agent id, run id). Guardrails/DLP, rate and spend limits are configured on the gateway. Model ids
live in `packages/llm/src/models.ts`.

## Alternatives considered

- Direct Anthropic calls: simpler, but the key would be a Worker secret and there is no central log.
- Workers AI models: cheaper for classification; may be added behind the same `llm` package later.

## Consequences

One place to see every prompt and response, to cap spend, and to rotate the provider key.

## Security considerations

Gateway logs contain prompts, which contain untrusted third-party content; log retention is bounded
and access to the gateway dashboard is limited to operators.
