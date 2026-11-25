import type { BrokerAction, Policy, Proposal, TargetRead } from '@custodes/schema';
import { canonicalJson } from '../canonical.js';
import { needsApproval } from '../policy-eval.js';

/**
 * Where one proposed action goes (ADR 0023). Deterministic: the model's only say is `needsHuman`,
 * which can raise an action to an approval and never lower one.
 */
export type Route =
  | { action: BrokerAction; route: 'digest' | 'approval' | 'act' }
  | { action: BrokerAction; route: 'drop'; reason: string };

/** Re-verifies the evidence an action needs through the broker (e.g. a merged PR for a close). */
export type EvidenceChecker = (
  action: BrokerAction,
  proposal: Proposal,
) => Promise<{ ok: true } | { ok: false; reason: string }>;

/** HOTL writes one run may make; later ones wait for an approval (ADR 0023). */
export const MAX_HOTL_WRITES_PER_RUN = 10;

export interface DispatchInput {
  policy: Policy;
  agentId: string;
  proposal: Proposal;
  /** Every target read by a tool in this run, in order. */
  reads: readonly TargetRead[];
  /** HOTL writes this run already routed to `act`. */
  hotlWritesSoFar: number;
  /** Shadow runs (#132 v1) only report. */
  shadow: boolean;
  checkEvidence: EvidenceChecker;
}

function numberOf(a: BrokerAction): number {
  return 'pull' in a ? a.pull : a.issue;
}

/** Routes each action of one proposal, in order. */
export async function routeProposal(input: DispatchInput): Promise<Route[]> {
  const { proposal, policy } = input;
  const t = proposal.target;
  const lastRead = [...input.reads]
    .reverse()
    .find(
      (r) => r.target.repo === t.repo && r.target.kind === t.kind && r.target.number === t.number,
    );
  const agent = policy.agents[input.agentId];
  let hotl = input.hotlWritesSoFar;
  const routes: Route[] = [];

  for (const action of proposal.actions) {
    const drop = (reason: string) => routes.push({ action, route: 'drop', reason });
    // 1. The target was read in this run, and the snapshot is the one that read produced.
    if (!lastRead) {
      drop('target was not read in this run');
      continue;
    }
    if (canonicalJson(lastRead.snapshot) !== canonicalJson(proposal.snapshot)) {
      drop('snapshot differs from the one read in this run');
      continue;
    }
    if (action.repo !== t.repo || numberOf(action) !== t.number) {
      drop('action is about another item than the proposal target');
      continue;
    }
    if (input.shadow || !agent || agent.mode === 'readonly') {
      routes.push({ action, route: 'digest' });
      continue;
    }
    if (!agent.repos.includes(action.repo) || !agent.actions.includes(action.type)) {
      drop('not allowed by policy');
      continue;
    }
    // The label allow-list too, so an injected label never even becomes an approval request.
    if (
      (action.type === 'issue.label.add' || action.type === 'issue.label.remove') &&
      action.labels.some((l) => !(agent.labels ?? []).includes(l))
    ) {
      drop('label not allowed by policy');
      continue;
    }
    // 2. Evidence the action needs, checked again by code.
    const evidence = await input.checkEvidence(action, proposal);
    if (!evidence.ok) {
      drop(evidence.reason);
      continue;
    }
    // 3. Mode from policy; needsHuman only raises; at most MAX_HOTL_WRITES_PER_RUN direct writes.
    if (proposal.needsHuman || needsApproval(agent, action.repo, action.type)) {
      routes.push({ action, route: 'approval' });
    } else if (hotl < MAX_HOTL_WRITES_PER_RUN) {
      hotl++;
      routes.push({ action, route: 'act' });
    } else {
      routes.push({ action, route: 'approval' });
    }
  }
  return routes;
}
