# Create or rotate an agent's GitHub PAT

The PAT is the only per-agent secret. It never touches a laptop file or a wrangler command: it goes
from the GitHub token page into a GitHub Environment secret, and CI writes it into Secrets Store.

1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate.
   Name `custodes-<agent>`, resource owner: the org (OWASP) if it allows fine-grained tokens, else
   your account; repositories: only the agent's; permissions: only those listed for the agent's
   actions in `docs/architecture/security-controls.md`. Expiry ≤ 90 days.
2. In the repository → Settings → Environments → `prod` → add or update the secret
   `PAT_<AGENT>` (upper-case, dashes become underscores: `PAT_HELLO`, `PAT_PR_REVIEW`).
3. If this is a new agent, add one line to `.github/workflows/deploy-workers.yml` under
   "Sync agent PATs into Secrets Store": `PAT_<AGENT>: ${{ secrets.PAT_<AGENT> }}`. The
   `/new-agent` skill does this.
4. Run the **Deploy Workers** workflow (any push to `main`, or `workflow_dispatch`). The sync step
   updates `github-pat-<agent>` in Secrets Store; the broker reads it on the next request.
5. Revoke the old token on GitHub. Record the rotation date in `docs/agents/<agent>.md`.

## Attestation signing keys

Nothing to do. The broker generates each agent's Ed25519 key on first use and keeps it in its
Keyring; to rotate, run `custodes keys rotate <agent>`. Old keys stay published (marked retired) so
existing attestations still verify: `custodes keys list`.

## Calendar

Set a reminder 14 days before each PAT expiry. Expired PATs make the broker return `github_error`,
which shows up in `custodes audit list` as denied records.
