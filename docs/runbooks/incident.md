# Incident: unwanted agent action

1. **Contain**: `custodes agents halt '*' --reason "incident <date>"`.
2. **Identify**: find the attestation id in the comment footer or `custodes audit list`, then
   `custodes audit show <id>`. Note `runId` and list the whole run: `custodes audit list --agent <a>`.
3. **Undo on GitHub**: edit or delete the comment / remove labels manually. Leave a short note if
   others saw it.
4. **Root cause**: was it policy (allowed but wrong), injection (check the inputs stored with the
   run), a bug, or an approval mistake? Save the offending input to `evals/injection/corpus.yaml`
   if it was an injection.
5. **Fix and test**: PR with the fix, a regression eval, and an ADR if the design changed.
6. **Rotate** anything that might have leaked (see rotate-pat.md).
7. **Resume** the agent only after the fix is deployed and exercised against a test repository.
8. Write a short post-mortem in `docs/runbooks/incidents/YYYY-MM-DD.md`.
