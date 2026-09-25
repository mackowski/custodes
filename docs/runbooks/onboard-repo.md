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
6. Optional: if you have admin rights, add a webhook to `https://<gateway>/webhooks/github` with
   the shared secret `GITHUB_WEBHOOK_SECRET`, content type JSON, events: issues, pull requests.
