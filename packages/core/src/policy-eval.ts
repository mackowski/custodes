import {
  isTriggerLabel,
  mayAddTriggerLabel,
  type AgentPolicy,
  type BrokerActionType,
  type BrokerRequest,
  type Policy,
} from '@custodes/schema';

/** Whether this action on this repository waits for a human approval (ADR 0004, ADR 0017). */
export function needsApproval(agent: AgentPolicy, repo: string, type: BrokerActionType): boolean {
  return (
    agent.mode === 'hitl' ||
    agent.requiresApproval.includes(type) ||
    (agent.requiresApprovalOn[repo]?.includes(type) ?? false)
  );
}

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

  // Retired actions are refused whatever a policy lists (`pr.review` could approve a pull request).
  if (req.action.type === 'pr.review' || req.action.type === 'pr.comment') {
    return { allow: false, code: 'policy_denied', reason: `action ${req.action.type} is retired` };
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
  // Defence in depth for ADR 0024: the schema already refuses an ungranted trigger label in
  // `labels`, but adding one starts automation as the operator, so check the request too.
  if (req.action.type === 'issue.label.add') {
    const trigger = req.action.labels.find(
      (l) => isTriggerLabel(l) && !mayAddTriggerLabel(req.agentId, l),
    );
    if (trigger !== undefined)
      return { allow: false, code: 'policy_denied', reason: `label ${trigger} starts automation` };
  }
  return { allow: true, needsApproval: needsApproval(agent, req.action.repo, req.action.type) };
}
