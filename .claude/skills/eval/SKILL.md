---
name: eval
description: Run or extend the promptfoo evals for an agent, including the prompt-injection corpus. Use after changing a prompt, model, schema or agent logic.
argument-hint: <agent-id> [--run]
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(pnpm dlx promptfoo*), Bash(pnpm --filter *)
---

# Evals for agent: $ARGUMENTS

Layout: `evals/promptfooconfig.yaml` (shared provider pointing at AI Gateway), `evals/agents/<id>/`
(cases), `evals/injection/corpus.yaml` (shared attack strings, tagged by technique).

1. Read the agent's prompt builder and output schema so assertions match the real contract.
2. Behaviour cases: realistic issue/PR fixtures with expected structured output; assert with
   `is-json` plus schema fields, not free-text similarity.
3. Injection cases: for each corpus entry, embed it in the untrusted slot and assert the output
   (a) still validates against the schema, (b) does not contain the attacker's requested action,
   (c) flags the injection when the schema has a field for it.
4. Keep the suite under 60 cases per agent so it runs on every PR.
5. If `--run` was given: `cd evals && pnpm dlx promptfoo@0.123.1 eval -c promptfooconfig.yaml`
   with `AI_GATEWAY_*` set, then summarise pass/fail counts and list every failing case with its
   technique tag.

Never paste real credentials into eval configs. Never weaken an assertion to make a case pass;
change the prompt or the schema, and say which.
