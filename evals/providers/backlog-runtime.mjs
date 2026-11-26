// promptfoo provider for backlog-review (#132 v1): runs the item-review role through the real
// runtime loop and model (workers/agents/scripts/eval-backlog-runtime.ts, bundled by
// evals/build-runtime.sh). Vars: fixture (an issues/<n>.json object or its JSON text) and
// optionally inject, applied to a copy: { body?: string appended to the issue body, comments?:
// [...] appended, search?: result }. Output: JSON { ok, stop?, verdict?, needsHuman?, routes, tools, usd }.

/**
 * @typedef {{ issue: { body?: string | null, comments?: number }, comments?: unknown[], search?: unknown }} Fixture
 * @typedef {{ body?: unknown, comments?: unknown, search?: unknown }} Inject
 * @typedef {{ runItemReview: (f: Fixture, env: Record<string, string | undefined>) => Promise<{ usd: number }> }} Runtime
 */

/**
 * @template T
 * @param {unknown} v
 * @returns {T}
 */
function parse(v) {
  /** @type {unknown} */
  const out = typeof v === 'string' ? JSON.parse(v) : structuredClone(v);
  return /** @type {T} */ (out);
}

export default class BacklogRuntimeProvider {
  /** @param {{ id?: string }} options */
  constructor(options) {
    this.providerId = options.id ?? 'backlog-runtime';
  }

  id() {
    return this.providerId;
  }

  /**
   * @param {string} _prompt
   * @param {{ vars: Record<string, unknown> }} context
   */
  async callApi(_prompt, context) {
    const runtime = /** @type {Runtime} */ (await import('../output/backlog-runtime.mjs'));
    /** @type {Fixture} */
    const fixture = parse(context.vars['fixture']);
    /** @type {Inject} */
    const inject = context.vars['inject'] ? parse(context.vars['inject']) : {};
    if (typeof inject.body === 'string')
      fixture.issue.body = `${fixture.issue.body ?? ''}\n\n${inject.body}`;
    if (Array.isArray(inject.comments)) {
      /** @type {unknown[]} */
      const added = inject.comments;
      fixture.comments = [...(fixture.comments ?? []), ...added];
      fixture.issue.comments = fixture.comments.length;
    }
    if (inject.search !== undefined) fixture.search = inject.search;
    try {
      const out = await runtime.runItemReview(fixture, process.env);
      return { output: JSON.stringify(out), cost: out.usd };
    } catch (err) {
      return { error: err instanceof Error ? err.name : 'error' };
    }
  }
}
