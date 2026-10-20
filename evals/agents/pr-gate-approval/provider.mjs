// promptfoo custom provider: pr-gate's maintainer-agreement Jev call (OpenRouter Decisions API), sent
// exactly as the agent sends it: same questions (questions.json, kept identical to APPROVAL_QUESTIONS
// by a unit test), same untrusted envelope, through AI Gateway (BYOK) or directly when
// JEV_TRANSPORT=direct. `state` is what approvalState() builds.
// Output: {"p": <probability a maintainer agreed>, "stance": "<choice>"}.
import questions from './questions.json' with { type: 'json' };

/**
 * Mirrors untrusted() in packages/llm/src/untrusted.ts.
 * @param {string} content
 */
function envelope(content) {
  const safe = content
    .replaceAll(String.fromCharCode(0), '')
    .replace(/<[\s/]*untrusted/gi, '&lt;untrusted');
  return `<untrusted source="pr-gate-approval">\n${safe}\n</untrusted>`;
}

/**
 * @typedef {{ answers?: { approved?: { noul?: unknown }, stance?: { choice?: unknown } }, usage?: { cost?: number } }} DecisionsResponse
 */

export default class JevProvider {
  id() {
    return 'jev-1.14-approval';
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
          'cf-aig-metadata': '{"agentId":"evals","runId":"promptfoo-pr-gate-approval"}',
        };
    const state = typeof context.vars['state'] === 'string' ? context.vars['state'] : '';
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'typesafe/jev-1.14',
        state: envelope(state.slice(0, 30_000)),
        questions,
      }),
    });
    if (!res.ok) return { error: `HTTP ${String(res.status)}` };
    /** @type {unknown} */
    const raw = await res.json();
    const json = /** @type {DecisionsResponse} */ (raw);
    const p = json.answers?.approved?.noul;
    const stance = json.answers?.stance?.choice;
    if (typeof p !== 'number' || typeof stance !== 'string')
      return { error: 'unexpected answer shape' };
    const cost = json.usage?.cost;
    return { output: JSON.stringify({ p, stance }), ...(cost !== undefined ? { cost } : {}) };
  }
}
