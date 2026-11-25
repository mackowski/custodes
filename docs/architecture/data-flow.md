# Data flow

The current data flow of Custodes, with its trust boundaries and where every credential lives. It is
the reference the `/ship-pr` skill compares a pull request against: every pull request shows the part
of this diagram it touches, before and after, and updates this file when the flow changes
(`docs/sdlc.md`, `.github/workflows/pr-architecture.yml`). Derived from the Workers' `wrangler.jsonc` files, the broker policy and the
gateway routes, not from memory; when they disagree, the code is right and this file is stale.

Last checked against the code: 2026-11-25 (#143, ADR 0024: approval bundles for pull requests,
`issue.close` and `issue.unassign`, the people and comment rules in the broker's `act()` with a
thread read through the agent's read policy, GitHub writes never follow redirects; no new Worker,
binding, edge or secret). Before that, 2026-11-23 (#139, ADR 0022: `policy.json` gains a declared `tier`
per agent and a CI-only ceiling, `boundary.json`; no runtime flow changes). Before that, 2026-11-19 (#155, cheatsheet-review 0.3.0: the public web pages the
agent fetches are drawn, including the sources its security reviewer asks for (ADR 0020); the size
facts no longer read the default branch. Before that, 2026-11-18: tombstones, the `isolated` policy
flag and the cutover workflow removed; triage keeps to new issues; the digest carries the author's
inert text).

## The whole system

```mermaid
flowchart LR
  classDef untrusted fill:#fde2e1,stroke:#c0392b,color:#000
  classDef secret fill:#fff3cd,stroke:#b7791f,color:#000
  classDef store fill:#e8eef7,stroke:#2c5282,color:#000
  classDef noauth fill:#eeeeee,stroke:#777777,color:#000

  subgraph INTERNET["Internet: untrusted"]
    GH["GitHub repos<br/>issues, PRs, comments, labels"]:::untrusted
    OP["Operator<br/>browser or custodes CLI"]
    ANY["Anyone"]:::untrusted
    INMAIL["Inbound e-mail"]:::untrusted
    WEB["Public web pages<br/>linked in PRs, or asked for by<br/>the security reviewer (ADR 0020)"]:::untrusted
  end

  subgraph EDGE["Cloudflare edge"]
    ACCESS{{"Cloudflare Access<br/>JWT, approver list"}}
    ER["Email Routing<br/>catch-all"]
  end

  GW["custodes-gateway<br/>secret: GITHUB_WEBHOOK_SECRET<br/>no KV binding"]:::secret

  subgraph QUEUES["Queues"]
    QPR[("custodes-inbound-pr-gate")]:::store
    QCR[("custodes-inbound-cheatsheet-review")]:::store
  end

  subgraph AGENTS["Agent Workers: one per agent, own Keyholder key (ADR 0018)"]
    TRI["custodes-triage<br/>triage (new issues only), proposal-review,<br/>implementation-check (paused)<br/>crons; secret: AI_GATEWAY_TOKEN"]:::secret
    TAP["custodes-triage-apply<br/>no model, no secret"]
    PRG["custodes-pr-gate<br/>crons and queue<br/>secrets: AI_GATEWAY_TOKEN, OPENROUTER_API_KEY"]:::secret
    CSR["custodes-cheatsheet-review<br/>queue; secret: AI_GATEWAY_TOKEN<br/>Workers AI toMarkdown for PDF sources"]:::secret
  end

  REG["custodes-agents<br/>GET /registry only<br/>no binding, no secret"]:::noauth

  BR["custodes-github-broker<br/>policy, kill switch (only writer), approvals, rate limit,<br/>signature and nonce check, audit, countersign,<br/>verifies the operator's Access token on admin writes<br/>PATs in Secrets Store; Keyring DO"]:::secret
  D1[("D1: audit, approvals, nonces")]:::store
  KV[("KV: kill switch")]:::store
  GHAPI["api.github.com"]

  subgraph MODELS["Model providers"]
    AIG["AI Gateway<br/>BYOK keys stored there"]:::secret
    ANT["Anthropic"]
    ORT["OpenRouter"]
    WAI["Workers AI"]
  end

  OUTMAIL["Email Sending<br/>operators only"]

  GH -- "webhook, HMAC verified" --> GW
  OP -- "/admin, /agents/:class, approval links" --> ACCESS
  ACCESS -- "verified JWT" --> GW
  ANY -- "/verify/:id, read only" --> GW
  GW -- "pull_request events, best effort" --> QPR
  GW -- "labeled events, must succeed" --> QCR
  QPR --> PRG
  QCR --> CSR
  GW -- "/agents/:class after Access" --> TRI
  GW -- "/agents/:class after Access" --> PRG
  GW -- "/agents/:class after Access" --> CSR
  GW -- "KeyAdmin: public keys, Rotate" --> AGENTS
  GW -- "GET /registry" --> REG
  GW -- "BrokerAdmin + operator's Access token:<br/>decide, rotate, halt, resume; audit" --> BR
  BR -- "Access team keys (certs)" --> ACCESS
  TRI -- "RPC TriageApplyIntake: proposals" --> TAP
  TRI -- "signed, TriageBroker: reads" --> BR
  TAP -- "signed, TriageApplyBroker: bundle approvals" --> BR
  PRG -- "signed, PrGateBroker: reads, pr.close" --> BR
  CSR -- "signed, CheatsheetReviewBroker: reads, review" --> BR
  BR -- "reads state; halt, resume" --> KV
  BR --> D1
  BR -- "only holder of GitHub tokens" --> GHAPI
  GHAPI -- "issue and PR text" --> BR
  TRI -- "untrusted text inside untrusted()" --> AIG
  PRG -- "untrusted text inside untrusted()" --> AIG
  CSR -- "untrusted text inside untrusted(); PDF bytes for toMarkdown" --> AIG
  PRG -- "Jev direct, ADR 0011" --> ORT
  CSR -- "anonymous GET, fetchable on every hop:<br/>link audit, claim sources, ≤4 sources<br/>the security reviewer asks for" --> WEB
  WEB -- "page text, into untrusted()" --> CSR
  AIG --> ANT
  AIG --> ORT
  AIG --> WAI
  TRI -- "digest, incl. inert author text" --> OUTMAIL
  PRG -- "summary" --> OUTMAIL
  CSR -- "approval link" --> OUTMAIL
  INMAIL --> ER
  ER -- "approve@, reject@: refused by the gateway; the rest: dropped" --> GW
```

