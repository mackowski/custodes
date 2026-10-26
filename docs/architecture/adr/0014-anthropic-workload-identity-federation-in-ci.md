# 0014. GitHub Actions authenticate to the Anthropic API with workload identity federation

- Status: accepted
- Date: 2026-10-26
- Deciders: Jakub Maćkowski

## Context

Two workflows call the Anthropic API directly: `claude-review.yml` (through
`anthropics/claude-code-action`) and the Anthropic check in `diagnose.yml`. Both read a static
`ANTHROPIC_API_KEY` repository secret. Console API keys now carry an expiry, and on 2026-10-24
Anthropic warned that the key behind that secret expired the next day. The Admin API can list,
rename and deactivate keys but cannot create them, so rotation cannot be automated: every expiry
is a manual Console step and a secret write.

Anthropic supports workload identity federation (WIF): a workload presents an OIDC token from a
registered issuer and exchanges it at `/v1/oauth/token` for a short-lived access token that acts
as a service account. GitHub Actions issues such tokens, and the pinned `claude-code-action`
already accepts `anthropic_federation_rule_id` and refreshes the identity token itself during
long runs.

The agents Worker reaches Anthropic through AI Gateway with a key stored in the gateway (BYOK,
[ADR 0005](0005-anthropic-via-ai-gateway.md)). Workers have no OIDC identity of their own, so
that key is out of scope here and stays a manually rotated Console key.

## Decision

We will authenticate GitHub Actions to the Anthropic API only through WIF. After this lands, an
operator deletes the `ANTHROPIC_API_KEY` repository secret and deactivates its Console key
(sessions do not write secrets).

In the Console, issuer `github-actions` trusts `https://token.actions.githubusercontent.com`
(single-use `jti`, at most 1 hour token lifetime). Federation rule `github-custodes` matches:

- subject prefix `repo:mackowski@35339942/custodes@1387781101:`. This repository's OIDC `sub` uses
  the immutable owner and repository ids, so a renamed or recreated repository cannot match.
- `repository_owner_id = 35339942` and `repository_id = 1387781101`.
- CEL limiting the event and the workflow file:

  ```
  claims.event_name in ["pull_request", "workflow_dispatch"] &&
  (claims.workflow_ref.startsWith("mackowski/custodes/.github/workflows/claude-review.yml@") ||
   claims.workflow_ref.startsWith("mackowski/custodes/.github/workflows/diagnose.yml@"))
  ```

  Other workflows that hold `id-token: write` (the Scorecard job runs a third-party action on
  `schedule` and `push`) cannot mint an Anthropic token. `pull_request_target`, `workflow_run` and
  `issue_comment` must never be added: they run with base-repository privileges on input a fork
  controls.

- the default Anthropic audience.

It maps to one service account in one workspace, with inference access only (never `org:admin`).
The rule, organization, service account and workspace ids are written in the workflows: they
identify, they do not authenticate, and only a token GitHub mints for this repository can use them.

## Alternatives considered

- **Keep the API key and set a reminder.** Keeps a long-lived credential in GitHub and a manual
  step at every expiry; the 2026-10-25 expiry already broke the review workflow.
- **Scheduled job that rotates the key.** Not possible: the Admin API cannot create keys.
- **Separate rules for `main` and for pull requests.** On `pull_request` GitHub runs the workflow
  file from the PR branch, so anyone who can push a branch can request a token under either rule.
  Against collaborators, two rules would add configuration without narrowing who can mint a token.
  Against third-party actions in other workflows, the `workflow_ref` condition does that instead.
- **WIF for the agents Worker.** Workers have no platform-issued OIDC token. Minting our own JWTs
  would need a signing key in the Worker, which is another long-lived secret.

## Consequences

- Once the secret is deleted, no Anthropic credential is stored in GitHub, and nothing in CI
  expires or needs rotation.
- Each job gets a token that lives about 10 minutes and is scoped to one workspace; revoking
  access means archiving the rule or the service account in the Console.
- Jobs that use WIF need `id-token: write`. Every step in such a job can mint OIDC tokens, so the
  diagnose check runs in its own job with no checkout or dependencies.
- The AI Gateway BYOK key still expires and is rotated by hand in the Console and the Cloudflare
  dashboard.
- Federation configuration lives in the Anthropic Console, outside Terraform; this ADR records it.

## Security considerations

- Anyone with write access to the repository can mint a token through a PR branch workflow, as
  they could already read the secret through one. Users with the triage role can make
  `claude-review` mint one (label, reopen) and spend credits, without controlling the code. Fork
  PRs get no OIDC token, and `claude-review.yml` also skips them.
- Because PR branches can mint tokens, the service account must stay limited to inference.
  Anything that needs `org:admin` gets its own rule restricted to `schedule` on `refs/heads/main`
  and its own service account.
- A leaked access token is useful for about 10 minutes. A leaked GitHub OIDC token expires within
  5 minutes and Anthropic accepts it once (`jti`); a leaked OIDC request token
  (`ACTIONS_ID_TOKEN_REQUEST_TOKEN`) mints new tokens until the job ends.
- The review model has `Read`, and its input includes public issue text. It is denied the runner
  temp directory, where the action keeps the federation tokens, and `/proc`, so an injected
  instruction cannot read a token and post it in a PR comment.
- Every exchange is logged in the Console as `platform_federated_authentication`, with the
  subject, workflow, ref and run id, which is better attribution than a shared key.
