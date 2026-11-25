# 0023. Agent runtime: agent.md, proposals, loop caps, run tree and run-scoped kill

- Status: accepted (2026-11-25)
- Date: 2026-11-25
- Deciders: Jakub Maćkowski

## Context

Today's agents are workflows with one model step: `untrusted()` → model → `parseStructured()` →
`act()`. The next agents (#131) are model-driven loops over read tools. The first is backlog-review
(#132), which reviews every open OWASP issue and pull request. Later ones are self-improvement
(#133b) and issue-implementer (#134), and the supervisor (#135) watches them. Issue #140 asks for
the runtime they share. Its decisions came from a joint `/grill-plan` with #143 on 2026-11-25
(posted on #140 and #143).

What exists and constrains the design:

- `CustodesAgent` (`packages/core/src/agent.ts`) gives every agent `guard()`, `act()`,
  `requestApproval()` and `requestBundleApproval()`. `guard()` reads the kill-switch state from
  the broker (`/v1/state`). Agents do not bind the KV namespace, because a KV binding can also
  write and an agent could clear its own halt flag (#103). It is called before side effects, not
  between model calls.
- `KillSwitch` (`packages/core/src/killswitch.ts`) has a per-agent flag and a fleet flag, both in
  KV, which is eventually consistent.
- Reads go through the broker's `/v1/read` for resources in `ReadResource`
  (`packages/schema/src/read.ts`), granted per agent under `reads` in `policy.json`. There is no
  search resource.
- ADR 0018: one Worker, one key and one broker entrypoint per agent with write authority.
- ADR 0016: model and tool payloads may appear only in trace spans set by `@custodes/core`
  tracing, capped at 8,000 characters per attribute. Traces are write-only for us, kept seven
  days, and do not record `/v1/read` responses.
- ADR 0021: every agent that runs a model loop needs round and budget caps, checks on tool calls
  and `untrusted()` on tool results, at every tier. `tier` in the agent definition is checked
  against policy.
- ADR 0022: an agent's declared `tier` equals the highest tier of its granted actions, and
  `boundary.json` caps what the policy may grant.

## Decision

We will build an agent runtime: the loop in `packages/llm` (it applies `untrusted()` and
`parseStructured()`, which live there, and `llm` already depends on `core`) and the dispatcher, which
makes the policy decisions, in `packages/core`. Agents are declared in `agent.md` files, run as
bounded model loops over read tools, and end each run with one typed proposal. Deterministic code,
not the model, routes that proposal to a side effect.

**Agent definition.** Each agent or role is an `agent.md` file. The frontmatter is JSON (valid
YAML, so no YAML parser is added) and has `id`, `tier`,
`triggers`, `model`, `tools` (a subset of the agent's read policy plus runtime tools), `agents`
(roles it may delegate to), `context` (SOP files bundled with it), `outputSchema` (the name of a
zod schema in `packages/schema`, because zod cannot be written in Markdown) and `budget`. The body
is the system prompt. Files are bundled at build time and never loaded from KV or the network. The
frontmatter cannot widen anything: the broker decides. CI checks that `tier` matches the tier
derived from policy (ADR 0022), that every tool is in the agent's read policy, and that the named
schema exists.

**Tools.** The loop gets read tools only: the existing `ReadResource` reads, a new broker read
`cheatsheet_search` over GitHub code search, and the runtime tool `delegate`. A run ends with a model answer that calls no tool; that answer is
the proposal. The
runtime, not the agent author, wraps every tool result in `untrusted()` and parses the final
output with `parseStructured()`. `cheatsheet_search` widens the read policy and `boundary.json`,
so its policy PR links this ADR (invariant 4). GitHub code search allows 10 requests per minute
and indexes the default branch only. Our own index (D1 FTS or Vectorize) comes only if evals show
the results are weak.

**Proposal and dispatcher.** A run ends with a `Proposal`: target, snapshot, actions, evidence
and reason. A dispatcher in `core` routes each action by policy: a shadow or T0 agent's actions go
to the digest, an action that needs approval goes to an approval bundle (#143), and a HOTL action
goes to `act()`. The model may raise an action to HITL (`needsHuman`), never lower one. An action
passes the dispatcher only if:

1. its target was read by a tool in this run, and the snapshot comes from that read;
2. the evidence its action kind requires is re-verified by code through the broker (for example,
   `issue.close` needs a merged pull request that references the issue in its timeline);
3. the run has made fewer than 10 HOTL writes. Every later action is raised to HITL;
4. a label action names only labels in the agent's allow-list.

Every rule that guards a write is enforced in the dispatcher or the broker, even when the same
rule is also written in a `context` file for the model.

**Rounds and caps.** A round is one model call (request and response, including the tool calls it
asks for). Starting caps, set in `agent.md` and tuned after the first shadow run: 20 rounds per
child run, 40 per orchestrator run, $0.15 per child run, $3 per day for a whole agent tree. Before
every round, the runtime checks the round, token and cost budgets. It also checks for repeated
identical tool calls, undeclared tools and arguments outside the agent's scope.

**Run tree.** An agent may be an orchestrator: a model agent that sees full issue and pull
request content (through `untrusted()`), decides what to do and proposes actions. It never writes
itself; its proposals go through the dispatcher like any other. It may hand an item to a child
with `delegate(role, target)`, for example to keep a large pull request out of its own context.
The tool takes a role and a structured target only: code builds the child's task, the child's
proposal goes from the host straight to the dispatcher, and the parent gets back only action
types, evidence and `needsHuman`, never the child's text.
Children are roles inside the same agent identity: one Worker, key and policy entry (ADR 0018),
listed in the orchestrator's `agents`. Children cannot delegate (depth 1). At most 3 children run
at once (the loop runs tool calls one at a time, so this binds only a host that runs children in
parallel) and at most 60 per orchestrator run. Other deployed agents (cheatsheet-review, pr-gate)
are described in `context` and reached only through broker actions, never by RPC.

**Restart.** When a run hits its round cap, the runtime ends it and starts a fresh run. The fresh
run gets the original trusted task plus a progress state computed by code: the tool calls already
made with their result hashes, or the items already done. The progress state is never a model
summary. Spend carries over: the per-run budget covers the run and its restarts. After at most 2
restarts, the run is escalated to the digest.

**Run-scoped kill.** Run state (`runId`, `parentRunId`, `killed`) lives in the agent's Durable
Object, which is strongly consistent. The runtime checks it before every round and every tool
call. Killing a run kills
its whole tree. The operator kills a run from the CLI through the Access-protected gateway, which
calls the agent's Durable Object; that route is new. Before every round the runtime also calls
`guard()`, so the agent and fleet flags, which stay in KV and are read through the broker, stop a
loop within KV's propagation delay (up to about 60 seconds).

**Event channel.** Each round writes an event to the agent Durable Object's SQLite: tool name,
arguments, result size, model text capped at 8,000 characters, `runId` and `parentRunId`. A
Durable Object alarm deletes events older than 14 days. Only the supervisor (#135) and the
operator's CLI (through Access) can read them, over new RPC and gateway routes. Tool results
themselves are not stored, only their size, as in ADR 0016.

**Model.** backlog-review v1 (#132) uses `claude-sonnet-5-5` through AI Gateway. Its evals compare
it with `deepseekFlash`. The supervisor (#135) is not required below T2 (ADR 0021). Below T2, caps
and monitors limit drift.

**Delivery.** Three draft PRs: this runtime (#140a); backlog-review v1 in shadow on it (#140b,
#132); and #143 in parallel. #143 brings the generic approval bundle the dispatcher's HITL route
uses.

## Alternatives considered

- **Runtime calls `act()` inside the loop:** writes must leave as one validated proposal, after
  the loop, through code that checks it.
- **A deterministic orchestrator (code lists items and fans out):** narrower injection reach, but
  the operator wants an autonomous agent that decides within code-enforced bounds, as in their
  AppSec-LLM-Assistant setup.
- **Orchestrator sees metadata only and children report enums:** limits cross-item injection, but
  the operator chose full content. The dispatcher checks above close the same gap in code.
- **Orchestrator calls other agent Workers by RPC:** hides handoffs from GitHub and the audit, and
  would mix authorities across Workers (ADR 0018).
- **Children as separate agents with their own policy entries:** more Workers and keys for no gain;
  a child never needs more authority than its orchestrator.
- **KV for the run-scoped kill:** eventually consistent; a "stop this run" could arrive many rounds
  late.
- **A model-written progress summary on restart:** it is written from untrusted reads, so an
  injection would survive the restart.
- **Agent definitions loaded from KV at run time:** a KV write would change an agent's prompt and
  tools without review.
- **Our own search index first:** new infrastructure before we know code search is not enough.
- **50 rounds by default (from #140):** nothing in the repository supports that number. The manual
  run in #132 needed a handful to about fifteen reads per item.
- **Events in Workers traces only:** traces are write-only for us, kept seven days and leave out
  read results, so a supervisor cannot read them during a run.

## Consequences

- New agents become an `agent.md`, a schema and a policy entry instead of a pipeline class each.
  Today's workflow agents (pr-gate, cheatsheet-review, triage-apply) are not rewritten.
- Caps and the dispatcher checks are code with tests, so they can satisfy ADR 0021's first
  condition for HOTL. The shadow run gives the agreement data for its third condition.
- The starting budgets may be too low. A run that hits them escalates rather than acting, so a low
  cap costs completeness, not safety.
- The event channel is a second store of model text next to Workers traces. It is bounded (8,000
  characters per event, 14 days) and read only by the supervisor and the operator. This amends the
  ADR 0016 rule that payloads appear only in trace spans.
- `cheatsheet_search` adds a GitHub code search dependency with a low rate limit. The round cap
  keeps a loop below it.
- #140b and #135 build on this. #143 has to land before the dispatcher's HITL route can ask for
  approvals on pull requests.

## Security considerations

- **Authority:** unchanged. The loop has read tools only, and every write still goes through the
  dispatcher and then the broker (policy, kill switch, approval, rate limit, snapshot, audit). An
  `agent.md` cannot grant anything: CI ties its `tier` and `tools` to the policy, and the policy to
  `boundary.json`.
- **Untrusted input:** every tool result reaches the model through `untrusted()`, applied by the
  runtime so an agent author cannot forget it. The final output is parsed with
  `parseStructured()`. A malformed proposal is dropped and escalated, never acted on.
- **Cross-item injection:** the orchestrator reads many items in one context, so text in pull
  request A can try to steer the action on issue B. The dispatcher refuses an action whose target
  was not read in the run, re-verifies the evidence through the broker, and raises every HOTL
  write beyond the tenth to HITL. Within those bounds, an injection can still pick a wrong but
  allowed action. That risk is accepted while new action classes start HITL (ADR 0021).
- **Delegation:** depth 1, roles from a fixed list in a reviewed file, one identity and policy for
  the whole tree. A child cannot reach more than the orchestrator.
- **Restart:** the progress state is computed by code, so an injection does not carry over through
  a model summary.
- **Kill:** the run flag is strongly consistent and checked before every round. The agent and fleet
  flags are checked before every round too, through the broker, which fails closed when the state
  cannot be read.
- **Event channel:** its contents are untrusted data (ADR 0016), never instructions, for the
  supervisor and for a session that reads them. Events store ids, arguments, sizes and capped model
  text, never tokens, error text or tool results. Reads require Access (operator) or the
  supervisor's binding.
- **Evals:** a trajectory suite proves the monitors: loops, budget exhaustion, an undeclared tool,
  out-of-scope arguments, restart. Injection cases cover injection via tool results and
  cross-item injection (pull request A asks to close issue B, add the cheatsheet-review trigger
  label, or ping strangers), and `issue.close` without a merged pull request.

## Update, 2026-11-25 (slice 2)

The model price table that turns tokens into dollars lives in `packages/llm/src/prices.ts`, not
in `models.ts`: changing `models.ts` starts every paid eval suite. A model with no price refuses
to run instead of counting as free.
