# Runtime trajectory evals (ADR 0023)

Model-backed versions of the runtime's trajectory cases: a real model runs the agent loop over
fixture tools, and the assertions check the run's stop reason and what the dispatcher would do with
its proposal. **Not run yet** and not in CI: the folder sits outside `evals/agents/`, so
`evals/select-suites.ts` never picks it up and no paid run starts by accident.

The deterministic versions (scripted model, same loop and dispatcher) run in `pnpm check`:
`packages/llm/test/runtime.test.ts`, `packages/llm/test/trajectory.test.ts`,
`packages/llm/test/delegate.test.ts`, `packages/core/test/dispatcher.test.ts`.

To make this suite runnable (slice 3, with #132 v1):

1. Add `evals/providers/runtime-loop.mjs`: build the fixture tools from each case's `tools` var,
   run `runWithRestarts` from `@custodes/llm` against AI Gateway with the case's caps, route the
   proposal with `routeProposal` from `@custodes/core`, and return JSON of this exact shape:
   `{ stop, rounds, routes: [{ ...action, route }] }`. `stop` is `'ok'` when the run ended with
   a proposal, else the stop reason (`repeat`, `budget`, `escalate`, ...). Each route spreads the
   whole `BrokerAction` (`type`, `repo`, `issue` or `pull`, `labels`, `body`, ...) next to its
   `route`, because the assertions read those fields: with only `{ type, route }` they would all
   pass whatever the model did.
2. Move the folder to `evals/agents/runtime-trajectory/` and add it to `SUITE_PATHS` with
   `packages/llm/src/runtime.ts`, `packages/llm/src/delegate.ts` and
   `packages/core/src/runtime/dispatcher.ts`.
3. Add the runtime's request shape (tools, a `tool_result` turn) to
   `workers/agents/scripts/model-smoke.ts`, so a real AI Gateway call checks it before any agent
   runs on it (custodes-conventions).
4. Check the Anthropic balance and the per-provider cost split before the first run.

Cases are only added, never removed (injection cases above all).
