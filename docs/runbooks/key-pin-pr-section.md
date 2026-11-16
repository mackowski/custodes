# Fixed architecture section for key-pin pull requests

A pull request from **Agent key pin** (`agent-key-pin.yml`) only adds or retires public keys in
`packages/schema/src/agent-keys.json`. Paste everything below the line into its body (the
`pr-architecture` check requires it; `.claude/skills/ship/SKILL.md`), then fill in the Worker and
`kid`.

---

<!-- architecture:start -->

## Architecture and data flow

### Unchanged: where a pinned key is used

```mermaid
flowchart LR
  classDef changed fill:#fff3cd,stroke:#b7791f,color:#000
  KH["agent Worker<br/>Keyholder: private key never leaves"] -- "signed request" --> BR["custodes-github-broker<br/>per-Worker entrypoint"]
  PIN["packages/schema/src/agent-keys.json<br/>~ public key added or retired"]:::changed -- "built into" --> BR
  PIN -- "built into" --> GW["custodes-gateway<br/>/verify"]
```

Data flow: unchanged: this pins a public key only; no Worker, binding, route, secret or grant changes.

### Security

| Aspect                             | Change                                        | Effect | Control                                                                                    |
| ---------------------------------- | --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| Trust boundaries                   | none                                          | same   | n/a                                                                                        |
| Credentials and secrets            | a public key is pinned or retired (no secret) | same   | `kid` and `x` compared with the Worker's own `keyholder.key.created` log line before merge |
| Untrusted input and models         | none                                          | same   | n/a                                                                                        |
| Authority (policy, actions, repos) | the Worker's broker calls are accepted again  | same   | the grant is in `policy.json`, unchanged                                                   |
| Approvals and kill switch          | none                                          | same   | n/a                                                                                        |
| CI, supply chain, deploy           | none                                          | same   | n/a                                                                                        |
| Access and public routes           | `/verify` checks this Worker's signatures     | same   | n/a                                                                                        |

### Documentation

- [x] Not affected: a key pin changes no documented flow (`docs/runbooks/agent-cutover.md` step 3).

<!-- architecture:end -->
