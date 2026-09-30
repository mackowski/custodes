# triage

- Version: 0.1.0 · Mode: **readonly** · Repository: OWASP/CheatSheetSeries
- Class: `workers/agents/src/agents/triage.ts` · Logic: `workers/agents/src/agents/triage/`
- Policy: no `agents` entry (read-only agents may request no side effects, and the broker denies
  `readonly` agents even if one is added). A `reads` entry allows GET-only reads of this repository.

## Purpose

Help maintainers keep up with issues without the agent ever acting on GitHub. Every four hours it
reads open issues updated since its last run, and for each one suggests labels (from the repo's real
label set), the cheat sheet affected (from the real file list), possible duplicates (from recent
open issues), the kind of issue, and whether a maintainer should look soon. Once a day it e-mails
the suggestions to the operator.

## Inputs (all untrusted)

Public repository data read through the broker's GET-only `/v1/read` endpoint (issues, labels, the
`cheatsheets/` listing). The agent holds no GitHub credential; the broker uses `PAT_READONLY`, a
fine-grained token limited to public repositories with no permissions, and builds every URL itself.
Issue text and recent titles are wrapped with `untrusted()`.

## Outputs

- Daily e-mail to `OPERATOR_EMAIL` (a verified Email Routing destination) at 07:00 UTC, only when
  there is something to report.
- Status and the last 20 assessments at `/agents/triage-agent/owasp-cheatsheetseries` through the
  Access-protected gateway.
- Nothing on GitHub, ever.

## Schedule

Worker cron triggers in `workers/agents/wrangler.jsonc`: poll `17 */4 * * *`, digest `0 7 * * *`.
At most 15 issues are assessed per run; a capped run resumes from the last issue reached.

## Model

`claude-sonnet-5` through the AI Gateway `custodes` with the stored (BYOK) key and no Unified Billing fallback.
`max_tokens` 700, thinking disabled (a short classification must not spend its budget thinking), and
**no sampling parameters**: `temperature`, `top_p` and `top_k` are rejected with HTTP 400 by current
models. The request is built in one place (`triage/model.ts`) and a smoke test sends exactly that
request before every deploy.

## Failure modes

| Failure                                                     | Effect                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GitHub rate limit (5,000 requests/h with the read-only PAT) | run fails, error listed in next digest, cursor unchanged                                    |
| Model returns invalid or off-schema JSON                    | issue skipped, `#<n>: StructuredOutputError` in digest, retried when the issue next changes |
| AI Gateway missing provider key or token                    | whole run fails, reported in digest                                                         |
| E-mail destination not verified                             | digest not sent, assessments kept for the next attempt                                      |
| Kill switch set                                             | runs return immediately; checked again before every model call                              |

## How to halt

Set KV key `halt:triage` (or `halt:*`), see `docs/runbooks/kill-switch.md`.

## Threat model

**Assets:** operator attention and trust in the digest; model spend; the project's reputation if a
suggestion were ever acted on blindly.

| Threat                                          | Control                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection in an issue steers suggestions | `untrusted()` envelope with break-out neutralisation; structured output; every label, cheat sheet and duplicate is checked against real repo data and dropped otherwise (`validateAssessment`); `injectionDetected` flag surfaces attempts in the digest; injection evals |
| Injection turns the agent into a GitHub actor   | impossible by construction: the agent has no token and reads only through the broker's GET-only, allow-listed `/v1/read`; the read PAT has no permissions; `readonly` mode refused by `CustodesAgent.act()` and by the broker policy                                      |
| Phishing links in the digest                    | model summary has links stripped; issue URLs are rebuilt from the issue number; titles are control-character stripped and clipped                                                                                                                                         |
| Exfiltration of secrets through the model       | the agent's prompt contains no secrets; errors never include model output or issue text                                                                                                                                                                                   |
| Spam or flood of issues inflating cost          | 15 issues per run, 700 output tokens, AI Gateway rate and spend limits                                                                                                                                                                                                    |
| Operator acts on a wrong suggestion             | digest states suggestions are model-generated and untrusted; confidence shown; dropped suggestions listed                                                                                                                                                                 |

**Accepted risks:** label and cheat-sheet names are shown to the model outside the untrusted envelope (reduced to a safe charset, and only names that pass it unchanged are used); a maintainer could plant an instruction-like label name. A leaked `PAT_READONLY` exposes only what is already public. Owner: operator.
