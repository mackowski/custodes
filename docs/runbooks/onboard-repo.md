# Let an agent work on a new repository

1. Talk to the repository's maintainers first. Agree the label(s) that trigger work (e.g.
   `custodes/triage`) and which actions are acceptable. Link the agreement in the PR.
2. Add the repo to the agent's `repos` in `workers/github-broker/policy/policy.json` and to its
   manifest in `workers/agents/src/agents/<agent>.ts`.
3. Add the repo to the agent's PAT (fine-grained tokens list repositories explicitly).
4. Update `docs/agents/<agent>.md` and run `/threat-model <agent>`; new repos can bring new kinds
   of untrusted content.
5. Deploy, run the agent against a test issue in that repo with hitl enabled, verify the
   footer with `custodes audit verify`.
6. Optional: if you have admin rights, add a webhook so pr-gate reacts within about 30 minutes
   instead of at the next 4-hourly cron. Do it on `mackowski/custodes-sandbox` first and check one
   PR end to end (`queue.dispatch` with `outcome: scheduled` in the agents Worker logs, then a
   `pr-gate.wake` log about 30 minutes later). Settings → Webhooks → Add webhook:
   - Payload URL `https://custodes.work/webhooks/github`, content type `application/json`.
   - Secret: the value of `GITHUB_WEBHOOK_SECRET` (Keychain, `scripts/with-secrets.sh`; never
     paste it anywhere else). All repositories share it.
   - "Let me select individual events": **Pull requests** only. Triage does not use webhooks.

   Unticking "Active" on the hook stops webhook wake-ups only: pr-gate's polls still schedule a
   wake-up for PRs in their grace period. The kill switch stops everything.
