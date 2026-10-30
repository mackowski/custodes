import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeAgent, type Tracer, type Turn } from '@custodes/core';
import { AnthropicGateway, GatewayError, ModelOutputError } from '@custodes/llm';
import type { PrGateAgent } from '../src/agents/pr-gate.js';
import {
  BrokerGitHubReader,
  type PublicIssue,
  type PublicPull,
} from '../src/agents/triage/github.js';
import { runTriage, type TriageDeps } from '../src/agents/triage/run.js';
import type { AgentsEnv } from '../src/env.js';
import { OWASP_INSTANCE, SANDBOX_INSTANCE } from '../src/instances.js';
import {
  IDENTITY,
  RecordingTracer,
  turnOf,
  type RecordedSpan,
} from './helpers/recording-tracer.js';

const testEnv = env as AgentsEnv;
const GW = 'CANARY-GW-4a1e';
const OR = 'CANARY-OR-c07d';
const ANT = 'CANARY-ANT-88b2';
const canaries = [GW, OR, ANT];
const REPO = 'OWASP/CheatSheetSeries';
const PAYLOAD_KEYS = [
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
];

const identityOf = (n: number, agent = 'triage') => ({
  'gen_ai.agent.name': agent,
  'gen_ai.conversation.id': `${REPO}#${n}`,
});

const leaks = (t: RecordingTracer, extra: string[] = []) => {
  const all = t.allValues().join('|') + t.spans.map((s) => s.name).join('|');
  return [...canaries, ...extra].filter((c) => all.includes(c));
};

// ---- runTriage: one invoke_agent per issue ----

const issue = (n: number): PublicIssue => ({
  number: n,
  title: `Issue ${n}`,
  body: 'The XSS cheat sheet has a broken example.',
  html_url: `https://github.com/${REPO}/issues/${n}`,
  user: { login: 'contributor' },
  labels: [],
  created_at: '2026-09-20T10:00:00Z',
  updated_at: `2026-09-2${n % 8}T10:00:00Z`,
  comments: 0,
});

const assessment = JSON.stringify({
  labels: ['bug'],
  cheatSheet: 'Cross_Site_Scripting_Prevention_Cheat_Sheet.md',
  possibleDuplicates: [],
  kind: 'bug',
  needsMaintainer: false,
  summary: 'Broken example in the XSS cheat sheet.',
  injectionDetected: false,
  confidence: 0.8,
});

const anthropicBody = (text: string, stop = 'end_turn') => ({
  id: 'msg_1',
  model: 'claude-sonnet-5',
  stop_reason: stop,
  content: [{ type: 'text', text }],
  usage: { input_tokens: 10, output_tokens: 4 },
});

function triageDeps(
  tracer: Tracer,
  payloads: boolean,
  fetchImpl: typeof fetch,
  issues: PublicIssue[],
): TriageDeps {
  const gateway = new AnthropicGateway({
    accountId: 'a',
    gatewayId: 'g',
    gatewayToken: GW,
    anthropicApiKey: ANT,
    fetchImpl,
  });
  const turnFor = (n: number): Turn => ({
    identity: { ...IDENTITY, conversationId: `${REPO}#${n}` },
    tracer,
    payloads,
  });
  return {
    reader: {
      listLabels: () => Promise.resolve(['bug', 'enhancement']),
      listCheatSheets: () => Promise.resolve(['Cross_Site_Scripting_Prevention_Cheat_Sheet.md']),
      listRecentIssueTitles: () => Promise.resolve([{ number: 3, title: 'older' }]),
      listUpdatedIssues: () => Promise.resolve(issues),
    },
    complete: async (system, user, n, turn) =>
      AnthropicGateway.text(
        await gateway.messages(
          {
            model: 'claude-sonnet-5',
            system,
            messages: [{ role: 'user', content: user }],
            max_tokens: 100,
            metadata: { agentId: 'triage', runId: 'run-1' },
          },
          turn,
        ),
      ),
    turn: turnFor,
    store: {
      isCurrent: () => false,
      failures: () => 0,
      recordFailure: () => 1,
      save: () => undefined,
    },
    now: () => new Date('2026-09-28T10:00:00Z'),
  };
}

