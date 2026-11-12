# Kill switch

Stops an agent before its next side effect. Takes effect immediately for new actions; an action
already inside the broker completes.

```bash
custodes agents halt <agent> --reason "why"     # one agent
custodes agents halt '*' --reason "incident"    # whole fleet
custodes agents resume <agent|*>
```

Without the CLI (e.g. laptop lost): in the Cloudflare dashboard, KV → `custodes-kill-switch-<env>`
→ add key `halt:*` with value `{"halted":true,"reason":"manual","by":"<you>","at":"<iso>"}`.

Agents read their halt state from the broker (`/v1/state`) and count as halted when it does not
answer (#103). A broker outage, or rolling the broker back to a build without `/v1/state`, therefore
stops every agent: their status shows `kill-switch state unavailable` and the logs have
`agent.halt_state.unavailable`. They resume on their own once the broker answers again.

Do not roll the agents Worker back to a version from before #106 (agents without the kill-switch KV): older versions bind the
kill-switch namespace and could write it again. If such a rollback happens, deploy `main` right after.
Rolling the broker back to a version from before #106 fails too: those versions bind the
`github-pat-hello` secret, which Terraform deletes on apply.

Afterwards: check `custodes audit list --agent <agent>` for what happened before the halt and
open an incident if anything reached GitHub or e-mail.
