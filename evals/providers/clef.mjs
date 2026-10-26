// promptfoo custom provider: Cloudflare Clef (Workers AI) as pr-gate's shadow decision model
// (ADR 0015). It sends what the agent sends Jev (same questions.json, same untrusted envelope),
// always through the AI Gateway, never to Workers AI directly.
// Config (per suite): questions (path of the suite's questions.json, relative to this file), source (envelope source),
// var (the test variable holding the state), yes (noul question id), choice (choice question id),
// as (output key for the choice). Output: {"p": <probability>, "<as>": "<choice>"}, the same
// shape as the suite's Jev provider, so the same assertions grade both.

import { readFileSync } from 'node:fs';

/**
 * Mirrors untrusted() in packages/llm/src/untrusted.ts.
 * @param {string} source
 * @param {string} content
 */
function envelope(source, content) {
  const safe = content
    .replaceAll(String.fromCharCode(0), '')
    .replace(/<[\s/]*untrusted/gi, '&lt;untrusted');
  return `<untrusted source="${source}">\n${safe}\n</untrusted>`;
}

/**
 * @typedef {{ questions: string, source: string, var: string, yes: string, choice: string, as: string }} ClefConfig
 * @typedef {{ result?: { answers?: Record<string, { noul?: unknown, choice?: unknown }> }, answers?: Record<string, { noul?: unknown, choice?: unknown }> }} ClefResponse
 */

export default class ClefProvider {
  /** @param {{ id?: string, config: ClefConfig }} options */
  constructor(options) {
    this.config = options.config;
    this.providerId = options.id ?? 'clef';
    /** @type {unknown} */
    this.questions = JSON.parse(
      readFileSync(new URL(options.config.questions, import.meta.url), 'utf8'),
    );
  }

  id() {
    return this.providerId;
  }

  /**
   * @param {string} _prompt
   * @param {{ vars: Record<string, unknown> }} context
   */
  async callApi(_prompt, context) {
    const env = process.env;
    const c = this.config;
    const token = env['CF_WORKERS_AI_EVAL_TOKEN'];
    if (!token) return { error: 'CF_WORKERS_AI_EVAL_TOKEN is not set' };
    const url = `https://gateway.ai.cloudflare.com/v1/${env['AI_GATEWAY_ACCOUNT_ID'] ?? ''}/${env['AI_GATEWAY_ID'] ?? ''}/workers-ai/@cf/cloudflare/clef`;
    const value = context.vars[c.var];
    const state = typeof value === 'string' ? value : '';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'cf-aig-authorization': `Bearer ${env['AI_GATEWAY_TOKEN'] ?? ''}`,
        'cf-aig-metadata': `{"agentId":"evals","runId":"promptfoo-clef-${c.source}"}`,
      },
      body: JSON.stringify({
        model: 'clef',
        state: envelope(c.source, state.slice(0, 30_000)),
        questions: this.questions,
      }),
    });
    if (!res.ok) return { error: `HTTP ${String(res.status)}` };
    /** @type {unknown} */
    const raw = await res.json();
    const json = /** @type {ClefResponse} */ (raw);
    // Through the REST API Workers AI wraps the output in `result`.
    const answers = json.result?.answers ?? json.answers;
    const p = answers?.[c.yes]?.noul;
    const choice = answers?.[c.choice]?.choice;
    if (typeof p !== 'number' || typeof choice !== 'string')
      return { error: 'unexpected answer shape' };
    return { output: JSON.stringify({ p, [c.as]: choice }) };
  }
}