const respond = (body: unknown, status = 200) =>
  (() =>
    Promise.resolve(
      typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status }),
    )) as unknown as typeof fetch;

describe('runTriage tracing', () => {
  it('opens exactly one invoke_agent per evaluated issue with a chat child carrying the identity', async () => {
    const t = new RecordingTracer();
    const d = triageDeps(t, true, respond(anthropicBody(assessment)), [issue(5), issue(6)]);
    const r = await runTriage(REPO, 'x', d);
    expect(r.assessed).toBe(2);
    expect(t.roots.map((s) => s.name)).toEqual(['invoke_agent triage', 'invoke_agent triage']);
    for (const [i, n] of [5, 6].entries()) {
      const root = t.roots[i]!;
      expect(root.attributes).toMatchObject({
        'gen_ai.operation.name': 'invoke_agent',
        ...identityOf(n),
        'gen_ai.agent.id': IDENTITY.agentId,
        'custodes.run_id': IDENTITY.runId,
        'custodes.outcome': 'bug',
      });
      expect(root.children).toHaveLength(1);
      const c = root.children[0]!;
      expect(c.parent).toBe(root);
      expect(c.attributes).toMatchObject({
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'anthropic',
        'gen_ai.request.model': 'claude-sonnet-5',
        'gen_ai.usage.input_tokens': 10,
        'gen_ai.usage.output_tokens': 4,
        ...identityOf(n),
        'custodes.run_id': IDENTITY.runId,
      });
    }
    expect(t.spans).toHaveLength(4);
  });

  it('opens no span for an issue skipped as already assessed', async () => {
    const t = new RecordingTracer();
    const d = triageDeps(t, false, respond(anthropicBody(assessment)), [issue(5)]);
    await runTriage(REPO, 'x', { ...d, store: { ...d.store, isCurrent: () => true } });
    expect(t.spans).toHaveLength(0);
  });

  it('creates no spans without deps.turn', async () => {
    const t = new RecordingTracer();
    const d = triageDeps(t, true, respond(anthropicBody(assessment)), [issue(5)]);
    delete d.turn;
    const r = await runTriage(REPO, 'x', d);
    expect(r.assessed).toBe(1);
    expect(t.spans).toHaveLength(0);
  });

  it('records no payload attributes and no credentials when payloads are off', async () => {
    const t = new RecordingTracer();
    await runTriage(
      REPO,
      'x',
      triageDeps(t, false, respond(anthropicBody(assessment)), [issue(5)]),
    );
    for (const s of t.spans)
      for (const k of PAYLOAD_KEYS) expect(s.attributes).not.toHaveProperty(k);
    expect(leaks(t)).toEqual([]);
  });

  it('records OTel-shaped payloads but still no credentials when payloads are on', async () => {
    const t = new RecordingTracer();
    await runTriage(REPO, 'x', triageDeps(t, true, respond(anthropicBody(assessment)), [issue(5)]));
    const c = t.named('chat')[0]!;
    const input = JSON.parse(c.attributes['gen_ai.input.messages'] as string) as {
      role: string;
      parts: { type: string }[];
    }[];
    expect(input[0]?.role).toBe('user');
    expect(input[0]?.parts[0]?.type).toBe('text');
    expect(c.attributes['gen_ai.system_instructions']).toBeTypeOf('string');
    expect(c.attributes['gen_ai.output.messages']).toBeTypeOf('string');
    expect(leaks(t)).toEqual([]);
  });

  it('marks a gateway failure as error.type only, never the body, and the run keeps going', async () => {
    const t = new RecordingTracer();
    const d = triageDeps(t, true, respond('SECRET-BODY', 500), [issue(5)]);
    const r = await runTriage(REPO, 'x', d);
    expect(r.errors).toHaveLength(1);
    const root = t.roots[0]!;
    const c = root.children[0]!;
    expect(c.status).toBe('error');
    expect(c.attributes['error.type']).toBe('GatewayError 500');
    expect(root.status).toBe('error');
    expect(root.attributes['error.type']).toBe('GatewayError 500');
    expect(leaks(t, ['SECRET-BODY'])).toEqual([]);
  });

  it('marks a refusal as ModelOutputError refusal', async () => {
    const t = new RecordingTracer();
    const d = triageDeps(t, true, respond(anthropicBody('', 'refusal')), [issue(5)]);
    await runTriage(REPO, 'x', d);
    expect(t.roots[0]!.attributes['error.type']).toBe('ModelOutputError refusal');
    expect(new ModelOutputError('refusal').name).toBe('ModelOutputError');
  });

  it('ends the span as an error when the model output is unparseable, without echoing it', async () => {
    const t = new RecordingTracer();
    const d = triageDeps(t, false, respond(anthropicBody('SECRET-BODY not json')), [issue(5)]);
    const r = await runTriage(REPO, 'x', d);
    expect(r.assessed).toBe(0);
    expect(t.roots[0]!.status).toBe('error');
    expect(t.roots[0]!.attributes['error.type']).toBe('StructuredOutputError');
    expect(leaks(t, ['SECRET-BODY'])).toEqual([]);
  });

  it('gives the same result and error when every span method throws', async () => {
    const good = await runTriage(
      REPO,
      'x',
      triageDeps(
        new RecordingTracer({ attribute: true, status: true }),
        true,
        respond(anthropicBody(assessment)),
        [issue(5)],
      ),
    );
    expect(good.assessed).toBe(1);
    const bad = await runTriage(
      REPO,
      'x',
      triageDeps(
        new RecordingTracer({ attribute: true, status: true }),
        true,
        respond('SECRET-BODY', 500),
        [issue(5)],
      ),
    );
    expect(bad.errors[0]).toContain('GatewayError');
    expect(bad.errors[0]).toContain('500');
    expect(new GatewayError(500, 'x').status).toBe(500);
  });
});

