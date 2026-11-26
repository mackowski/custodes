import {
  isTriggerLabel,
  mayAddTriggerLabel,
  type AgentPolicy,
  type BrokerAction,
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

  const denial = actionDenial(req.agentId, agent, req.action);
  if (denial !== undefined) return { allow: false, code: 'policy_denied', reason: denial };
  return { allow: true, needsApproval: needsApproval(agent, req.action.repo, req.action.type) };
}

/**
 * Why this agent's policy refuses this action, or undefined. One definition for the broker and the
 * runtime's dispatcher (ADR 0023), so a policy rule cannot land in one copy only.
 */
export function actionDenial(
  agentId: string,
  agent: AgentPolicy,
  action: BrokerAction,
): string | undefined {
  // Retired actions are refused whatever a policy lists (`pr.review` could approve a pull request).
  if (action.type === 'pr.review' || action.type === 'pr.comment')
    return `action ${action.type} is retired`;
  if (!agent.repos.includes(action.repo)) return `repo ${action.repo} not allowed`;
  if (!agent.actions.includes(action.type)) return `action ${action.type} not allowed`;
  if (
    agent.labels !== undefined &&
    (action.type === 'issue.label.add' || action.type === 'issue.label.remove')
  ) {
    const allowed = agent.labels;
    const other = action.labels.find((l) => !allowed.includes(l));
    if (other !== undefined) return `label ${other} not allowed`;
  }
  // Defence in depth for ADR 0024: the schema already refuses an ungranted trigger label in
  // `labels`, but adding one starts automation as the operator, so check the request too.
  if (action.type === 'issue.label.add') {
    const trigger = action.labels.find((l) => isTriggerLabel(l) && !mayAddTriggerLabel(agentId, l));
    if (trigger !== undefined) return `label ${trigger} starts automation`;
  }
  return undefined;
}
