import type { BrokerRequest, Policy } from '@custodes/schema';

export type PolicyDecision =
  | { allow: true; needsApproval: boolean }
  | { allow: false; code: 'unknown_agent' | 'policy_denied'; reason: string };

/**
 * Pure policy check. Kill switch, approval validation and rate limits are separate steps in
 * the broker so each can be tested and audited on its own.
 */
export function evaluatePolicy(policy: Policy, req: BrokerRequest): PolicyDecision {
  const agent = policy.agents[req.agentId];
  if (!agent)
    return { allow: false, code: 'unknown_agent', reason: `no policy for agent ${req.agentId}` };

  // Defence in depth: read-only agents normally have no policy entry at all, but if one is added
  // by mistake it still grants nothing.
  if (agent.mode === 'readonly') {
    return { allow: false, code: 'policy_denied', reason: `agent ${req.agentId} is read-only` };
  }

  if (!agent.repos.includes(req.action.repo)) {
    return { allow: false, code: 'policy_denied', reason: `repo ${req.action.repo} not allowed` };
  }
  if (!agent.actions.includes(req.action.type)) {
    return { allow: false, code: 'policy_denied', reason: `action ${req.action.type} not allowed` };
  }
  if (
    agent.labels !== undefined &&
    (req.action.type === 'issue.label.add' || req.action.type === 'issue.label.remove')
  ) {
    const allowed = agent.labels;
    const other = req.action.labels.find((l) => !allowed.includes(l));
    if (other !== undefined)
      return { allow: false, code: 'policy_denied', reason: `label ${other} not allowed` };
  }
  const needsApproval =
    agent.mode === 'hitl' ||
    agent.requiresApproval.includes(req.action.type) ||
    (agent.requiresApprovalOn[req.action.repo]?.includes(req.action.type) ?? false);
  return { allow: true, needsApproval };
}
