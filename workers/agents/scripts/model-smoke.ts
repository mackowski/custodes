/**
 * Model smoke test, run by CI before every deploy and by the manual Diagnose workflow.
 *
 * Sends the exact requests the agents send (same builders, same prompts) for a synthetic issue
 * through AI Gateway: triage (Sonnet 5), the specialists' file selection (Sonnet 5), a
 * proposal review (Opus 5.5) and one agent-runtime loop (Sonnet 5.5 with a tool call and its
 * tool_result, ADR 0023). Each answer must parse and validate. A parameter the model rejects,
 * a missing BYOK key, a bad gateway token or a truncated answer fails the pipeline here instead of
 * failing every production call. Prints status, token counts and error classes, never content.
 *
 * An exhausted Anthropic credit balance is account state, not something a deploy broke: it is a
 * warning, so fixes to Jev-only agents (pr-gate) still ship (2026-10-20). Production calls fail
 * the same way until the balance is topped up.
 */
import process from 'node:process';
import {
  AnthropicGateway,
  costOf,
  defineTool,
  GatewayError,
  OpenRouterMessages,
  parseStructured,
  runLoop,
} from '@custodes/llm';
import { ProposalList } from '@custodes/schema';
import { z } from 'zod';
import { RawAssessment, validateAssessment } from '../src/agents/triage/assess.js';
import { describeError } from '../src/agents/triage/errors.js';
import { triageRequest } from '../src/agents/triage/model.js';
import { buildUserMessage, SYSTEM_PROMPT } from '../src/agents/triage/prompt.js';
import type { PublicIssue } from '../src/agents/triage/github.js';
import { assessRequest, selectRequest } from '../src/agents/specialists/model.js';
import {
  buildProposalMessage,
  PROPOSAL_PROMPT,
  RawProposalReview,
  validateProposalReview,
} from '../src/agents/specialists/proposal.js';
import {
  buildSelectMessage,
  RawSelection,
  SELECT_PROMPT,
  validateSelection,
} from '../src/agents/specialists/select.js';

// The generated Worker types describe process.env as the Worker's bindings; in CI it is the runner's.
const env = process.env as unknown as Record<string, string | undefined>;
const token = env['AI_GATEWAY_TOKEN'];
if (!token) {
  console.error('model smoke FAILED: AI_GATEWAY_TOKEN is not set');
  process.exit(1);
}

const labels = ['bug', 'enhancement', 'question'];
const cheatSheets = ['Cross_Site_Scripting_Prevention_Cheat_Sheet.md'];
const issue: PublicIssue = {
  number: 1,
  title: 'Broken example in XSS prevention',
  body: 'The output encoding example in rule 2 uses innerHTML, which contradicts the text above it.',
  html_url: 'https://github.com/OWASP/CheatSheetSeries/issues/1',
  user: { login: 'contributor' },
  labels: [],
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  comments: 0,
};

const gateway = new AnthropicGateway({
  accountId: env['AI_GATEWAY_ACCOUNT_ID'] ?? '5f62912564df344533c9563904c77662',
  gatewayId: env['AI_GATEWAY_ID'] ?? 'custodes',
  gatewayToken: token,
});

// backlog-review's fallback (#132): the runtime request shape on GPT-6.2 Sol through OpenRouter
// (tools, reasoning effort, data_collection deny). First, so it runs even when Anthropic's credit
// balance is out, which is when the fallback is needed.
try {
  const sol = new OpenRouterMessages({
    accountId: env['AI_GATEWAY_ACCOUNT_ID'] ?? '5f62912564df344533c9563904c77662',
    gatewayId: env['AI_GATEWAY_ID'] ?? 'custodes',
    gatewayToken: token,
  });
  const readIssue = defineTool({
    name: 'issue',
    description: 'Read one issue with all its comments.',
    args: z.strictObject({ repo: z.literal('OWASP/CheatSheetSeries'), number: z.number().int() }),
    run: () => Promise.resolve({ content: JSON.stringify({ issue, comments: [] }) }),
  });
  let spent = 0;
  const loop = await runLoop(
    {
      model: 'openai/gpt-6.2-sol',
      system:
        'You review one OWASP Cheat Sheet Series issue. Read it with the issue tool, then answer with JSON {"proposals": []}.',
      task: 'Read issue OWASP/CheatSheetSeries#1, then answer {"proposals": []}.',
      tools: [readIssue],
      output: ProposalList,
      caps: { rounds: 3, usd: 0.05 },
      maxTokens: 2_000,
      metadata: { agentId: 'smoke', runId: crypto.randomUUID() },
    },
    {
      send: (req) => sol.messages(req),
      guard: () => Promise.resolve(),
      costOf: (u) => costOf('openai/gpt-6.2-sol', u),
      daily: {
        ledger: {
          spentToday: () => Promise.resolve(spent),
          add: (usd) => {
            spent += usd;
            return Promise.resolve();
          },
        },
        usd: 0.05,
      },
      record: () => undefined,
    },
  );
  if (!loop.ok) throw new Error(`fallback runtime loop stopped: ${loop.stop}`);
  console.log(
    `model smoke OK (runtime fallback, gpt-6.2-sol): rounds=${String(loop.rounds)} tools=${String(loop.progress.calls.length)}`,
  );
} catch (err) {
  // A warning, not a failure: the fallback being down must not block every Worker's deploy.
  console.log(
    `::warning::model smoke (runtime fallback, gpt-6.2-sol) FAILED: ${describeError(err)}`,
  );
}

