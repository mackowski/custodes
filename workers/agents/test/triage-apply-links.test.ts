import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { describe, expect, it } from 'vitest';
import { validateProposalReview } from '../src/agents/specialists/proposal.js';
import type { ProposalReview } from '../src/agents/specialists/proposal.js';
import type { ProposeResult } from '../src/agents/triage-apply/bundle.js';
import type { ApplyLink } from '../src/agents/triage/digest.js';
import type { AgentsEnv } from '../src/env.js';
import { SANDBOX_INSTANCE } from '../src/instances.js';

const testEnv = env as unknown as AgentsEnv;
const REPO = 'mackowski/custodes-sandbox';
const BASE = 'https://custodes.work/admin/approvals/link';
const TOKEN = `9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44.1900000000.${'A'.repeat(43)}`;

const review = (over: Partial<ProposalReview> = {}): ProposalReview => ({
  ...validateProposalReview(
    {
      verdict: 'real_gap',
      priorDecision: null,
      makesSense: true,
      evidence: [],
      addLabels: ['ACK_OBTAINED'],
      removeLabels: [],
      authorIntent: 'offered',
      volunteers: [],
      askAuthor: false,
      reviewPr: null,
      helpWanted: false,
      explanation: 'x',
      suggestedComment: 'Thanks {author}',
      injectionDetected: false,
      confidence: 0.8,
    },
    {
      repo: REPO,
      title: 'T',
      labels: ['ACK_OBTAINED'],
      current: [],
      people: ['author'],
      files: new Map(),
      now: new Date('2026-11-12T10:00:00Z'),
    },
  ),
  ...over,
});

interface Links {
  links: Map<number, ApplyLink>;
  withoutLink: number;
}
interface Internals {
  env: Record<string, unknown>;
  applyLinks(p: { issue: number; result: ProposalReview }[]): Promise<Links>;
}

/** Runs applyLinks with a fake TRIAGE_APPLY binding; returns what the binding was asked. */
async function run(
  proposals: { issue: number; result: ProposalReview }[],
  answer: (i: number) => ProposeResult | Promise<ProposeResult>,
  envOver: Record<string, unknown> = {},
) {
  const calls: { instance: string; proposal: Record<string, unknown> }[] = [];
  const svc = {
    propose: (instance: string, proposal: Record<string, unknown>) => {
      calls.push({ instance, proposal });
      return Promise.resolve(answer(calls.length));
    },
  };
  const stub = await getAgentByName(testEnv.TriageAgent, SANDBOX_INSTANCE);
  const out = await runInDurableObject(stub, (a) => {
    const agent = a as unknown as Internals;
    Object.defineProperty(agent, 'env', {
      value: { ...testEnv, TRIAGE_APPLY: svc, APPROVAL_LINK_BASE: BASE, ...envOver },
      configurable: true,
    });
    return agent.applyLinks(proposals);
  });
  return { out, calls };
}

const ok = (token = TOKEN): ProposeResult => ({
  ok: true,
  token,
  expiresAt: '2026-11-19T10:00:00.000Z',
  actions: ['issue.label.add', 'issue.comment'],
  dropped: [],
});

describe('triage applyLinks', () => {
  it('builds the link from the base and the token, and passes only the stored proposal', async () => {
    const { out, calls } = await run([{ issue: 7, result: review() }], () => ok());
    expect(out.links.get(7)).toEqual({
      url: `${BASE}/${TOKEN}`,
      expiresAt: '2026-11-19T10:00:00.000Z',
      actions: ['issue.label.add', 'issue.comment'],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.instance).toBe(SANDBOX_INSTANCE);
    expect(calls[0]?.proposal).toEqual({
      repo: REPO,
      issue: 7,
      addLabels: ['ACK_OBTAINED'],
      removeLabels: [],
      assignee: 'author',
      comment: 'Thanks @author',
      reason: 'proposal review: real_gap; assign: the model reads the author as offering to do it',
    });
  });

  it('is empty when triage-apply is not bound or the link base is not set', async () => {
    const p = [{ issue: 7, result: review() }];
    expect((await run(p, () => ok(), { TRIAGE_APPLY: undefined })).out).toEqual({
      links: new Map(),
      withoutLink: 0,
    });
    const noBase = await run(p, () => ok(), { APPROVAL_LINK_BASE: '' });
    expect(noBase.out.links.size).toBe(0);
    expect(noBase.calls).toHaveLength(0);
  });

  it('skips injection-flagged and changed proposals, and ones with nothing to apply, without asking', async () => {
    const { out, calls } = await run(
      [
        { issue: 1, result: review({ injectionDetected: true }) },
        { issue: 2, result: review({ changedSinceReview: true }) },
        {
          issue: 3,
          result: review({
            assignTo: null,
            addLabels: [],
            removeLabels: [],
            suggestedComment: '  ',
          }),
        },
      ],
      () => ok(),
    );
    expect(calls).toHaveLength(0);
    expect(out.links.size).toBe(0);
  });

  it('accepts only the broker token format; anything else becomes a reason, never a URL', async () => {
    for (const bad of [
      'x',
      `${TOKEN}/../../evil`,
      `${TOKEN}?next=https://evil.example`,
      `${TOKEN}#frag`,
      `${TOKEN} extra`,
      `short.1.${'A'.repeat(43)}`,
    ]) {
      const { out } = await run([{ issue: 7, result: review() }], () => ok(bad));
      // Parsed on receipt (ProposeResult): a bad token fails the whole answer.
      expect(out.links.get(7), bad).toEqual({ reason: 'malformed answer from triage-apply' });
    }
  });

  it('turns a refusal or an unreachable Worker into a reason', async () => {
    const refused = await run([{ issue: 7, result: review() }], () => ({
      ok: false,
      reason: 'broker refused (403: stale: the issue changed since the proposal)',
    }));
    expect(refused.out.links.get(7)).toEqual({
      reason: 'broker refused (403: stale: the issue changed since the proposal)',
    });
    const down = await run([{ issue: 7, result: review() }], () => {
      throw new Error('connection refused');
    });
    expect(down.out.links.get(7)).toMatchObject({
      reason: expect.stringContaining('unreachable') as unknown,
    });
  });

  it('counts a "too many pending approvals" refusal as without a link, not as a reason', async () => {
    const { out } = await run([{ issue: 7, result: review() }], () => ({
      ok: false,
      reason: 'broker refused (403: too many pending approvals)',
    }));
    expect(out.withoutLink).toBe(1);
    expect(out.links.has(7)).toBe(false);
  });

  it('stops asking after 20 links and counts the rest as without a link', async () => {
    const proposals = Array.from({ length: 23 }, (_, i) => ({ issue: i + 1, result: review() }));
    const { out, calls } = await run(proposals, () => ok());
    expect(calls).toHaveLength(20);
    expect(out.links.size).toBe(20);
    expect(out.withoutLink).toBe(3);
  });
});
