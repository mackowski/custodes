# Custodes question bank

Each area lists the decisions plans here most often leave open, and the facts to look up yourself
before asking. Ask only what applies to the plan in front of you.

## Authority

- Which GitHub side effects does it need, and which broker actions express them? Is a new action
  needed (`/new-tool`)?
- Does `workers/github-broker/policy/policy.json` widen: new action, repository, resource, or a
  higher rate? Widening needs a linked ADR or issue (CLAUDE.md invariant 4).
- `hitl` or `hotl`? New agents start `hitl` until their evals pass. What would have to be true to
  move to `hotl`?
- What is the worst single action it could take on a real repository, and who would notice?
- Which GitHub identity acts on the upstream repository, and what else can that token do? Prefer
  the narrowest role that works (Triage can close and label but not push) and one PAT per agent
  (ADR 0003).

Look up: the agent's entry in `policy.json`, `workers/agents/src/registry.ts`, the broker's
action schema in `packages/schema`.

## Untrusted input

- Which inputs are written by people outside the maintainer set (issue and PR bodies, comments,
  diffs, file names, branch names, e-mail, webhook fields)? Each one reaches a prompt only through
  `untrusted()`.
- Where is model output parsed (`parseStructured()`), and what happens when it does not parse?
- Could an author steer the decision in their own favour (claim a maintainer agreed, link a
  thread that looks like agreement, name a file to look important)? Which signal is GitHub-set
  and which is author-controlled?
- Which new prompt-injection cases does this need in `evals/`?

Look up: `packages/llm/src/untrusted.ts`, `packages/llm/src/structured.ts`, the agent's prompt
module.

## Failure and kill switch

- What happens when the model, the broker, the GitHub API or AI Gateway fails or times out: skip,
  retry, flag for a maintainer, or act anyway? Prefer flag over act.
- Can the action half-complete (commented but not closed)? Is retrying it safe?
- Does every side effect sit behind `await this.guard()`? What does the kill switch stop?

Look up: `packages/core/src/killswitch.ts`, `docs/runbooks/kill-switch.md`, how existing agents
handle `GatewayError`.

## Model and cost

- Which tier decides: deterministic rules, Jev (cheap yes/no), or a frontier model? Can a rule
  settle the common case so the model only sees the rest?
- What are the thresholds or bands, and what happens between them?
- How often does it run, and what does that cost per day at today's volume?

Look up: `packages/llm/src/models.ts`, `packages/llm/src/jev.ts`, ADR 0011 for the Jev tier.

## Evals and tests

- Which eval suite covers it (`evals/agents/*`)? Which new cases, including injection cases, prove
  the decision? Injection cases are only ever added, never removed.
- What do the unit tests inject (`now`, keys, `fetchImpl`) so they stay deterministic?

## Rollout

- Does it start on the sandbox repository (ADR 0007, ADR 0012) before a real one?
- How is it turned off without a deploy, and how are its actions undone (reopen, remove a label)?
- Does a maintainer need to be told before it acts on their repository?
- For anything a contributor would feel (closing, rejecting): act at once, or warn first and act
  only if nobody answers within a grace period? A warning costs a delay; a wrong close costs trust
  in public (#2831).
- Is the rule backed by the project's own contributing guide? If the guide allows what the rule
  punishes, the public comment will contradict it.

## Observability and audit

- Which ids are logged (never bodies or tokens), and what lands in the broker audit log?
- Where does a maintainer see what it did and why: the daily summary, a comment trailer, the CLI?

## Data and secrets

- Does it need a new secret or binding? Secrets come from CI or `scripts/with-secrets.sh`, never
  from a file, and agents never hold GitHub or e-mail credentials (invariant 1).
- What does it store, for how long, and does any of it come from untrusted input?
