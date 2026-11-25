import {
  DEFAULT_APPROVAL_TTL_HOURS,
  DEFAULT_MAX_PENDING_APPROVALS,
  tierRank,
  type AgentPolicy,
  type Policy,
} from '@custodes/schema';
import { needsApproval } from './policy-eval.js';

/** readonly grants nothing, hitl approves everything, hotl acts on its own. */
const STRICTNESS = { readonly: 2, hitl: 1, hotl: 0 } as const;

/** Own entries only: zod records are plain objects, so `constructor` would hit Object.prototype. */
function own<T>(record: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(record, id) ? record[id] : undefined;
}

function agentViolations(id: string, b: AgentPolicy, p: AgentPolicy): string[] {
  const out: string[] = [];
  const v = (msg: string) => out.push(`agents.${id}: ${msg}`);
  if (p.tokenBinding !== b.tokenBinding) v('tokenBinding differs from the boundary');
  if (tierRank(p.tier) > tierRank(b.tier)) v(`tier ${p.tier} above the boundary's ${b.tier}`);
  if (STRICTNESS[p.mode] < STRICTNESS[b.mode]) v(`mode ${p.mode} is looser than ${b.mode}`);
  for (const r of p.repos) if (!b.repos.includes(r)) v(`repo ${r} not in the boundary`);
  for (const t of p.actions) if (!b.actions.includes(t)) v(`action ${t} not in the boundary`);
  // Wherever the boundary needs an approval, the policy must too (for what it still grants).
  for (const r of p.repos)
    for (const t of p.actions)
      if (
        b.repos.includes(r) &&
        b.actions.includes(t) &&
        needsApproval(b, r, t) &&
        !needsApproval(p, r, t)
      )
        v(`${t} on ${r} needs an approval in the boundary`);
  if (p.rateLimitPerHour > b.rateLimitPerHour)
    v(`rateLimitPerHour ${p.rateLimitPerHour} above ${b.rateLimitPerHour}`);
  if (b.labels !== undefined) {
    if (p.labels === undefined) v('labels allow-list removed (every label allowed)');
    else for (const l of p.labels) if (!b.labels.includes(l)) v(`label ${l} not in the boundary`);
  }
  const ttl = (a: AgentPolicy) => a.approvalTtlHours ?? DEFAULT_APPROVAL_TTL_HOURS;
  if (ttl(p) > ttl(b)) v(`approvalTtlHours ${ttl(p)} above ${ttl(b)}`);
  const pending = (a: AgentPolicy) => a.maxPendingApprovals ?? DEFAULT_MAX_PENDING_APPROVALS;
  if (pending(p) > pending(b)) v(`maxPendingApprovals ${pending(p)} above ${pending(b)}`);
  if (b.trailer === 'visible' && p.trailer !== 'visible')
    v('trailer hidden, boundary says visible');
  if (b.bundleOnly && !p.bundleOnly) v('bundleOnly off, boundary says on');
  return out;
}

/**
 * Every way `policy` grants more than `boundary` (ADR 0022). Empty when the policy is contained.
 * CI only (a vitest test); not exported from the package, so no Worker imports it.
 */
export function boundaryViolations(boundary: Policy, policy: Policy): string[] {
  const out: string[] = [];
  for (const [id, p] of Object.entries(policy.agents)) {
    const b = own(boundary.agents, id);
    if (b === undefined) out.push(`agents.${id}: not in the boundary`);
    else out.push(...agentViolations(id, b, p));
  }
  for (const [id, p] of Object.entries(policy.reads)) {
    const b = own(boundary.reads, id);
    if (b === undefined) {
      out.push(`reads.${id}: not in the boundary`);
      continue;
    }
    if (p.tokenBinding !== b.tokenBinding) out.push(`reads.${id}: tokenBinding differs`);
    for (const r of p.repos)
      if (!b.repos.includes(r)) out.push(`reads.${id}: repo ${r} not in the boundary`);
    for (const r of p.resources)
      if (!b.resources.includes(r)) out.push(`reads.${id}: resource ${r} not in the boundary`);
  }
  // Who agents may ping besides the thread (ADR 0024).
  for (const [repo, logins] of Object.entries(policy.maintainers)) {
    const allowed = (own(boundary.maintainers, repo) ?? []).map((l) => l.toLowerCase());
    for (const l of logins)
      if (!allowed.includes(l.toLowerCase()))
        out.push(`maintainers.${repo}: ${l} not in the boundary`);
  }
  return out;
}
