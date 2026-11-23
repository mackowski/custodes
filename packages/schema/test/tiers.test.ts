import { describe, expect, it } from 'vitest';
import {
  ACTION_REGISTRY,
  AgentPolicy,
  DEFAULT_APPROVAL_TTL_HOURS,
  DEFAULT_MAX_PENDING_APPROVALS,
  BrokerActionType,
  Policy,
  ReadPolicy,
  highestTier,
} from '../src/index.js';

const agent = {
  tokenBinding: 'PAT_X',
  mode: 'hotl',
  tier: 'T1',
  repos: ['o/r'],
  actions: ['issue.comment'],
};

describe('ACTION_REGISTRY (ADR 0021, ADR 0022)', () => {
  it('has a tier and a risk for every broker action', () => {
    for (const t of BrokerActionType.options) {
      expect(ACTION_REGISTRY[t], t).toBeDefined();
    }
    expect(Object.keys(ACTION_REGISTRY).sort()).toEqual([...BrokerActionType.options].sort());
  });

  it('puts model-authored repository content (inline suggestions) in T2 and the rest in T1', () => {
    expect(ACTION_REGISTRY['pr.review.inline'].tier).toBe('T2');
    expect(highestTier(['issue.comment', 'pr.close'])).toBe('T1');
    expect(highestTier(['issue.label.remove', 'pr.review.inline'])).toBe('T2');
    expect(highestTier([])).toBe('T0');
  });
});

describe('AgentPolicy tier', () => {
  it('accepts a tier equal to the highest tier of the actions', () => {
    expect(AgentPolicy.safeParse(agent).success).toBe(true);
  });

  it('refuses an action above the declared tier, so a T2 grant is a visible tier change', () => {
    const r = AgentPolicy.safeParse({ ...agent, actions: ['issue.comment', 'pr.review.inline'] });
    expect(r.success).toBe(false);
  });

  it('refuses an over-declared tier', () => {
    expect(AgentPolicy.safeParse({ ...agent, tier: 'T2' }).success).toBe(false);
  });

  it('needs a tier', () => {
    const { tier: _tier, ...noTier } = agent;
    expect(AgentPolicy.safeParse(noTier).success).toBe(false);
  });
});

describe('strict policy keys (ADR 0022)', () => {
  it('refuses a misspelt field instead of dropping it', () => {
    // Before #139 this parsed and the approval list was silently lost.
    const r = AgentPolicy.safeParse({ ...agent, requiresAprovalOn: { 'o/r': ['issue.comment'] } });
    expect(r.success).toBe(false);
  });

  it('accepts $comment and $comment_<field>, and drops them', () => {
    const p = AgentPolicy.parse({ ...agent, $comment: 'why', $comment_repos: 'why these' });
    expect(Object.keys(p)).not.toContain('$comment');
    expect(Object.keys(p)).not.toContain('$comment_repos');
  });

  it('refuses a comment key that carries a real field instead of text (review of #139, L1)', () => {
    const hidden = { ...agent, $comment_requiresApprovalOn: { 'o/r': ['issue.comment'] } };
    expect(AgentPolicy.safeParse(hidden).success).toBe(false);
  });

  it('refuses other $-keys', () => {
    expect(AgentPolicy.safeParse({ ...agent, $commentary: 'x' }).success).toBe(false);
    expect(AgentPolicy.safeParse({ ...agent, $note: 'x' }).success).toBe(false);
  });

  it('is strict for reads and the top level too', () => {
    const read = { tokenBinding: 'PAT_READONLY', repos: ['o/r'], resources: ['issue'] };
    expect(ReadPolicy.safeParse(read).success).toBe(true);
    expect(ReadPolicy.safeParse({ ...read, resource: ['pulls'] }).success).toBe(false);
    expect(Policy.safeParse({ version: 1, agents: {}, $comment: 'x' }).success).toBe(true);
    expect(Policy.safeParse({ version: 1, agents: {}, read: {} }).success).toBe(false);
  });
});

describe('policy defaults', () => {
  it('pins the values: raising one widens every agent that leaves the field out (review of #139)', () => {
    expect([DEFAULT_APPROVAL_TTL_HOURS, DEFAULT_MAX_PENDING_APPROVALS]).toEqual([24, 20]);
    expect(AgentPolicy.parse(agent).rateLimitPerHour).toBe(60);
  });
});
