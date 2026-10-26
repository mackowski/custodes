# 0015. Clef as a shadow decision model next to Jev, and all agent AI traffic through one AI Gateway

- Status: accepted
- Date: 2026-10-26
- Deciders: Jakub Maćkowski

## Context

pr-gate asks Jev (ADR 0011, ADR 0013) two typed questions: is a small diff a minor fix, and did a
maintainer agree to the change. Jev's answers can close a contributor's pull request, and the
operator has no second opinion on how good they are beyond the eval suites and the daily e-mail.

Cloudflare released **Clef** (`@cf/cloudflare/clef`, blog post "Clef decision models"), a decision
model on Workers AI with Jev's API: the same `state` and `questions`, the same `noul`, `choice` and
`score` types, and answers with probabilities. Its output schema matches Jev's answer types, only
without the response `id`. It costs $0.24 per million input tokens (Jev: $0.04), with free output,
and has a 64k-token context window. Cloudflare reports it better than Jev on 3 of 4 TypeSafe
workflows and faster (median 209 ms against 524 ms). The model id has no version.

Jev is the only model call that does not go through AI Gateway: the gateway answers 404 for
OpenRouter's Decisions API. A new probe on 2026-10-26 (Diagnose run 40349299889) still got 404 on
all four paths, while the direct call worked. The operator wants every model call from the agents
to go through one gateway.

## Decision

**Shadow only.** pr-gate asks Clef the same `MINOR_QUESTIONS` and `APPROVAL_QUESTIONS`, with the
same enveloped `JevState`, at the same time as Jev (`Promise.allSettled` semantics in
`pr-gate/shadow.ts`). Only Jev's answer reaches the decision ladder; Jev's errors are thrown
exactly as before. Clef has a 10-second timeout and a budget of 60 seconds per poll (it is not asked
again in a poll after any error), so a hanging Clef cannot stretch a poll towards the 15-minute
poll lock, and a failing one cannot use up the gateway rate limit that triage's Claude calls share. It sits behind the same `guard()`, and its failures are only recorded; storing a
comparison cannot interrupt a poll. Clef is asked only when Jev is; `clef-flash` is not used.

**Comparison table.** Each pair of answers is a row in `model_comparisons` in pr-gate's Durable
Object SQLite: PR number, head SHA, SHA-256 of the state, question, then per model the model name
from the response, the yes/no probability, the chosen option, latency, input tokens and error
class, then pr-gate's outcome and a `human_verdict`. No PR text and no model text. Rows are kept
180 days.

**Ground truth.** `human_verdict` comes from GitHub, read through the broker at the daily summary:
`merged`, `closed_unmerged` (closed without merge by someone other than pr-gate; GitHub's list does
not say who, so it may be the author) or `reopened` (a PR pr-gate closed was reopened). pr-gate's
own closes that stay closed are left open. The operator can record the right answer to one
question with `custodes pr-gate verdict <pr> --question minor|approval --answer yes|no`. Service
tokens cannot: on `/agents/*` the gateway lets them write only to the on-demand `run`, `digest`
and `summary` steps (an allowlist), and the agent checks the `x-custodes-actor-via` header the
gateway sets. The log line names who recorded the verdict.

**Reading.** `custodes pr-gate compare [--since] [--csv]` (GET `…/comparisons` on the agent, behind
Access). The daily e-mail gets one line: how many answers agreed (both on the same side of 0.5 and
the same option), the PRs where they disagreed, and Clef's errors.

**Evals.** Both pr-gate suites run Clef as a second promptfoo provider labelled `shadow:clef`, with
every case including the injection cases. `evals/summarize.ts` reports shadow providers but never
fails on them. The provider calls Workers AI through AI Gateway with `CF_WORKERS_AI_EVAL_TOKEN`, a
CI secret limited to Workers AI (Read and Edit: running a model needs both) on this account.

**One AI Gateway.** Every model call from the agents goes through the `custodes` AI Gateway.
`ClefClient` takes a gateway id and throws on a blank one. Two tests hold the rule:

- `packages/llm`: every `http(s)://` URL in the model adapters (recursively) is
  `gateway.ai.cloudflare.com`, plus `JevClient`'s direct fallback as the single, named exception.
- `workers/agents`: the `AI` binding, which has no URL, is used in one place only, the `ClefClient`
  factory in `pr-gate.ts`. Any other `env.AI` fails the test.

A URL built at run time can still slip past the first test; review is the backstop.
The exception ends when the gateway supports the Decisions API (the Diagnose probe tells) or when
Clef replaces Jev.

**Later, not now.** An "agreement" mode (close only when both models are confident) changes when
contributors are closed. It needs the comparison data, a pinned Clef version, Clef passing the
evals, and its own plan and grill. Its analysis must rest on `merged`, `reopened` and operator
verdicts only: `closed_unmerged` can be produced by an author closing their own PR.

## Alternatives considered

- **A `shadow|agreement` switch from the start:** the decision code for two models would exist
  before any data says how they compare.
- **`clef-flash` as well, or instead:** no published price or context window, and latency does not
  matter for pr-gate (it waits 30 minutes after an edit).
- **Clef through the binding without a gateway:** breaks the one-gateway rule and loses the
  gateway's cost view.
- **A D1 database or Analytics Engine for the comparisons:** a new Terraform resource for a few
  hundred rows a year; Analytics Engine also cannot update a row later with a human verdict. The
  broker's `custodes-audit` D1 belongs to the broker, and agents do not write to it.
- **Eval results in the same table (`source=eval`):** promptfoo runs outside the Worker and cannot
  reach the Durable Object; an upload endpoint would add a write path for nothing. promptfoo's own
  output shows both providers side by side.
- **Clef failures blocking the eval run:** only once Clef can affect a decision.
- **Replacing Jev with Clef now:** no data on our own cases yet, and Jev's bands were tuned on it.

## Consequences

- One more model call per Jev call. At today's volume (an estimated 100 calls a month of about
  5k tokens) Clef adds about $0.12 a month, and the two together cost under $0.15.
- The operator can compare the models on real PRs with a ground truth, and decide on an agreement
  mode or a switch with data.
- pr-gate gets an `AI` binding. Tests run with `remoteBindings: false` and inject a fake binding,
  so no test reaches Workers AI.
- Clef is unversioned upstream: comparisons can mix model versions. Each row stores the model name
  the response gives.
- A new CI secret, `CF_WORKERS_AI_EVAL_TOKEN`. Without it the Clef eval rows fail, report only.

## Security considerations

- Authority does not change: no new broker action, no policy widening, no new GitHub read
  (`pulls` with `state=closed` was already granted). Clef's answer never reaches a decision, so an
  injection that steers Clef changes a row, not a PR.
- The state Clef sees is the same `untrusted()` envelope Jev sees. Clef writes no free text; its
  answers are zod-validated and reduced to a probability and an option id (anything else is stored
  as `other`).
- Workers AI is reached through the Worker's binding: no API key in the agents Worker. The gateway
  logs hold the state, which is public PR content and maintainer comments.
- The eval token can only run Workers AI models and spend Cloudflare credit.
- `human_verdict` from the operator is the only new write path. It goes through Access and is
  refused for service tokens, and it only changes comparison data, never a decision.
