/**
 * Model smoke test, run by CI before every deploy and by the manual Diagnose workflow.
 *
 * Sends the exact request the triage agent sends (same builder, same prompt) for a synthetic issue
 * through AI Gateway, then checks the answer parses and validates. A parameter the model rejects,
 * a missing BYOK key, a bad gateway token or a truncated answer fails the pipeline here instead of
 * failing every production call. Prints status, token counts and error classes, never content.
 */
import process from 'node:process';
import { AnthropicGateway, parseStructured } from '@custodes/llm';
import { RawAssessment, validateAssessment } from '../src/agents/triage/assess.js';
import { describeError } from '../src/agents/triage/errors.js';
import { triageRequest } from '../src/agents/triage/model.js';
import { buildUserMessage, SYSTEM_PROMPT } from '../src/agents/triage/prompt.js';
import type { PublicIssue } from '../src/agents/triage/github.js';

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
    `model smoke OK: model=${res.model} stop=${res.stop_reason} in=${res.usage.input_tokens} out=${res.usage.output_tokens} kind=${assessment.kind} dropped=${assessment.dropped.length}`,
  );
} catch (err) {
  console.error(`model smoke FAILED: ${describeError(err)}`);
  process.exit(1);
}