// ---- BrokerGitHubReader read spans ----

describe('BrokerGitHubReader tracing', () => {
  const SECRET_DATA = 'SECRET-GITHUB-DATA';
  const okBroker = {
    fetch: () =>
      Promise.resolve(Response.json({ ok: true, data: [{ name: SECRET_DATA }, { name: 'bug' }] })),
  };

  it('records read metadata only, never the response data, even with payloads on', async () => {
    const t = new RecordingTracer();
    const turn = turnOf(t, true);
    const reader = new BrokerGitHubReader(okBroker, 'triage', 'run-1').inTurn(turn);
    const labels = await invokeAgent(turn, () => reader.listLabels(REPO));
    expect(labels).toContain(SECRET_DATA);
    const read = t.named('execute_tool read.labels')[0]!;
    expect(read.parent).toBe(t.roots[0]);
    expect(read.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'read.labels',
      'custodes.read.ok': true,
    });
    expect(read.attributes['custodes.read.bytes']).toBeTypeOf('number');
    for (const k of PAYLOAD_KEYS) expect(read.attributes).not.toHaveProperty(k);
    expect(t.allValues().join('|')).not.toContain(SECRET_DATA);
  });

  it('records the issue number and a failed read as status, not text', async () => {
    const t = new RecordingTracer();
    const turn = turnOf(t, true);
    const broker = {
      fetch: () =>
        Promise.resolve(
          Response.json({
            ok: false,
            code: 'github_error',
            reason: 'SECRET-BODY',
            status: 404,
          }),
        ),
    };
    const reader = new BrokerGitHubReader(broker, 'triage', 'run-1', turn);
    await expect(reader.getIssue(REPO, 42)).rejects.toThrow('github_error');
    const read = t.named('execute_tool read.issue')[0]!;
    expect(read.attributes).toMatchObject({
      'custodes.read.number': 42,
      'custodes.read.ok': false,
      'custodes.read.status': 404,
      'error.type': 'GitHubReadError 404',
    });
    expect(read.status).toBe('error');
    expect(t.allValues().join('|')).not.toContain('SECRET-BODY');
  });

  it('creates no spans without a turn, and inTurn does not change the original reader', async () => {
    const t = new RecordingTracer();
    const base = new BrokerGitHubReader(okBroker, 'triage', 'run-1');
    await base.listLabels(REPO);
    base.inTurn(turnOf(t, true));
    await base.listLabels(REPO);
    expect(t.spans).toHaveLength(0);
  });
});

