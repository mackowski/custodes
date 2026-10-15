# 0012. Sandbox repository, per-repository instances and on-demand runs

- Status: accepted
- Date: 2026-10-15
- Deciders: Jakub Maćkowski

## Context

ADR 0007 says new agents prove themselves on test repositories the operator owns. Until now there
was none, so pr-gate (ADR 0011) could only be tried against OWASP/CheatSheetSeries. Testing there
does not work well:

- The operator's own pull requests are exempt (maintainer), so a dummy PR proves nothing.
- The loop is slow: a 4-hourly poll, a 1-hour grace period and a 07:00 e-mail.
- Test traffic is visible to every OWASP maintainer.

The operator also asked for offensive tests: prompt injection and output-handling attacks against
every agent, run against the real deployed system rather than only promptfoo.

## Decision

**Sandbox repository.** `mackowski/custodes-sandbox` is a public repository the operator owns. It
holds five cheat sheets, `CONTRIBUTING.md` and the issue and PR templates copied from
OWASP/CheatSheetSeries (CC BY-SA 4.0, attributed), and the same labels. `e2e/sandbox/run.ts seed`
adds two deliberate typos and one planted HTML comment addressed to AI review tools.

**One instance per repository.** `workers/agents/src/instances.ts` maps Durable Object names to
repositories: `owasp-cheatsheetseries` → OWASP/CheatSheetSeries and `custodes-sandbox` → the
sandbox.

- Agents read their repository from the instance name only.
- An unknown instance name answers 404 and creates no state.
- Triage hands work to the specialists of the same instance.
- Crons run only the OWASP instances, so the sandbox costs nothing unless the operator runs it.

**On-demand runs (sandbox only).** These go through the Access-protected gateway:

- `custodes agents run triage --instance custodes-sandbox`, and `--step digest` to send the digest.
- `custodes agents run pr-gate --instance custodes-sandbox`, which skips the 1-hour grace period, and
  `--step summary` to send the summary.
- `custodes agents report pr-gate --instance custodes-sandbox` shows the summary e-mail without
  sending it.

The same requests on the OWASP instance answer 403.

**pr-gate gates maintainers in the sandbox,** so the operator can open scenario pull requests
personally. Bots and dependabot stay exempt everywhere.

**Policy widening** (`workers/github-broker/policy/policy.json`, invariant 4): the sandbox is added
to `repos` of `agents.pr-gate` and of every `reads` entry. No resource or action is added. `hello`
is unchanged.

**Scenarios.** `e2e/sandbox/run.ts` opens issues and pull requests for each rule and attack, runs
the agents and checks the results:

- the GitHub state;
- the signed close comment;
- the agents' operator status;
- the pr-gate e-mail preview;
- that forbidden text never appears in any output.

Each check is graded "must" (security or contract) or "should" (model quality).

## Alternatives considered

- **A second GitHub account to author scenario PRs.** Keeps the maintainer exemption identical, but
  adds an account, a token and friction for every run. The exemption is one rule, and the test
  for it stays in the unit suite.
- **A private sandbox.** The broker reads with `PAT_READONLY`, which only covers public
  repositories. A private one needs a wider token for no benefit.
- **A staging deployment.** ADR 0007 rejected it. Instances give the separation for one map entry.
- **Running scenarios in CI.** Needs an Access service token and a CI-held GitHub token that can
  open PRs. That may come later; operator-run commands come first.

## Consequences

- One command gives a result in about a minute for pr-gate, and a few minutes for triage plus the
  specialists.
- Scenarios double as a regression suite for any agent change.
- A full run costs about $1–2 of Claude.
- pr-gate's broker rate limit (5 per hour) is per agent, not per repository. A sandbox run can use
  the hour's budget that OWASP closes would otherwise have, which shows up as "close refused
  (policy_denied)" and a retry at the next poll.

## Security considerations

- **The sandbox is public:** anyone can open issues or PRs there. The OWASP crons never touch it,
  and on-demand runs need Access, so outsiders cannot spend model budget. A run the operator
  starts can close an outsider's PR in the sandbox, which is the intended behaviour there.
- **Policy scope:** the policy widening adds one repository the operator owns. pr-gate's
  classic PAT already covers it (ADR 0011 amendment), so there is no new credential.
- **Planted text** in the sandbox's cheat sheets is deliberate. It only ever reaches models inside
  `untrusted()` envelopes, and the scenarios check what the agents do with it.
