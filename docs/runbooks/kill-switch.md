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

Afterwards: check `custodes audit list --agent <agent>` for what happened before the halt and
open an incident if anything reached GitHub or e-mail.