// ---- Durable Object agents ----

interface Internals {
  env: AgentsEnv;
  tracer: Tracer;
  ensureSchema(): void;
  sql<T>(strings: TemplateStringsArray, ...values: unknown[]): T[];
  act(
    action: unknown,
    runId: string,
    trigger: unknown,
    opts: { turn?: Turn },
  ): Promise<{ ok: boolean }>;
  turn(repo: string, n: number, runId: string): Turn;
}

const withEnv = (original: AgentsEnv, extra: Record<string, unknown>): AgentsEnv =>
  Object.create(
    original,
    Object.fromEntries(Object.entries(extra).map(([k, value]) => [k, { value }])),
  ) as AgentsEnv;

const BODY = `## AI Tool Usage Disclosure (required for all PRs)

- [x] I did not use any AI tools in preparing this contribution.
`;
const SANDBOX = 'mackowski/custodes-sandbox';
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const pull = (number: number): PublicPull => ({
  number,
  title: `PR ${number}`,
  body: BODY,
  html_url: `https://github.com/${SANDBOX}/pull/${number}`,
  state: 'open',
  user: { login: 'contributor', type: 'User' },
  author_association: 'CONTRIBUTOR',
  labels: [],
  created_at: ago(5 * 3_600_000),
  updated_at: ago(3 * 3_600_000),
  head: { sha: `sha-${number}` },
});
const smallFix = {
  filename: 'cheatsheets/Foo_Cheat_Sheet.md',
  status: 'modified',
  additions: 1,
  deletions: 1,
  changes: 2,
  patch: '@@ -1 +1 @@\n-teh\n+the',
};
const ATTESTATION = '3f2b8c1e-9d4a-4b6e-8a2e-1f7d1c2b3a44';

/** Pulls, one small diff per PR, no issues; `act` answers the broker's close request. */
const fakeBroker = (open: PublicPull[], actCalls: unknown[] = []) => ({
  fetch: (url: string, init: RequestInit) => {
    const req = JSON.parse(init.body as string) as {
      resource?: string;
      query?: { state?: string };
    };
    if (url.endsWith('/v1/act')) {
      actCalls.push(req);
      return Response.json({
        ok: true,
        attestationId: ATTESTATION,
        githubUrl: 'https://github.com/x/y',
      });
    }
    if (req.resource === 'pulls')
      return Response.json({ ok: true, data: req.query?.state === 'closed' ? [] : open });
    if (req.resource === 'pull_files') return Response.json({ ok: true, data: [smallFix] });
    return Response.json({ ok: true, data: [] });
  },
});

const jevAnswers = (model: string, p: number, kind: string) => ({
  model,
  answers: {
    minor: { type: 'noul' as const, noul: p },
    kind: { type: 'choice' as const, choice: kind, confidence: 0.9, probabilities: {} },
  },
  usage: { input_tokens: 120, output_tokens: 3 },
});

const stub = () => getAgentByName(testEnv.PrGateAgent, SANDBOX_INSTANCE);

