# triage

- Version: 0.3.0 · Mode: **readonly** · Repositories: OWASP/CheatSheetSeries; mackowski/custodes-sandbox for tests (ADR 0012, run on demand only)
- Class: `workers/agents/src/agents/triage.ts` · Logic: `workers/agents/src/agents/triage/`
- Policy: no `agents` entry (read-only agents may request no side effects, and the broker denies
  `readonly` agents even if one is added). A `reads` entry allows GET-only reads of this repository.

## Purpose

Help maintainers decide on new issues without the agent ever acting on GitHub. Every four hours it
reads open issues updated since its last run and keeps the **new** ones: nobody assigned, and
`ACK_WAITING` or no `ACK_*` label at all (the issue templates apply `ACK_WAITING`; an issue that
bypassed them has none). Accepted (`ACK_OBTAINED`) and assigned issues are the backlog, which
backlog-review is meant to take (#132); they cost no model call. For each new issue it suggests labels (from the repo's real
label set), the cheat sheet affected (from the real file list), possible duplicates (from recent
open issues), the kind of issue, and whether a maintainer should look soon. Once a day it e-mails
the suggestions to the operator.

Since 0.2 (ADR 0010) triage hands the pending new issues (not spam) to the read-only
[proposal-review](proposal-review.md) specialist over Durable Object RPC; its results appear in the
same digest under recommended actions. Since 0.3 it no longer routes accepted issues to
[implementation-check](implementation-check.md) (paused until #132). An issue accepted or assigned
after triage saw it leaves the digest (only a count is shown), unless it was flagged as needing a
maintainer or as possible injection.

Each card is ordered for a decision without opening the issue: the recommended actions and the
one-click link (ADR 0019) first, then GitHub facts (author, opened date and age, comment count,
current labels) and the **author's own text**, then the review that supports the recommendation.
The author's text is the answers to the issue template sections (`triage/excerpt.ts`): template
hints in HTML comments are removed, up to 4 sections of 300 characters, or the first 600 characters
of a body without headings. It is stored at assessment time (table `issue_context`), never the full
body, and only after `inertNoLinksWords`: no links, no hidden characters, one line per section.
Polls only read open issues, so before sending, the digest asks the broker which issues were closed
since the oldest pending item and leaves those out, counting them in one line. Any of those that were
flagged for possible prompt injection are still listed by number under problems.

The e-mail has two parts: plain text, and HTML for Gmail on web and mobile (`triage/digest-html.ts`).
The HTML part escapes every issue and model string, uses inline styles only, and links only to
`https://github.com/` URLs that code builds from issue numbers, PR numbers and verified evidence.

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

Worker cron triggers of `custodes-triage` (`workers/triage/wrangler.jsonc`):

- poll `17 */4 * * *`: triage of changed new issues;
- prepare `30 5 * * *`: the same poll, then the pending issues go to proposal-review, so its
  reviews are at most 90 minutes old when the digest goes out;
- digest `0 7 * * *`.

Before sending, the digest re-reads issues changed since their items were seen. It drops closed
issues and issues accepted or assigned since, and removes label changes already carried out.
At most 15 issues are assessed per run; a capped run resumes from the last issue reached.

## Model

`claude-sonnet-5` through the AI Gateway `custodes` with the stored (BYOK) key and no Unified Billing fallback.
`max_tokens` 700, thinking disabled (a short classification must not spend its budget thinking), and
**no sampling parameters**: `temperature`, `top_p` and `top_k` are rejected with HTTP 400 by current
models. The request is built in one place (`triage/model.ts`) and a smoke test sends exactly that
request before every deploy.

## Failure modes

| Failure                                                     | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub rate limit (5,000 requests/h with the read-only PAT) | run fails, error listed in next digest, cursor unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Model output invalid, refused or cut off                    | error in digest; the issue is tried again on the next polls with the cursor held, and skipped after 3 attempts until it changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| AI Gateway, provider or network failure                     | error per issue in the digest; the run stops after 3 in a row and the cursor stays, so nothing is skipped. A refused request (a 4xx other than 408 and 429, for example a guardrail block) counts against that issue when the model path works: another issue was assessed after it in the same run or, when none was (or the run ended on refusals), a fixed harmless probe request got an answer (3 such runs: skipped until it changes). In an outage the probe fails too and nothing counts; when the probe is refused as well the digest says so (an outage, or something every request shares, such as a label or a recent title a guardrail blocks); a 429, a 5xx, a timeout or a network error never counts |
| E-mail destination not verified                             | digest not sent, assessments kept for the next attempt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Kill switch set                                             | runs return immediately; checked again before every model call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## How to halt

Set KV key `halt:triage` (or `halt:*`), see `docs/runbooks/kill-switch.md`.

## Threat model

**Assets:** operator attention and trust in the digest; model spend; the project's reputation if a
suggestion were ever acted on blindly.

| Threat                                                 | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection in an issue steers suggestions        | `untrusted()` envelope with break-out neutralisation; structured output; every label, cheat sheet and duplicate is checked against real repo data and dropped otherwise (`validateAssessment`); `injectionDetected` flag surfaces attempts in the digest; injection evals                                                                                                                                                                                                  |
| Injection turns the agent into a GitHub actor          | impossible by construction: the agent has no token and reads only through the broker's GET-only, allow-listed `/v1/read`; the read PAT has no permissions; `readonly` mode refused by `CustodesAgent.act()` and by the broker policy                                                                                                                                                                                                                                       |
| Phishing links in the digest                           | model summary has links stripped; issue URLs are rebuilt from the issue number; titles are control-character stripped and clipped                                                                                                                                                                                                                                                                                                                                          |
| Author's text in the digest misleads the operator      | shown in its own dashed box under "author's text (untrusted, unchecked, links removed)", never styled like checked evidence; links removed, bare domains and e-mail addresses defanged (`evil[.]example`, `[at]`), hidden characters removed, bounded; HTML-escaped; parsed without regex backtracking on at most 20,000 characters; hidden for likely spam; never sent to a model from the stored excerpt; shown for flagged issues so the operator can judge the attempt |
| Injection added later to an accepted or assigned issue | no longer assessed by triage (not a new issue), so not flagged; accepted loss of detection until backlog-review (#132)                                                                                                                                                                                                                                                                                                                                                     |
| Exfiltration of secrets through the model              | the agent's prompt contains no secrets; errors never include model output or issue text                                                                                                                                                                                                                                                                                                                                                                                    |
| Spam or flood of issues inflating cost                 | 15 issues per run, 700 output tokens, AI Gateway rate and spend limits                                                                                                                                                                                                                                                                                                                                                                                                     |
| Operator acts on a wrong suggestion                    | digest states suggestions are model-generated and untrusted; confidence shown; dropped suggestions listed                                                                                                                                                                                                                                                                                                                                                                  |

**Accepted risks:** label and cheat-sheet names are shown to the model outside the untrusted envelope (reduced to a safe charset, and only names that pass it unchanged are used); a maintainer could plant an instruction-like label name. A leaked `PAT_READONLY` exposes only what is already public. Owner: operator.
