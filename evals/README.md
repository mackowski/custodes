# Evals

Behavioural and adversarial tests for agents, run with [promptfoo](https://www.promptfoo.dev/) against
the same AI Gateway the agents use.

```
promptfooconfig.yaml   shared provider + defaults
injection/corpus.yaml  prompt-injection strings tagged by technique; grows with every incident
agents/<id>/           per-agent behaviour cases and the prompt under test
output/                results (git-ignored)
```

Run locally:

```bash
export AI_GATEWAY_ACCOUNT_ID=... AI_GATEWAY_ID=custodes AI_GATEWAY_TOKEN=...
cd evals && pnpm dlx promptfoo@0.121.0 eval -c promptfooconfig.yaml
```

Rules: never weaken an assertion to make a case pass; never delete an injection case; keep each
agent's suite under 60 cases so it can run on every pull request.
