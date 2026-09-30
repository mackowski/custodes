# Evals

Behavioural and adversarial tests for agents, run with [promptfoo](https://www.promptfoo.dev/) against
the same AI Gateway the agents use.

```
injection/corpus.yaml  prompt-injection strings tagged by technique; grows with every incident
agents/<id>/           per-agent promptfooconfig.yaml, cases.yaml and the shipped system prompt
output/                results (git-ignored)
```

Run locally:

```bash
export AI_GATEWAY_ACCOUNT_ID=... AI_GATEWAY_ID=custodes AI_GATEWAY_TOKEN=...
cd evals && pnpm dlx promptfoo@0.123.1 eval -c agents/triage/promptfooconfig.yaml --no-cache
```

Evals use promptfoo's generic HTTP provider (not its Anthropic provider, which demands a provider key
that lives in the gateway) and send exactly what the agent sends. Add an eval config only for agents
that call a model. Requires Node >= 22.22.

Rules: never weaken an assertion to make a case pass; never delete an injection case; keep each
agent's suite under 60 cases so it can run on every pull request.
