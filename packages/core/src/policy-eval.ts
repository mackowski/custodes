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

  if (!agent.repos.includes(req.action.repo)) {
    return { allow: false, code: 'policy_denied', reason: `repo ${req.action.repo} not allowed` };
  }
  if (!agent.actions.includes(req.action.type)) {
    return { allow: false, code: 'policy_denied', reason: `action ${req.action.type} not allowed` };
  }
  const needsApproval = agent.mode === 'hitl' || agent.requiresApproval.includes(req.action.type);
  return { allow: true, needsApproval };
}
