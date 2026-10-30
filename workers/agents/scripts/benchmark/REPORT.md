# cheatsheet-review model benchmark (one-off, 2026-10)

Run by hand with `workers/agents/scripts/benchmark/` (README.md); not part of CI. 30 external pull
requests to OWASP/CheatSheetSeries closed in the last 12 months (10 clean, 12 fixed, 8 closed), each reviewed at the commit of the first maintainer review.
Grader: GPT-6.1 Terra (in no candidate role). Real problems found by maintainers: 40.
Total cost: $14.47 in 355 calls.

## Findings per model and role

"Hits": maintainer-raised problems the model found. "False blockers": BLOCKER findings matching no real problem.

| Source                                   | Runs | Hits | False blockers | Findings | Cost  |
| ---------------------------------------- | ---- | ---- | -------------- | -------- | ----- |
| duplication-checker:museSpark            | 26   | 0    | 0              | 3        | $0.80 |
| judge:astra                              | 18   | 4    | 0              | 31       | $1.52 |
| judge:sol                                | 29   | 6    | 0              | 69       | $0.59 |
| language-reviewer:luna                   | 30   | 2    | 0              | 52       | $0.06 |
| practicality-reviewer:museSpark          | 27   | 2    | 0              | 15       | $0.61 |
| practicality-reviewer:museWonder         | 24   | 3    | 0              | 33       | $1.63 |
| practicality-reviewer:sonnet             | 26   | 13   | 0              | 58       | $1.29 |
| security-reviewer:opus                   | 25   | 6    | 0              | 44       | $3.15 |
| security-second-voice:deepseekFlash      | 2    | 1    | 0              | 2        | $0.03 |
| security-second-voice:deepseekFlash-high | 27   | 7    | 0              | 58       | $0.37 |
| security-second-voice:deepseekFlash-low  | 27   | 7    | 0              | 44       | $0.31 |
| security-second-voice:deepseekPro-high   | 27   | 4    | 0              | 12       | $0.66 |
| security-second-voice:deepseekPro-low    | 27   | 4    | 0              | 19       | $0.73 |
| security-second-voice:museWonder         | 26   | 6    | 4              | 41       | $2.20 |

Muse Wonder as a third security voice found 0 problem(s) neither Opus nor DeepSeek V4 Pro found.

## DeepSeek on Workers AI (targeted pass, second-voice prompt)

| Variant            | Runs | Answered | Timeouts | Median time | Hits | False blockers | Cost  |
| ------------------ | ---- | -------- | -------- | ----------- | ---- | -------------- | ----- |
| deepseekPro-low    | 27   | 23       | 4        | 108 s       | 4    | 0              | $0.73 |
| deepseekPro-high   | 27   | 19       | 8        | 167 s       | 4    | 0              | $0.66 |
| deepseekFlash-low  | 27   | 24       | 0        | 60 s        | 7    | 0              | $0.31 |
| deepseekFlash-high | 27   | 25       | 0        | 83 s        | 7    | 0              | $0.37 |

## Verdicts

Expected: clean → MERGE, fixed → REQUEST_CHANGES, closed → CLOSE. Lenient: anything but MERGE counts for fixed and closed.

| Decider     | Strict | Lenient | PRs |
| ----------- | ------ | ------- | --- |
| judge:sol   | 62%    | 86%     | 29  |
| judge:astra | 72%    | 83%     | 18  |
| sum rule    | 33%    | 37%     | 30  |

## Decisions against the thresholds set before the run

| Question                            | Threshold                                             | Result                                                                                                 |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Judge → Astra                       | ≥10 pp lenient agreement or ≥30% fewer false blockers | inconclusive: Astra answered 18 of 30 (OpenRouter 402 on the rest) (83% vs 86%; false blockers 0 vs 0) |
| Muse Wonder as third security voice | ≥3 unique hits and ≤2 false blockers                  | do not add (0 unique, 4 false blockers)                                                                |
| Second voice → DeepSeek V4.1 Flash  | hits ≥ V4 Pro −1 and no more false blockers           | **switch to Flash** (7 vs 4 hits; 0 vs 0 false blockers)                                               |
| Practicality                        | most hits, then cheapest                              | **practicality-reviewer:sonnet**                                                                       |

Results within 1 of a threshold get a second run before the lineup changes (grill-plan Q8).

## Grader check and known limits

- **Grader spot check.** For one model per pull request, a second reader compared the grader's
  "found / not found" against the maintainer's comment on 10 pull requests: 9 agreed, 1 did not. The
  grader is trusted for comparing models, not as an exact recall figure.
- **Hint leakage.** Pull request bodies were fetched as they are today, not as they were at the
  first maintainer review; some were edited after that review (#2498). Recall is slightly inflated
  for every model alike, so the comparison between models holds.
- **Not measured.** The link auditor (linked pages have changed since), the duplication checker
  (needs repository-wide retrieval), noise and precision of non-blocking findings, the light path
  and scope classifier, fallbacks, prompt variants, and the new lineup run together.
- **Small sample.** 30 pull requests, 40 maintainer-raised problems; differences of one or two hits
  are noise. The judge choice (Astra over Sol, 14/17 against 13/17) is the operator's preference
  within that noise.
