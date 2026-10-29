// promptfoo custom provider: Anthropic Messages through AI Gateway with the stored (BYOK) key, as
// AnthropicGateway in packages/llm/src/gateway.ts sends it: gateway token only, no provider key,
// no Unified Billing fallback, no sampling parameters. It also finds the key the same way: alias
// `default`, else the only alias the gateway reports (error 2040); several aliases fail instead
// of guessing. promptfoo's HTTP provider cannot retry, hence this file.
// Config (per suite): model, max_tokens, thinking (optional, sent as given), runId (metadata).
// Vars: system, user. Output: the JSON the agent would parse (parseStructured's extraction).

/** @typedef {{ model: string, max_tokens: number, thinking?: unknown, runId: string }} GatewayConfig */

const BYOK_ALIAS = /^[A-Za-z0-9_-]{1,64}$/;
const ALIASES_PREFIX = 'Configured aliases: ';

/**
 * Mirrors byokAliasesOf in packages/llm/src/gateway.ts.
 * @param {string} body
 * @returns {string[] | undefined}
 */
function byokAliasesOf(body) {
  try {
    /** @type {unknown} */
    const raw = JSON.parse(body);
    const parsed = /** @type {{ internalCode?: unknown, message?: unknown }} */ (raw);
    if (parsed.internalCode !== 2040 || typeof parsed.message !== 'string') return undefined;
    // indexOf, not a regex: the message is not ours, and `/…: (.*)$/` backtracks polynomially.
    const at = parsed.message.indexOf(ALIASES_PREFIX);
    const list = at < 0 ? '' : parsed.message.slice(at + ALIASES_PREFIX.length, at + 2000);
    const aliases = [...list.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
    return aliases.every((a) => BYOK_ALIAS.test(a)) ? aliases : [];
  } catch {
    return undefined;
  }
}

/**
 * Text blocks only, then parseStructured's extraction: a bare object first (its strings may hold
 * ``` from a code suggestion), else a fenced block, else the outermost object.
 * @param {{ content?: { type: string, text?: string }[] }} json
 */
function extract(json) {
  const t = (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  const m = t.trimStart().startsWith('{') ? null : /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (m) return m[1] ?? '';
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  return i >= 0 && j > i ? t.slice(i, j + 1) : t;
}

/** Alias found in this eval process, shared by every suite's provider instance. */
/** @type {string | undefined} */
let discovered;

export default class AnthropicGatewayProvider {
  /** @param {{ id?: string, config: GatewayConfig }} options */
  constructor(options) {
    this.config = options.config;
    this.providerId = options.id ?? 'anthropic-gateway';
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
    const url = `https://gateway.ai.cloudflare.com/v1/${env['AI_GATEWAY_ACCOUNT_ID'] ?? ''}/${env['AI_GATEWAY_ID'] ?? ''}/anthropic/v1/messages`;
    const system = context.vars['system'];
    const user = context.vars['user'];
    const body = JSON.stringify({
      model: c.model,
      max_tokens: c.max_tokens,
      ...(c.thinking !== undefined ? { thinking: c.thinking } : {}),
      system: typeof system === 'string' ? system : '',
      messages: [{ role: 'user', content: typeof user === 'string' ? user : '' }],
    });
    /** @param {string | undefined} alias */
    const send = (alias) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'cf-aig-authorization': `Bearer ${env['AI_GATEWAY_TOKEN'] ?? ''}`,
          'cf-aig-no-wholesale': 'true',
          'cf-aig-metadata': JSON.stringify({ agentId: 'evals', runId: c.runId }),
          ...(alias !== undefined ? { 'cf-aig-byok-alias': alias } : {}),
        },
        body,
      });
    const known = discovered;
    let res = await send(known);
    if (!res.ok) {
      let text = await res.text();
      const aliases = byokAliasesOf(text);
      if (aliases) {
        discovered = undefined;
        const only = aliases.length === 1 ? aliases[0] : undefined;
        if (only !== undefined && only !== known) {
          discovered = only;
          res = await send(only);
          if (!res.ok) text = await res.text();
        }
      }
      // Status and error class only: response bodies can quote the prompt.
      if (!res.ok) {
        /** @type {string} */
        let kind = byokAliasesOf(text) ? 'byok_alias_missing' : 'error';
        try {
          /** @type {unknown} */
          const raw = JSON.parse(text);
          const e = /** @type {{ error?: { type?: unknown } }} */ (raw);
          if (kind === 'error' && typeof e.error?.type === 'string') kind = e.error.type;
        } catch {
          /* not JSON */
        }
        return { error: `HTTP ${String(res.status)} ${kind}` };
      }
    }
    /** @type {unknown} */
    const raw = await res.json();
    const json =
      /** @type {{ content?: { type: string, text?: string }[], usage?: { input_tokens?: number, output_tokens?: number } }} */ (
        raw
      );
    const prompt = json.usage?.input_tokens ?? 0;
    const completion = json.usage?.output_tokens ?? 0;
    return {
      output: extract(json),
      tokenUsage: { prompt, completion, total: prompt + completion },
    };
  }
}