try {
  const user = buildUserMessage(issue, {
    repo: 'OWASP/CheatSheetSeries',
    labels,
    cheatSheets,
    recent: [{ number: 2, title: 'Unrelated older issue' }],
  });
  const res = await gateway.messages(
    triageRequest(SYSTEM_PROMPT, user, {
      agentId: 'smoke',
      runId: crypto.randomUUID(),
      issue: '1',
    }),
  );
  const assessment = validateAssessment(
    parseStructured(RawAssessment, AnthropicGateway.text(res)),
    {
      issue: issue.number,
      labels,
      cheatSheets,
      recentIssues: [2],
    },
  );
  console.log(
    `model smoke OK (triage): model=${res.model} stop=${res.stop_reason} in=${res.usage.input_tokens} out=${res.usage.output_tokens} kind=${assessment.kind} dropped=${assessment.dropped.length}`,
  );

  const meta = { agentId: 'smoke', runId: crypto.randomUUID(), issue: '1' };
  const sel = await gateway.messages(
    selectRequest(
      SELECT_PROMPT,
      buildSelectMessage('OWASP/CheatSheetSeries', issue, cheatSheets),
      meta,
    ),
  );
  const picked = validateSelection(
    parseStructured(RawSelection, AnthropicGateway.text(sel)),
    cheatSheets,
  );
  console.log(
    `model smoke OK (select): model=${sel.model} stop=${sel.stop_reason} in=${sel.usage.input_tokens} out=${sel.usage.output_tokens} files=${picked.length}`,
  );

  const sheet =
    '# XSS Prevention\n\n## Output Encoding\n\nUse textContent, not innerHTML, for untrusted data.';
  const files = new Map([[cheatSheets[0] ?? 'x.md', sheet]]);
  const rev = await gateway.messages(
    assessRequest(
      PROPOSAL_PROMPT,
      buildProposalMessage('OWASP/CheatSheetSeries', issue, [], labels, files),
      meta,
    ),
  );
  const review = validateProposalReview(
    parseStructured(RawProposalReview, AnthropicGateway.text(rev)),
    {
      repo: 'OWASP/CheatSheetSeries',
      title: issue.title,
      labels,
      current: [],
      people: ['contributor'],
      author: 'contributor',
      files,
    },
  );
  console.log(
    `model smoke OK (assess): model=${rev.model} stop=${rev.stop_reason} in=${rev.usage.input_tokens} out=${rev.usage.output_tokens} verdict=${review.verdict} dropped=${review.dropped.length}`,
  );

  // The runtime's request shape (ADR 0023): tool definitions from zod, a tool_use, then the
  // tool_result inside untrusted() on the next round. A fixed read stands in for the broker.
  const readIssue = defineTool({
    name: 'issue',
    description: 'Read one issue with all its comments.',
    args: z.strictObject({ repo: z.literal('OWASP/CheatSheetSeries'), number: z.number().int() }),
    run: () => Promise.resolve({ content: JSON.stringify({ issue, comments: [] }) }),
  });
  let spent = 0;
  const loop = await runLoop(
    {
      model: 'claude-sonnet-5-5',
      system:
        'You review one OWASP Cheat Sheet Series issue. Read it with the issue tool, then answer with JSON {"proposals": []}.',
      task: 'Read issue OWASP/CheatSheetSeries#1, then answer {"proposals": []}.',
      tools: [readIssue],
      output: ProposalList,
      caps: { rounds: 3, usd: 0.05 },
      maxTokens: 2_000,
      metadata: { agentId: 'smoke', runId: crypto.randomUUID() },
    },
    {
      send: (req) => gateway.messages(req),
      guard: () => Promise.resolve(),
      costOf: (u) => costOf('claude-sonnet-5-5', u),
      daily: {
        ledger: {
          spentToday: () => Promise.resolve(spent),
          add: (usd) => {
            spent += usd;
            return Promise.resolve();
          },
        },
        usd: 0.05,
      },
      record: () => undefined,
    },
  );
  if (!loop.ok) throw new Error(`runtime loop stopped: ${loop.stop}`);
  console.log(
    `model smoke OK (runtime): rounds=${String(loop.rounds)} tools=${String(loop.progress.calls.length)} usd=${loop.usd.toFixed(4)}`,
  );
} catch (err) {
  if (err instanceof GatewayError && err.status === 400 && /credit balance/i.test(err.message)) {
    console.log(
      '::warning::model smoke SKIPPED: the Anthropic credit balance is too low, so the request shape was not checked',
    );
    process.exit(0);
  }
  console.error(`model smoke FAILED: ${describeError(err)}`);
  process.exit(1);
}
