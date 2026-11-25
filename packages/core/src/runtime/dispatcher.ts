import type {
  BrokerAction,
  IssueSnapshot,
  Policy,
  Proposal,
  PullSnapshot,
  TargetRead,
} from '@custodes/schema';
import { actionDenial, needsApproval } from '../policy-eval.js';

/**
 * Where one proposed action goes (ADR 0023). Deterministic: the model's only say is `needsHuman`,
 * which can raise an action to an approval and never lower one. A routed action carries the
 * snapshot code built from this run's read of the target; the model never writes one.
 */
export type Route =
  | {
      action: BrokerAction;
      route: 'digest' | 'approval' | 'act';
      snapshot: IssueSnapshot | PullSnapshot;
    }
  | { action: BrokerAction; route: 'drop'; reason: string };

/** Re-verifies the evidence an action needs through the broker (e.g. a merged PR for a close). */
export type EvidenceChecker = (
  action: BrokerAction,
  proposal: Proposal,
) => Promise<{ ok: true } | { ok: false; reason: string }>;

/** HOTL writes one run tree may make; later ones wait for an approval (ADR 0023). */
export const MAX_HOTL_WRITES_PER_TREE = 10;

export interface DispatchInput {
  policy: Policy;
  agentId: string;
  proposal: Proposal;
  /** Every target read by a tool in this run, in order. */
  reads: readonly TargetRead[];
  /** Shadow runs (#132 v1) only report. */
  shadow: boolean;
  checkEvidence: EvidenceChecker;
  /** The run guard (`runGuard`): throws when the run, its tree, the agent or the fleet is halted. */
  guard: () => Promise<void>;
  /**
   * Takes one of the run tree's MAX_HOTL_WRITES_PER_TREE direct-write slots, counted on the root
   * run in the store (`RunStore.takeHotlSlot`); false once the tree has used them all.
   */
  takeHotlSlot: () => boolean | Promise<boolean>;
}

function numberOf(a: BrokerAction): number {
  return 'pull' in a ? a.pull : a.issue;
}

/**
 * Routes each action of one proposal, in order. Shadow runs go through every check a live run
 * does before they reach the digest, so the shadow digest is what live would do (ADR 0021).
 */
export async function routeProposal(input: DispatchInput): Promise<Route[]> {
  await input.guard();
  const { proposal, policy } = input;
  const t = proposal.target;
  const lastRead = [...input.reads]
    .reverse()
    .find(
      (r) => r.target.repo === t.repo && r.target.kind === t.kind && r.target.number === t.number,
    );
  const agent = policy.agents[input.agentId];
  const live = agent !== undefined && agent.mode !== 'readonly';
  const routes: Route[] = [];

  for (const action of proposal.actions) {
    const drop = (reason: string) => routes.push({ action, route: 'drop', reason });
    // 1. The target was read in this run, and the action is about that target.
    if (!lastRead) {
      drop('target was not read in this run');
      continue;
    }
    if (action.repo !== t.repo || numberOf(action) !== t.number) {
      drop('action is about another item than the proposal target');
      continue;
    }
    const snapshot = lastRead.snapshot;
    // A pull request needs its head SHA in the snapshot (ADR 0024); an issue never has one. GitHub's
    // issue endpoints also take a pull request number, so the closing action must match the kind
    // (checked after the policy, so a refused action keeps the broker's own reason).
    if ((t.kind === 'pull') !== 'headSha' in snapshot) {
      drop('snapshot does not match the target kind');
      continue;
    }
    // 2. The broker's own policy rules (repos, actions, labels, retired actions).
    if (live) {
      const denial = actionDenial(input.agentId, agent, action);
      if (denial !== undefined) {
        drop(denial);
        continue;
      }
    }
    if (
      (action.type === 'issue.close' && t.kind !== 'issue') ||
      (action.type === 'pr.close' && t.kind !== 'pull')
    ) {
      drop('closing action does not match the target kind');
      continue;
    }
    // 3. Evidence the action needs, checked again by code.
    const evidence = await input.checkEvidence(action, proposal);
    if (!evidence.ok) {
      drop(evidence.reason);
      continue;
    }
    if (input.shadow || !live) {
      routes.push({ action, route: 'digest', snapshot });
      continue;
    }
    // 4. Mode from policy; needsHuman only raises; at most MAX_HOTL_WRITES_PER_TREE direct writes.
    if (proposal.needsHuman || needsApproval(agent, action.repo, action.type)) {
      routes.push({ action, route: 'approval', snapshot });
      continue;
    }
    await input.guard();
    routes.push({ action, route: (await input.takeHotlSlot()) ? 'act' : 'approval', snapshot });
  }
  return routes;
}
