# OpenSSF Best Practices badge: answers

Prepared answers for the **passing** level questionnaire at <https://www.bestpractices.dev/>
(sign in with GitHub as `mackowski`, "Add project", repository `https://github.com/mackowski/custodes`).
Each answer is "Met", "Unmet" or "N/A" plus the justification to paste. After the project is
registered, add the badge to `README.md`; Scorecard's `CII-Best-Practices` check then passes.

Base URL for links: `https://github.com/mackowski/custodes/blob/main/`.

## Basics

| Criterion                 | Answer | Justification                                                                                     |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| description_good          | Met    | `README.md` describes what Custodes is and does.                                                  |
| interact                  | Met    | Issues and pull requests on GitHub; `CONTRIBUTING.md`.                                            |
| contribution              | Met    | `CONTRIBUTING.md` explains the process (PRs, checks, conventions).                                |
| contribution_requirements | Met    | `CONTRIBUTING.md` "Quick rules" and "Commit and PR conventions".                                  |
| floss_license             | Met    | Apache-2.0 (`LICENSE`).                                                                           |
| floss_license_osi         | Met    | Apache-2.0 is OSI-approved.                                                                       |
| license_location          | Met    | `LICENSE` in the repository root.                                                                 |
| documentation_basics      | Met    | `README.md`, `docs/` (architecture, ADRs, agent pages, runbooks, `docs/sdlc.md`).                 |
| documentation_interface   | Met    | CLI usage in `apps/cli`; wire formats in `packages/schema` (zod); admin API in `workers/gateway`. |
| sites_https               | Met    | GitHub (HTTPS only); the service runs on `https://custodes.work`.                                 |
| discussion                | Met    | GitHub issues and pull requests (searchable, URL-addressable, no proprietary client).             |
| english                   | Met    | All documentation and code review is in English.                                                  |
| maintained                | Met    | Active development; see commit history.                                                           |

## Change control

| Criterion           | Answer | Justification                                                                                                           |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| repo_public         | Met    | `https://github.com/mackowski/custodes`                                                                                 |
| repo_track          | Met    | Git.                                                                                                                    |
| repo_interim        | Met    | All work is committed and pushed through pull requests, not only releases.                                              |
| repo_distributed    | Met    | Git.                                                                                                                    |
| version_unique      | Met    | Changesets assign semantic versions per package (`.changeset/`); Workers are deployed per commit SHA.                   |
| version_semver      | Met    | Semantic Versioning through Changesets.                                                                                 |
| version_tags        | Met    | Changesets tags releases (`pnpm changeset tag` in `.github/workflows/release.yml`).                                     |
| release_notes       | Met    | Changesets writes `CHANGELOG.md` per package on each release (none published yet); commits follow Conventional Commits. |
| release_notes_vulns | Met    | Security fixes are published as GitHub security advisories and noted in the changelog (`SECURITY.md`).                  |

## Reporting

| Criterion                     | Answer | Justification                                                                                        |
| ----------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| report_process                | Met    | GitHub issues; `CONTRIBUTING.md`.                                                                    |
| report_tracker                | Met    | GitHub issues.                                                                                       |
| report_responses              | Met    | Issues are answered by the maintainer.                                                               |
| enhancement_responses         | Met    | Enhancement requests are answered in issues.                                                         |
| report_archive                | Met    | GitHub issues are public and archived.                                                               |
| vulnerability_report_process  | Met    | `SECURITY.md`: private reporting at `https://github.com/mackowski/custodes/security/advisories/new`. |
| vulnerability_report_private  | Met    | GitHub private vulnerability reporting is enabled.                                                   |
| vulnerability_report_response | Met    | `SECURITY.md`: acknowledgement within 3 business days, assessment within 10.                         |

## Quality

