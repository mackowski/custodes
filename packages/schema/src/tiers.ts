import { z } from 'zod';
import type { BrokerActionType } from './actions.js';

/**
 * Trust tier (ADR 0021): what an agent can do. T0 reads and reports; T1 acts on threads and state or
 * writes code-computed content; T2 writes model-authored content into repository files; T3 executes
 * code that is not ours. An agent's tier is the highest tier of the actions its policy grants.
 */
export const Tier = z.enum(['T0', 'T1', 'T2', 'T3']);
export type Tier = z.infer<typeof Tier>;

/**
 * How bad one action can be (ADR 0022). The policy schema refuses a `critical` action without an
 * approval on every repository (ADR 0024); the other levels are recorded only.
 */
export type Risk = 'low' | 'medium' | 'high' | 'critical';

export interface ActionEntry {
  readonly tier: Tier;
  readonly risk: Risk;
}

/**
 * Every broker action with its tier and risk. A `Record` over `BrokerActionType`, so a new action
 * does not compile until it has an entry here (`/new-tool`).
 */
export const ACTION_REGISTRY: Readonly<Record<BrokerActionType, ActionEntry>> = {
  'issue.label.add': { tier: 'T1', risk: 'low' },
  'issue.label.remove': { tier: 'T1', risk: 'low' },
  'issue.unassign': { tier: 'T1', risk: 'low' },
  // Contributor-facing and public, but a person can reopen it (ADR 0024).
  'issue.close': { tier: 'T1', risk: 'high' },
  'issue.assign': { tier: 'T1', risk: 'low' },
  // Public text under the operator's account.
  'issue.comment': { tier: 'T1', risk: 'medium' },
  // Contributor-facing and public, but a person can reopen it.
  'pr.close': { tier: 'T1', risk: 'high' },
  // Model-authored suggestion blocks a maintainer can commit with one click.
  'pr.review.inline': { tier: 'T2', risk: 'high' },
  // Retired (never executed); kept so old audit records parse. pr.review could approve.
  'pr.comment': { tier: 'T1', risk: 'medium' },
  'pr.review': { tier: 'T1', risk: 'critical' },
};

const RANK: Readonly<Record<Tier, number>> = { T0: 0, T1: 1, T2: 2, T3: 3 };

export function tierRank(t: Tier): number {
  return RANK[t];
}

/** The highest tier among these actions; T0 when there are none. */
export function highestTier(actions: readonly BrokerActionType[]): Tier {
  let best: Tier = 'T0';
  for (const a of actions)
    if (RANK[ACTION_REGISTRY[a].tier] > RANK[best]) best = ACTION_REGISTRY[a].tier;
  return best;
}