Legend: red = untrusted input, yellow = holds a credential, blue = stored state, grey = holds
nothing. Every arrow into a model carries untrusted GitHub text wrapped in `untrusted()`, and every
answer goes through `parseStructured()` (CLAUDE.md invariant 2).

## Trust boundaries

| #   | Boundary                       | What crosses it                                                                                                                                    | Control                                                                                                                                                                                                                                                                       |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TB1 | Internet → gateway             | webhooks, operator requests, `/verify`                                                                                                             | webhook HMAC; Cloudflare Access JWT and approver list for `/admin` and `/agents`; service tokens may only trigger run, digest or summary                                                                                                                                      |
| TB2 | gateway → agent Workers        | queued webhook fields (no bodies), operator requests                                                                                               | `queuedFields()` minimises payloads; the consumer re-checks repo, label and sender (`route()`); unknown classes are a 404 (no fallback)                                                                                                                                       |
| TB3 | agent Worker → broker          | action and read requests, approval requests                                                                                                        | Ed25519 signature by the Worker's own key, nonce, per-Worker entrypoint admits only its agent ids; the default entrypoint refuses everything                                                                                                                                  |
| TB4 | broker → GitHub                | writes and reads                                                                                                                                   | policy (`policy.json`), kill switch, approvals, rate limits, audit record countersigned; PATs only here; comments: people rule (thread + policy `maintainers`, text only) and comment rules on every path, trigger-label daily cap (ADR 0024); writes never follow a redirect |
| TB5 | GitHub text → model            | issue, PR and comment text; public web pages cheatsheet-review fetched (PR links, claim sources, sources its security reviewer asks for, ADR 0020) | `untrusted()` envelopes, `parseStructured()` with zod, injection evals; fetches: `fetchable` on every hop (https, public DNS, not `custodes.work`, `api.github.com` or `*.workers.dev`), no credentials; pass 2 can only add findings                                         |
| TB6 | agent Worker → e-mail          | digests, summaries, approval links                                                                                                                 | `send_email` `allowed_destination_addresses` = the gateway's `APPROVER_EMAILS` (`bindings.test.ts`)                                                                                                                                                                           |
| TB7 | operator click → broker action | approval decision                                                                                                                                  | link token bound to the action hash, single use; decided only on `BrokerAdmin` (gateway only), which verifies the approver's own Access token itself (#104); the broker re-checks the snapshot (issue, or pull request with head SHA and reviews, ADR 0024)                   |

## Where each credential lives

| Credential                                 | Holder                                                                            | Used for                            |
| ------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------- |
| GitHub PATs (`PAT_*`, Secrets Store)       | custodes-github-broker only                                                       | every GitHub read and write         |
| Broker Keyring (Ed25519, approval HMAC)    | custodes-github-broker (Durable Object)                                           | countersigning audit records, links |
| Agent keys (Ed25519, Keyholder)            | each agent Worker, its own                                                        | signing its broker calls            |
| `AI_GATEWAY_TOKEN`                         | custodes-triage, -pr-gate, -cheatsheet-review                                     | calling AI Gateway                  |
| `OPENROUTER_API_KEY`                       | custodes-pr-gate only                                                             | Jev, direct (ADR 0011)              |
| Provider keys (BYOK)                       | AI Gateway                                                                        | Anthropic, OpenRouter               |
| `GITHUB_WEBHOOK_SECRET`                    | custodes-gateway                                                                  | verifying webhooks                  |
| Kill switch (KV, write)                    | custodes-github-broker only (the gateway asks it with the operator's token; #104) | halt and resume                     |
| CI: Cloudflare deploy token, Anthropic WIF | GitHub Actions, `prod` environment                                                | deploys, Claude review and evals    |
