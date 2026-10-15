// promptfoo custom provider: pr-gate's Jev call (OpenRouter Decisions API), sent exactly as the agent
// sends it: same questions (questions.json, kept identical to MINOR_QUESTIONS by a unit test), same
// untrusted envelope, through AI Gateway (BYOK) or directly when JEV_TRANSPORT=direct.
// Output: {"p": <probability of minor>, "kind": "<choice>"}.
import { readFileSync } from 'node:fs';

/** @type {unknown} */
const questions = JSON.parse(readFileSync(new URL('./questions.json', import.meta.url), 'utf8'));

/**
 * Mirrors untrusted() in packages/llm/src/untrusted.ts.
 * @param {string} content
 */
function envelope(content) {
  const safe = content
    .replaceAll(String.fromCharCode(0), '')
    .replace(/<[\s/]*untrusted/gi, '&lt;untrusted');
  return `<untrusted source="pr-diff">\n${safe}\n</untrusted>`;
}

/**
 * @typedef {{ answers?: { minor?: { noul?: unknown }, kind?: { choice?: unknown } }, usage?: { cost?: number } }} DecisionsResponse
 */

export default class JevProvider {
  id() {
    return 'jev-1.14';
  }

  /**
   * @param {string} _prompt
   * @param {{ vars: Record<string, unknown> }} context
   */
  async callApi(_prompt, context) {
    const env = process.env;
    // Same choice as the agent: the gateway unless the direct fallback is configured (ADR 0011).
    const direct = env['JEV_TRANSPORT'] === 'direct' ? env['OPENROUTER_API_KEY'] : undefined;
    const path = env['JEV_GATEWAY_PATH'] ?? 'api/alpha/decisions';
    const url = direct
      ? 'https://openrouter.ai/api/alpha/decisions'
      : `https://gateway.ai.cloudflare.com/v1/${env['AI_GATEWAY_ACCOUNT_ID'] ?? ''}/${env['AI_GATEWAY_ID'] ?? ''}/openrouter/${path}`;
    const headers = direct
      ? { 'content-type': 'application/json', authorization: `Bearer ${direct}` }
      : {
          'content-type': 'application/json',
          'cf-aig-authorization': `Bearer ${env['AI_GATEWAY_TOKEN'] ?? ''}`,
          'cf-aig-metadata': '{"agentId":"evals","runId":"promptfoo-pr-gate"}',
        };
    const diff = typeof context.vars['diff'] === 'string' ? context.vars['diff'] : '';
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'typesafe/jev-1.14',
        state: envelope(diff.slice(0, 30_000)),
        questions,
      }),
    });
    if (!res.ok) return { error: `HTTP ${String(res.status)}` };
    /** @type {unknown} */
    const raw = await res.json();
    const json = /** @type {DecisionsResponse} */ (raw);
    const p = json.answers?.minor?.noul;
    const kind = json.answers?.kind?.choice;
    if (typeof p !== 'number' || typeof kind !== 'string')
      return { error: 'unexpected answer shape' };
    const cost = json.usage?.cost;
    return { output: JSON.stringify({ p, kind }), ...(cost !== undefined ? { cost } : {}) };
  }
}
