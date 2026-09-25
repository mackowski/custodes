# custodes CLI

Operator tool for the agent fleet. Every call goes to the gateway's `/admin` API, which sits behind
Cloudflare Access.

## Authenticate

Interactive (humans):

```bash
brew install cloudflared
cloudflared access login https://custodes.work/admin   # opens the browser once; /admin is the Access app
export CUSTODES_API_URL=https://custodes.work
custodes agents list
```

Automation (CI, cron): create an Access service token and export
`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`. The Access policy must include the token.

## Commands

```
custodes agents list | status <agent> | run <agent> | halt <agent|*> --reason ... | resume <agent|*>
custodes approvals list | approve <id> | reject <id>
custodes audit list [--agent id] | show <id> | verify <id>
custodes keys list | rotate <agent>
custodes logs gateway|agents|broker
```

`--json` on any command prints machine-readable output.
