/**
 * Jev smoke test, run by the manual Diagnose workflow (and before deploys once ADR 0011's transport
 * is settled). Sends pr-gate's exact minor-fix questions for a synthetic typo diff and checks the
 * answers parse and say "minor".
 *
 * `--probe` tries each candidate AI Gateway path for OpenRouter's Decisions API and reports which
 * one works. With OPENROUTER_API_KEY set it also tries OpenRouter directly. Prints status, model,
 * cost and scores only, never content.
 */
import process from 'node:process';
import { JEV_GATEWAY_PATH, JevClient, jevState, MODELS, type JevTransport } from '@custodes/llm';
import { describeError } from '../src/agents/triage/errors.js';
import { jevMinorVerdict, MINOR_QUESTIONS } from '../src/agents/pr-gate/minor.js';
import { diffText } from '../src/agents/pr-gate/rules.js';

const env = process.env as unknown as Record<string, string | undefined>;
const token = env['AI_GATEWAY_TOKEN'];
const directKey = env['OPENROUTER_API_KEY'];
const probe = process.argv.includes('--probe');
const accountId = env['AI_GATEWAY_ACCOUNT_ID'] ?? '5f62912564df344533c9563904c77662';
const gatewayId = env['AI_GATEWAY_ID'] ?? 'custodes';

const diff = diffText([
  {
    filename: 'cheatsheets/Password_Storage_Cheat_Sheet.md',
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch:
      '@@ -10,1 +10,1 @@\n-Passwords should be hashed with a strong, slow algorthm such as Argon2id.\n+Passwords should be hashed with a strong, slow algorithm such as Argon2id.',
  },
]);

async function attempt(label: string, transport: JevTransport): Promise<boolean> {
  try {
    const res = await new JevClient({ transport }).decide({
      model: MODELS.decision,
      state: jevState('pr-diff', diff),
      questions: MINOR_QUESTIONS,
      metadata: { agentId: 'smoke', runId: crypto.randomUUID() },
    });
    const v = jevMinorVerdict(res);
    console.log(
      `jev smoke ${v.decided && v.value ? 'OK' : 'UNEXPECTED'} (${label}): model=${res.model} p=${res.answers.minor.noul.toFixed(3)} kind=${res.answers.kind.choice} in=${res.usage?.input_tokens ?? '?'} cost=${res.usage?.cost ?? '?'}`,
    );
    return v.decided && v.value;
  } catch (err) {
    console.log(`jev smoke FAILED (${label}): ${describeError(err)}`);
    return false;
  }
}

const results: boolean[] = [];
if (token) {
  const paths = probe
    ? [JEV_GATEWAY_PATH, 'alpha/decisions', 'v1/alpha/decisions', 'api/v1/alpha/decisions']
    : [env['JEV_GATEWAY_PATH'] ?? JEV_GATEWAY_PATH];
  for (const path of [...new Set(paths)])
    results.push(
      await attempt(`gateway ${path}`, {
        kind: 'gateway',
        accountId,
        gatewayId,
        gatewayToken: token,
        path,
      }),
    );
} else {
  console.log('jev smoke: AI_GATEWAY_TOKEN is not set, gateway not tried');
}
if (directKey && (probe || !token))
  results.push(await attempt('direct', { kind: 'direct', apiKey: directKey }));
if (!results.some(Boolean)) process.exit(1);