async function inPrGate<T>(
  broker: ReturnType<typeof fakeBroker>,
  tracer: Tracer,
  envExtra: Record<string, unknown>,
  fn: (agent: PrGateAgent, i: Internals) => Promise<T>,
  ai: { run: (...a: unknown[]) => Promise<unknown> } = {
    run: () => Promise.resolve(jevAnswers('clef', 0.2, 'new_guidance')),
  },
): Promise<T> {
  return runInDurableObject(await stub(), async (agent: PrGateAgent) => {
    const i = agent as unknown as Internals;
    const original = i.env;
    const originalTracer = i.tracer;
    i.env = withEnv(original, { BROKER: broker, AI: ai, ...envExtra });
    i.tracer = tracer;
    try {
      return await fn(agent, i);
    } finally {
      i.env = original;
      i.tracer = originalTracer;
    }
  });
}

beforeEach(async () => {
  await runInDurableObject(await stub(), async (agent: PrGateAgent) => {
    const i = agent as unknown as Internals;
    i.ensureSchema();
    i.sql`DELETE FROM decisions`;
    i.sql`DELETE FROM evaluations`;
    i.sql`DELETE FROM events`;
    i.sql`DELETE FROM model_comparisons`;
    for (const s of await agent.listSchedules()) await agent.cancelSchedule(s.id);
    agent.setState({
      lastPollAt: null,
      lastSummaryAt: null,
      day: new Date().toISOString().slice(0, 10),
      closesToday: 0,
      evaluationsToday: 0,
      lastErrors: [],
    });
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        Response.json({ id: 'd1', ...jevAnswers('typesafe/jev-1.14', 0.95, 'link') }),
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const shape = (s: RecordedSpan): string => `${s.name}[${s.children.map(shape).join(',')}]`;

describe('pr-gate tracing', () => {
  const creds = { AI_GATEWAY_TOKEN: GW, OPENROUTER_API_KEY: OR };

  it('opens one invoke_agent per evaluated PR, with Jev and Clef chat spans and read spans under it', async () => {
    const t = new RecordingTracer();
    const r = await inPrGate(fakeBroker([pull(9401), pull(9402)]), t, creds, (a) => a.poll());
    expect(r.detail).toBe('2 open, 2 evaluated, 0 close attempt(s)');
    const roots = t.roots;
    expect(roots).toHaveLength(2);
    for (const [idx, n] of [9401, 9402].entries()) {
      const root = roots[idx]!;
      expect(root.name).toBe('invoke_agent pr-gate');
      expect(root.attributes).toMatchObject({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'pr-gate',
        'gen_ai.agent.id': `pr-gate/${SANDBOX_INSTANCE}`,
        'gen_ai.conversation.id': `${SANDBOX}#${n}`,
        'custodes.outcome': 'skip',
      });
      expect(root.attributes['custodes.run_id']).toBeTypeOf('string');
      const chats = root.children.filter((c) => c.name.startsWith('chat '));
      expect(chats.map((c) => c.attributes['gen_ai.provider.name'])).toEqual([
        'openrouter',
        'cloudflare.workers_ai',
      ]);
      for (const c of chats) {
        expect(c.parent).toBe(root);
        expect(c.attributes).toMatchObject({
          'gen_ai.agent.name': 'pr-gate',
          'gen_ai.conversation.id': `${SANDBOX}#${n}`,
          'custodes.run_id': root.attributes['custodes.run_id'],
          'gen_ai.usage.input_tokens': 120,
        });
        expect(c.attributes['gen_ai.request.model']).toBeTypeOf('string');
      }
      const reads = root.children.filter((c) => c.name.startsWith('execute_tool read.'));
      expect(reads.map((c) => c.name)).toContain('execute_tool read.pull_files');
    }
    // Everything at the top level is a turn; the pulls listing is not traced.
    expect(t.roots.every((s) => s.name === 'invoke_agent pr-gate')).toBe(true);
    expect(t.named('invoke_agent')).toHaveLength(2);
  });

  it('records payloads (TRACE_PAYLOADS=true) but never a credential or GitHub response data', async () => {
    expect(testEnv.TRACE_PAYLOADS).toBe('true');
    const t = new RecordingTracer();
    await inPrGate(fakeBroker([pull(9403)]), t, creds, (a) => a.poll());
    const chats = t.named('chat');
    expect(chats).toHaveLength(2);
    for (const c of chats) {
      const out = JSON.parse(c.attributes['gen_ai.output.messages'] as string) as {
        role: string;
        parts: unknown[];
      }[];
      expect(out[0]?.role).toBe('assistant');
      expect(c.attributes['gen_ai.input.messages']).toBeTypeOf('string');
    }
    for (const read of t.named('execute_tool read.'))
      for (const k of PAYLOAD_KEYS) expect(read.attributes).not.toHaveProperty(k);
    expect(
      t
        .named('execute_tool read.')
        .flatMap((r) => Object.values(r.attributes))
        .join('|'),
    ).not.toContain('teh');
    expect(leaks(t)).toEqual([]);
  });

  it('records no payload attributes when TRACE_PAYLOADS is not "true"', async () => {
    const t = new RecordingTracer();
    await inPrGate(fakeBroker([pull(9404)]), t, { ...creds, TRACE_PAYLOADS: 'false' }, (a) =>
      a.poll(),
    );
    expect(t.named('chat')).toHaveLength(2);
    for (const s of t.spans)
      for (const k of PAYLOAD_KEYS) expect(s.attributes).not.toHaveProperty(k);
    expect(leaks(t)).toEqual([]);
  });

  it('records a Clef timeout as error.type only and keeps the decision', async () => {
    const t = new RecordingTracer();
    const ai = {
      run: () =>
        Promise.reject(Object.assign(new Error('SECRET-BODY'), { name: 'ClefTimeoutError' })),
    };
    const r = await inPrGate(fakeBroker([pull(9405)]), t, creds, (a) => a.poll(), ai);
    expect(r.detail).toBe('1 open, 1 evaluated, 0 close attempt(s)');
    const clefSpan = t
      .named('chat')
      .find((c) => c.attributes['gen_ai.provider.name'] === 'cloudflare.workers_ai');
    expect(clefSpan?.status).toBe('error');
    expect(clefSpan?.attributes['error.type']).toBe('ClefTimeoutError');
    expect(t.roots[0]!.status).toBe('unset');
    expect(leaks(t, ['SECRET-BODY'])).toEqual([]);
  });

  it('records a failing Jev call as error.type only, ends the turn as an error row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('SECRET-BODY', { status: 500 }))),
    );
    const t = new RecordingTracer();
    await inPrGate(fakeBroker([pull(9406)]), t, creds, (a) => a.poll());
    const root = t.roots[0]!;
    // The ladder absorbs a failed rung: the turn ends as an operator flag, the chat span as an error.
    expect(root.attributes['custodes.outcome']).toBe('flag');
    const jevSpan = t
      .named('chat')
      .find((c) => c.attributes['gen_ai.provider.name'] === 'openrouter');
    expect(jevSpan?.status).toBe('error');
    expect(jevSpan?.attributes['error.type']).toBe('GatewayError 500');
    expect(jevSpan?.parent).toBe(root);
    expect(leaks(t, ['SECRET-BODY'])).toEqual([]);
  });

  it('behaves the same when every span method throws', async () => {
    const t = new RecordingTracer({ attribute: true, status: true });
    const r = await inPrGate(fakeBroker([pull(9407)]), t, creds, async (a, i) => {
      const res = await a.poll();
      const row = i.sql<{ outcome: string }>`SELECT outcome FROM decisions WHERE pr = 9407`[0];
      return { res, row };
    });
    expect(r.res.detail).toBe('1 open, 1 evaluated, 0 close attempt(s)');
    expect(r.row?.outcome).toBe('skip');
  });

  it('wraps a close in an execute_tool pr.close span with the action as payload', async () => {
    const calls: unknown[] = [];
    const t = new RecordingTracer();
    const res = await inPrGate(fakeBroker([], calls), t, creds, async (agent, i) => {
      const turn = i.turn(SANDBOX, 9408, 'run-act');
      const body = 'closing comment';
      return invokeAgent(turn, () =>
        i.act(
          { type: 'pr.close', repo: SANDBOX, pull: 9408, body },
          'run-act',
          { kind: 'schedule', ref: 'pr-gate.poll' },
          { turn },
        ),
      ).then((r) => ({ r, agent }));
    });
    expect(res.r.ok).toBe(true);
    // Agents never send an approval id: the broker runs approved actions itself.
    expect(JSON.stringify(calls)).not.toContain('approvalId');
    const tool = t.named('execute_tool pr.close')[0]!;
    expect(tool.parent).toBe(t.roots[0]);
    expect(tool.attributes).toMatchObject({
      'gen_ai.tool.name': 'pr.close',
      'custodes.broker.outcome': 'ok',
    });
    expect(JSON.parse(tool.attributes['gen_ai.tool.call.arguments'] as string)).toMatchObject({
      type: 'pr.close',
      pull: 9408,
    });
    expect(leaks(t)).toEqual([]);
  });

  it('omits the tool arguments when payloads are off and records the denial code', async () => {
    const t = new RecordingTracer();
    const broker = {
      fetch: () => Response.json({ ok: false, code: 'policy_denied', reason: 'SECRET-BODY' }),
    };
    await inPrGate(
      broker as unknown as ReturnType<typeof fakeBroker>,
      t,
      { TRACE_PAYLOADS: 'false' },
      async (_a, i) => {
        const turn = i.turn(SANDBOX, 9409, 'run-act');
        await invokeAgent(turn, () =>
          i.act(
            { type: 'pr.close', repo: SANDBOX, pull: 9409, body: 'b' },
            'run-act',
            { kind: 'schedule', ref: 'pr-gate.poll' },
            { turn },
          ),
        );
      },
    );
    const tool = t.named('execute_tool pr.close')[0]!;
    expect(tool.attributes['custodes.broker.outcome']).toBe('policy_denied');
    expect(tool.attributes).not.toHaveProperty('gen_ai.tool.call.arguments');
    expect(leaks(t, ['SECRET-BODY'])).toEqual([]);
  });

  it('act() without a turn creates no span', async () => {
    const t = new RecordingTracer();
    const r = await inPrGate(fakeBroker([]), t, {}, (_a, i) =>
      i.act(
        { type: 'pr.close', repo: SANDBOX, pull: 9410, body: 'b' },
        'run-act',
        { kind: 'schedule', ref: 'pr-gate.poll' },
        {},
      ),
    );
    expect(r.ok).toBe(true);
    expect(t.spans).toHaveLength(0);
  });
});

describe('specialist agents tracing', () => {
  it('opens one invoke_agent per job under the issue conversation, with the failed read as a child', async () => {
    const stubA = await getAgentByName(testEnv.ProposalReviewAgent, SANDBOX_INSTANCE);
    await stubA.enqueue([{ issue: 9501, issueUpdatedAt: '2026-09-20T10:00:00Z' }]);
    const t = new RecordingTracer();
    await runInDurableObject(stubA, async (agent) => {
      const i = agent as unknown as Internals;
      const originalTracer = i.tracer;
      i.tracer = t;
      try {
        await (agent as unknown as { work(): Promise<void> }).work();
      } finally {
        i.tracer = originalTracer;
      }
    });
    expect(t.roots).toHaveLength(1);
    const root = t.roots[0]!;
    expect(root.name).toBe('invoke_agent proposal-review');
    expect(root.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'proposal-review',
      'gen_ai.agent.id': `proposal-review/${SANDBOX_INSTANCE}`,
      'gen_ai.conversation.id': `${SANDBOX}#9501`,
      'error.type': 'GitHubReadError',
    });
    expect(root.status).toBe('error');
    const read = root.children[0]!;
    expect(read.name).toMatch(/^execute_tool read\./);
    expect(read.status).toBe('error');
    expect(shape(root)).not.toContain('chat');
    expect(leaks(t)).toEqual([]);
    expect(OWASP_INSTANCE).toBeTypeOf('string');
  });
});
