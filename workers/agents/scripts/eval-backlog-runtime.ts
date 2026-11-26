// Runs backlog-review's item-review role (#132 v1) as the agent does: the shipped agent.md and
// context files, the runtime loop with the real read tools, the real model through AI Gateway, then
// the dispatcher in shadow with the real evidence check. Reads come from the case's fixture instead
// of the broker. Bundled by evals/build-runtime.sh into evals/output/backlog-runtime.mjs, which
// evals/providers/backlog-runtime.mjs loads. Lives here for the package's dependencies and types.
import { routeProposal } from '@custodes/core';
import {
  AnthropicGateway,
  brokerEvidence,
  childTask,
  costOf,
  OpenRouterMessages,
  proposalOf,
  readTools,
  runWithRestarts,
  type ReadFn,
} from '@custodes/llm';
import { BacklogVerdict, type BrokerReadRequest } from '@custodes/schema';
import { raisesToHuman } from '../src/agents/backlog-review/raise.js';
import { backlogAgents, POLICY } from '../src/agents/backlog-review/bundle.js';

/** What a case gives: the issue and everything the broker would return for it. */
export interface Fixture {
  repo: string;
  number: number;
  issue: unknown;
  comments?: unknown[];
  timeline?: unknown[];
  pulls?: Record<string, unknown>;
  cheatsheets?: Record<string, string>;
  search?: unknown;
  /** The case's "today" (golden case 001: T0). */
  now?: string;
}

export interface RunOutput {
  ok: boolean;
  stop?: string;
  verdict?: BacklogVerdict;
  needsHuman?: boolean;
  routes: { type: string; route: string; live?: string; reason?: string }[];
  tools: string[];
  usd: number;
}

function fixtureRead(f: Fixture): ReadFn {
  return (_runId, req: Omit<BrokerReadRequest, 'agentId' | 'runId'>) => {
    const r = req.resource;
    if (req.repo !== f.repo) return Promise.resolve({ ok: false, reason: 'policy_denied' });
    const page = req.query.page ?? 1;
    const paged = (items: unknown[] | undefined) =>
      Promise.resolve({ ok: true as const, data: page === 1 ? (items ?? []) : [] });
    if (r === 'issue')
      return req.number === f.number
        ? Promise.resolve({ ok: true, data: f.issue })
        : Promise.resolve({ ok: false, reason: 'github_error' });
    if (r === 'comments') return paged(req.number === f.number ? f.comments : []);
    if (r === 'timeline') return paged(req.number === f.number ? f.timeline : []);
    if (r === 'pull') {
      const pr = f.pulls?.[String(req.number)];
      return Promise.resolve(pr ? { ok: true, data: pr } : { ok: false, reason: 'github_error' });
    }
    if (r === 'cheatsheet') {
      const text = req.file === undefined ? undefined : f.cheatsheets?.[req.file];
      return Promise.resolve(
        text === undefined
          ? { ok: false, reason: 'github_error' }
          : { ok: true, data: { name: req.file, content: text } },
      );
    }
    if (r === 'cheatsheet_search')
      return Promise.resolve({ ok: true, data: f.search ?? { total_count: 0, items: [] } });
    return Promise.resolve({ ok: false, reason: 'policy_denied' });
  };
}

/** One item-review run on `fixture`, as the agent would run it, plus the dispatcher's routes. */
export async function runItemReview(
  fixture: Fixture,
  env: Record<string, string | undefined>,
  /** `openai/...`: run the role on that model through OpenRouter (the agent's fallback). */
  opts: { model?: string } = {},
): Promise<RunOutput> {
  const { roles } = backlogAgents(fixture.repo);
  const role = roles['item-review'];
  if (!role) throw new Error('no item-review role');
  const reads = POLICY.reads['backlog-review'];
  if (!reads) throw new Error('no backlog-review read policy');
  const read = fixtureRead(fixture);
  const runId = crypto.randomUUID();
  const cfg = {
    accountId: env['AI_GATEWAY_ACCOUNT_ID'] ?? '',
    gatewayId: env['AI_GATEWAY_ID'] ?? '',
    gatewayToken: env['AI_GATEWAY_TOKEN'] ?? '',
  };
  const gateway =
    opts.model?.startsWith('openai/') === true
      ? new OpenRouterMessages(cfg)
      : new AnthropicGateway(cfg);
  const port = { repos: [fixture.repo] as [string], resources: reads.resources, read };
  const tools = readTools(port, runId, role.definition.tools);
  const toolNames: string[] = [];
  let spent = 0;
  const d = { ...role.definition, ...(opts.model ? { model: opts.model } : {}) };
  const result = await runWithRestarts(
    {
      model: d.model,
      system: role.prompt,
      // The same code-built task the host gives a child.
      task: childTask(
        'item-review',
        { repo: fixture.repo, kind: 'issue', number: fixture.number },
        new Date(fixture.now ?? Date.now()),
      ),
      tools,
      output: BacklogVerdict,
      caps: { rounds: d.budget.roundsPerRun, usd: d.budget.usdPerRun },
      maxTokens: 8_000,
      metadata: { agentId: 'backlog-review', runId },
    },
    {
      send: (req) => gateway.messages(req),
      guard: () => Promise.resolve(),
      costOf: (u) => costOf(d.model, u),
      daily: {
        ledger: {
          spentToday: () => Promise.resolve(spent),
          add: (usd) => {
            spent += usd;
            return Promise.resolve();
          },
        },
        usd: d.budget.usdPerDay,
      },
      record: (e) => {
        if (e.tool !== null) toolNames.push(e.tool);
      },
    },
  );
  if (!result.ok)
    return { ok: false, stop: result.stop, routes: [], tools: toolNames, usd: result.usd };
  const verdict = result.output;
  const needsHuman = proposalOf(verdict, raisesToHuman(verdict)).needsHuman;
  const routes = await routeProposal({
    policy: POLICY,
    agentId: 'backlog-review',
    proposal: proposalOf(verdict, raisesToHuman(verdict)),
    reads: result.reads,
    shadow: true,
    checkEvidence: brokerEvidence((req) => read(runId, req)),
    guard: () => Promise.resolve(),
    takeHotlSlot: () => false,
  });
  return {
    ok: true,
    verdict,
    needsHuman,
    routes: routes.map((r) =>
      r.route === 'drop'
        ? { type: r.action.type, route: r.route, reason: r.reason }
        : { type: r.action.type, route: r.route, ...(r.live ? { live: r.live } : {}) },
    ),
    tools: toolNames,
    usd: result.usd,
  };
}
