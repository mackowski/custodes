/**
 * Test-only main module (`vitest.config.ts`). Production has no Worker that holds all the agents:
 * each runs in its own (ADR 0018). The tests still run them side by side against a stub broker, so
 * this exports every agent class for the test Durable Object bindings; the entry points under test
 * are the per-agent ones (`src/*-worker.ts`), imported by the tests themselves.
 */
export { TriageAgent } from '../src/agents/triage.js';
export { ImplementationCheckAgent } from '../src/agents/implementation-check.js';
export { ProposalReviewAgent } from '../src/agents/proposal-review.js';
export { PrGateAgent } from '../src/agents/pr-gate.js';
export { CheatsheetReviewAgent } from '../src/agents/cheatsheet-review.js';
export { TriageApplyAgent } from '../src/agents/triage-apply.js';
export { BacklogReviewAgent } from '../src/agents/backlog-review.js';
export { KeyAdmin, Keyholder } from '@custodes/core/keyholder';

export default {
  fetch: () => new Response('test entry', { status: 404 }),
} satisfies ExportedHandler;
