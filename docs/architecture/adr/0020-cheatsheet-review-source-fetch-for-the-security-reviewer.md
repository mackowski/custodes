# 0020. cheatsheet-review: a bounded source fetch for the security reviewer

- Status: accepted
- Date: 2026-11-19
- Deciders: Jakub Maćkowski (/grill-plan, 2026-11-19)

## Context

Issue #155 compared cheatsheet-review@0.2.0 (B) with the original OWASP command (A) on 28 OWASP
CheatSheetSeries pull requests, graded blind:

- **Score:** A 103.0, B 45.5.
- **Verdicts:** B gets more of them right (22 of 23 in round 2, against 20 of 22 for A).
- **Findings:** A wins. It reads full RFCs, specs and vendor pages, and finds problems the diff alone
  does not show: a citation to the wrong section, a control that does not stop the attack the sheet
  implies, a stricter rule in the primary source.

In B, only the link auditor and the claim verifier read sources (ADR 0017). Both are cheap models,
and they read an excerpt of the links the pull request itself cites. The security reviewer (Opus)
sees the diff and the full sheet, never a source.

`packages/llm` has no tool use in any transport (Anthropic, OpenAI, OpenRouter, Workers AI).

## Decision

We will give the `security-reviewer` role a **bounded, two-pass source fetch**.

1. **Pass 1** runs as today. `ReviewerReport` gains an optional `sourceRequests` field: at most 4
   entries of `{ url, why }`.
2. **Code fetches** each requested URL with the existing `fetchLink`/`fetchSource` and `fetchable()`
   guard. The guard allows https only and a public DNS name, never `custodes.work`, at most 5
   redirects with each hop re-checked, a 10 s timeout and a 2 MB body. PDFs go through
   `toMarkdown`. On top of that, a requested URL with userinfo or a non-default port is refused (redirects are checked by `fetchable` only, as for every other fetch). **Any public
   host is allowed**; there is no allowlist (operator decision). The excerpt starts at the element
   the `#fragment` names when the page has it, and is cut at 12,000 characters.
3. **Pass 2** goes to the model that answered pass 1, with no fallback chain of its own. It gets
   its pass-1 report and the pages, each wrapped in `untrusted('source:<host>')`, and returns a
   `ReviewerReport` of **additional** findings only, each with a `claim` that can point at a
   fetched page. Code merges the two passes: every pass-1 finding stays, and the stronger verdict
   wins (`mergePasses`). A fetched page can add a finding but never remove or weaken one (threat
   model, 2026-11-19).
4. The **claim verifier** accepts the pages the tool fetched as sources, next to the links in the
   pull request. It reuses the fetched text and does not fetch them again.
5. **Failures** never block the review. If pass 1 was unavailable, nothing is fetched. If a fetch
   fails, that page is reported to pass 2 as "could not be read". If pass 2 fails, the pass-1
   report stands and the outcome records why.

`security-second-voice` and every other role stay as they are. There is one round of requests:
pass 2 cannot ask for more.

## Alternatives considered

- **Feed every source the pull request cites to the reviewers.** It needs no new fetch, but it
  costs more tokens on every review and still never reaches the primary sources the sheet does not
  cite. That is where A found most of its extra points.
- **A host allowlist** (RFC Editor, IETF, NIST, W3C, WHATWG, MDN, OWASP, large vendor docs). This
  is narrower, but the operator ruled it out: the sources vary (Django, Docker, nginx and Kubernetes
  docs, CVE pages). The SSRF guard is `fetchable()`, and the reviewer only ever sees public data.
- **Native tool use with a free agent loop.** No transport supports it today, it is costly, and
  latency and cost have no bound.
- **One strong agent replacing the multi-model pipeline**, like the original command. That would
  give up B's better verdicts, its injection layering (ADR 0017) and the second voice. The
  question stays open in #155.
- **The tool for `security-second-voice` too.** Ruled out for now, so that the two voices stay
  independent and the effect of the tool can be measured on its own.

## Consequences

- **Pros:**
  - Sourced findings beyond the diff, checked by the claim verifier like any other.
  - Citations to the wrong section can be caught where the reviewer reads the section itself.
- **Cost:** about +0.15–0.30 USD of Anthropic credit and +1–2 minutes per review (one more Opus
  call and up to 4 fetches).
- **New failure modes:** a source page the reviewer reads in part, or misreads. The claim verifier
  and the judge stay between those findings and the review. A pass-2 finding whose claim stays
  unchecked keeps its severity, marked "not confirmed" (NOT-FOUND never weakens a finding, ADR
  0017 amendment 2026-11-19). The operator approves every OWASP review; on the sandbox it posts.
- **Measurement:** the eval suite `cheatsheet-review-sources` and a blind re-run on the A/B pull
  requests measure the effect.

## Security considerations

- **New outbound requests chosen by a model that reads untrusted text.** A pull request can steer
  the reviewer into fetching an attacker's page. Bounds:
  - `fetchable()`: https, public DNS, re-checked redirects. Workers cannot reach private networks
    anyway.
  - At most 4 pages, size and time caps, no userinfo, no non-default port.
- **GET proxy.** A PR can steer up to 4 anonymous GETs per labelled run to a third-party URL,
  including one that acts on GET (an unsubscribe link, a GET webhook). The requests carry no
  credentials and identify the agent. This is accepted (operator, 2026-11-19).
- **Exfiltration.** The reviewer holds no secret: only the public pull request, public sheets and
  its own draft findings. A steered query string could leak a draft review that the operator later
  rejects, or tell the attacker's server that a review ran. This is low value and accepted (operator,
  2026-11-19), which is why query strings are allowed.
- **Injection through fetched pages.**
  - Every page enters pass 2 only through `untrusted()`. Pass 2 can only add findings: code keeps
    every pass-1 finding and the stronger verdict. `parseStructured()` validates the output,
    and `markInjection` records injection attempts.
  - Pass 2 cannot fetch again.
  - Added findings still pass the claim verifier, the judge and post-judge code.
  - On OWASP the operator approves every review before it posts.
  - Eval cases with injected text in a fetched page are added and never removed.
- **No new credentials, bindings or GitHub authority.** Fetches go straight from the agent Worker,
  like the link audit, with no credentials. A model can ask for a public `github.com` or
  `raw.githubusercontent.com` page, as the link audit already fetches links an author cites. These
  are anonymous reads of public web pages, not GitHub API calls through the broker. Invariant 1 is
  about credentials and the broker's `/v1/read`; on 2026-11-23 the operator reworded it to "every
  GitHub API read" to say so.
- **The claim checks stay a safeguard, never a weapon.** Security review, 2026-11-19:
  - A page only the reviewer fetched may confirm any claim, but may refute only a claim on a finding
    that pass 2 added. For an earlier finding, REFUTED becomes NOT-FOUND: the finding cannot be
    removed.
  - Pass 2 findings without a claim, or with a claim on a page pass 2 was not given, are dropped in
    code, so the verifier always stands between a fetched page and the review.
  - Claims on findings that pass 2 added are checked after every other claim. A refuted one is
    neither shown to the judge nor applied to judge items, which could be pass 1's.
  - NOT-FOUND never weakens a finding (#155 follows the original OWASP command), so there is
    nothing to exploit by making a check fail.
  - `fetchable` refuses `api.github.com`, `uploads.github.com` and `*.workers.dev` on every hop of every fetch.
- **Logging and tracing.** Logs and spans carry hosts and statuses. Page text appears only in trace
  spans while `TRACE_PAYLOADS` is `"true"` (ADR 0016).
