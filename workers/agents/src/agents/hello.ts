import { CustodesAgent } from '@custodes/core/agent';
import type { AgentManifest } from '@custodes/schema';
import type { AgentsEnv } from '../env.js';

export const HELLO_MANIFEST: AgentManifest = {
  id: 'hello',
  version: '0.1.0',
  description:
    'Smoke-test agent: proves scheduling, state, kill switch and the broker path end to end.',
  mode: 'hitl',
  repos: ['OWASP/CheatSheetSeries'],
};

interface HelloState {
  runs: number;
  lastRunAt: string | null;
  lastOutcome: string | null;
}

/**
 * The smallest useful agent. It does not call an LLM and never posts to GitHub unless a human
 * approves; it exists so the whole pipeline can be exercised end to end before real agents ship.
 */
export class HelloAgent extends CustodesAgent<AgentsEnv, HelloState> {
  readonly manifest = HELLO_MANIFEST;
  override initialState: HelloState = { runs: 0, lastRunAt: null, lastOutcome: null };

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname.endsWith('/run')) {
      const actor = request.headers.get('x-custodes-actor') ?? 'unknown';
      const outcome = await this.run({ kind: 'cli', ref: actor });
      return Response.json(outcome);
    }
    return Response.json({
      manifest: this.manifest,
      state: this.state,
      killSwitch: await this.killSwitch.state(this.manifest.id),
    });
  }

  /** One run. Real agents would poll GitHub (through read-only calls), reason, then `act()`. */
  async run(triggeredBy: {
    kind: 'schedule' | 'cli' | 'manual';
    ref?: string;
  }): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.guard();
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'halted';
      this.setState({ ...this.state, lastOutcome: detail });
      return { ok: false, detail };
    }
    const runId = crypto.randomUUID();
    this.setState({
      runs: this.state.runs + 1,
      lastRunAt: new Date().toISOString(),
      lastOutcome: `heartbeat run ${runId} (${triggeredBy.kind})`,
    });
    // Example of the broker path (hitl → will return approval_required until approved):
    // const res = await this.act({ type: 'issue.comment', repo: 'OWASP/CheatSheetSeries', issue: 1, body: 'hello' }, runId, triggeredBy);
    return { ok: true, detail: this.state.lastOutcome ?? '' };
  }
}
