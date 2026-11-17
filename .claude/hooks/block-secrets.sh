#!/usr/bin/env bash
# PreToolUse(Read|Edit|Write|Grep): never open, write or search files that hold secrets.
# For Grep this is best effort: a wildcard that never spells the file name (".d*") is not matched
# here; the Read deny rules in settings.json and git-ignore are what cover that.
set -euo pipefail
input=$(cat)
path=$(printf '%s' "$input" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const i=JSON.parse(s).tool_input;console.log([i.file_path,i.path,i.glob].filter(Boolean).join(' '))}catch{console.log('')}})")
case "$path" in
  *.dev.vars*|*secret*.tfvars|*/backend.hcl|*/secrets/*|*.pem|*.key|*/.wrangler/*|*/.cloudflared/*)
    node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'secret-bearing file: '+process.argv[1]}}))" "$path"
    exit 2 ;;
esac
exit 0