| Criterion                   | Answer | Justification                                                                                                   |
| --------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| build                       | Met    | `pnpm install && pnpm check`; `pnpm build`.                                                                     |
| build_common_tools          | Met    | pnpm, TypeScript, wrangler, esbuild, tsup.                                                                      |
| build_floss_tools           | Met    | All build tools are open source.                                                                                |
| test                        | Met    | vitest suites in every package and Worker; promptfoo evals in `evals/`.                                         |
| test_invocation             | Met    | `pnpm test` (part of `pnpm check`).                                                                             |
| test_most                   | Met    | Policy evaluation, broker, sanitizers, parsers, agents and digests are covered, including property-based tests. |
| test_continuous_integration | Met    | `.github/workflows/ci.yml` on every PR and push; required by the `main` ruleset.                                |
| test_policy                 | Met    | `CONTRIBUTING.md` rule 7: every change in behaviour comes with tests.                                           |
| tests_are_added             | Met    | Recent changes add tests alongside code (see `workers/agents/test/`, `packages/*/test/`).                       |
| tests_documented_added      | Met    | `CONTRIBUTING.md` rule 7 and the PR template.                                                                   |
| warnings                    | Met    | TypeScript `strict` with `exactOptionalPropertyTypes`; ESLint (typescript-eslint, type-aware).                  |
| warnings_fixed              | Met    | `eslint . --max-warnings 0` in `pnpm check` and CI.                                                             |
| warnings_strict             | Met    | Strictest TypeScript settings and type-aware lint rules.                                                        |

## Security

| Criterion                      | Answer | Justification                                                                                                |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------ |
| know_secure_design             | Met    | `docs/architecture/threat-model.md`, `docs/architecture/security-controls.md`, ADRs 0002, 0003, 0009, 0010.  |
| know_common_errors             | Met    | The threat model maps OWASP Top 10 for LLM applications; injection evals in `evals/`.                        |
| crypto_published               | Met    | Ed25519 signatures and HMAC-SHA-256 via WebCrypto; no custom algorithms.                                     |
| crypto_call                    | Met    | Uses the platform WebCrypto API; no cryptography is implemented in the project.                              |
| crypto_floss                   | Met    | WebCrypto in workerd/Node, open source.                                                                      |
| crypto_keylength               | Met    | Ed25519 (128-bit security), HMAC-SHA-256 with 256-bit keys.                                                  |
| crypto_working                 | Met    | No broken algorithms (no MD5, SHA-1, DES, RC4).                                                              |
| crypto_weaknesses              | Met    | No algorithms with known serious weaknesses.                                                                 |
| crypto_pfs                     | N/A    | TLS is terminated by Cloudflare and GitHub, not by the project.                                              |
| crypto_password_storage        | N/A    | The project stores no user passwords (Cloudflare Access handles identity).                                   |
| crypto_random                  | Met    | `crypto.getRandomValues` / `crypto.randomUUID` for tokens and ids.                                           |
| delivery_mitm                  | Met    | Code and releases are delivered over HTTPS (GitHub); deploys run in GitHub Actions with pinned action SHAs.  |
| delivery_unsigned              | Met    | No hash is retrieved over HTTP; the lockfile pins integrity hashes.                                          |
| vulnerabilities_fixed_60_days  | Met    | Dependabot, `dependency-review`, Trivy and pnpm overrides; no open vulnerabilities.                          |
| vulnerabilities_critical_fixed | Met    | Critical vulnerabilities are fixed as they are reported.                                                     |
| no_leaked_credentials          | Met    | No secrets in the repository (gitleaks in CI, secrets from CI or Keychain only, invariant 5 in `CLAUDE.md`). |

## Analysis

| Criterion                              | Answer | Justification                                                                                                  |
| -------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| static_analysis                        | Met    | CodeQL, Semgrep and ESLint on every PR (`.github/workflows/security.yml`, `ci.yml`).                           |
| static_analysis_common_vulnerabilities | Met    | CodeQL `security-extended` queries for JavaScript/TypeScript and Semgrep rules.                                |
| static_analysis_fixed                  | Met    | Code-scanning alerts are fixed (for example the ReDoS findings, fixed 2026-10-01).                             |
| static_analysis_often                  | Met    | On every PR, every push to `main`, and weekly.                                                                 |
| dynamic_analysis                       | Met    | Property-based fuzzing with fast-check (`*/test/properties.test.ts`) and model evals against the real gateway. |
| dynamic_analysis_unsafe                | N/A    | TypeScript is memory-safe.                                                                                     |
| dynamic_analysis_enable_assertions     | Met    | Property tests assert security invariants (no links, no envelope escape, paths within the allow-list).         |
| dynamic_analysis_fixed                 | Met    | Property tests found and fixed sanitizer gaps (2026-10-01).                                                    |
