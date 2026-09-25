#!/usr/bin/env bash
# PreToolUse(Bash): deny commands that change production state or exfiltrate secrets, no matter
# how they were spelled. The permissions.deny list is the first line; this is the second.
set -euo pipefail
input=$(cat)
# Extract the command and drop heredoc bodies (<<EOF ... EOF): only executable text is inspected,
# so documentation that *mentions* a forbidden command does not trip the guard.
cmd=$(printf '%s' "$input" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let c = "";
  try { c = JSON.parse(s).tool_input.command || ""; } catch { c = ""; }
  const out = [];
  let term = null;
  for (const line of c.split("\n")) {
    if (term !== null) { if (line.trim() === term) term = null; continue; }
    const m = /<<-?\s*["\x27]?([A-Za-z_][A-Za-z0-9_]*)["\x27]?/.exec(line);
    if (m) term = m[1];
    out.push(line);
  }
  console.log(out.join("\n"));
});')

deny() {
  node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:process.argv[1]}}))" "$1"
  exit 2
}

# Deploys and secret writes only through CI (and preview uploads via /preview), never ad hoc.
if printf '%s' "$cmd" | grep -Eq '(^|[;&| ])(npx |pnpm (exec |dlx )?|bunx )?wrangler[[:space:]]+(deploy|publish|delete|secret|secrets-store|versions[[:space:]]+deploy)'; then
  deny "wrangler deploy/secret commands run only in CI; use /preview for a no-traffic version upload"
fi
if printf '%s' "$cmd" | grep -Eq '(^|[;&| ])terraform[[:space:]]+(apply|destroy|import|state[[:space:]]+rm)'; then
  deny "terraform apply/destroy runs only in CI after environment approval"
fi
# Never print or ship secret files.
# Plain *.tfvars in this repo hold ids and addresses only; credentials live in env vars and
# backend.hcl. Only *secret*.tfvars files are treated as secret-bearing.
if printf '%s' "$cmd" | grep -Eq '\.dev\.vars|secret[^ ]*\.tfvars|backend\.hcl|~/\.wrangler|~/\.cloudflared|/secrets/'; then
  deny "access to secret-bearing files is blocked"
fi
# Force pushes and history rewrites.
if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push[[:space:]].*(--force|-f([[:space:]]|$))'; then
  deny "force pushes are not allowed"
fi
# Piping remote content into a shell.
if printf '%s' "$cmd" | grep -Eq '(curl|wget)[^|]*\|[[:space:]]*(ba|z)?sh([[:space:]]|$)'; then
  deny "piping downloads into a shell is not allowed"
fi
exit 0
