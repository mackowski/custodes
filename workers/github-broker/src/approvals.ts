import {
  canonicalJson,
  evaluatePolicy,
  KillSwitch,
  parseApprovalToken,
  sha256Hex,
} from '@custodes/core';
import type { ApprovalRequest, BrokerRequest, BrokerResponse } from '@custodes/schema';
import { act } from './act.js';
import { keyring, type BrokerEnv } from './env.js';
import { policy } from './policy.js';
import { ApprovalStore } from './store.js';

/**
 * Human approval of one side effect (ADR 0004, ADR 0017 amendment):
 * - an agent whose action came back `approval_required` asks for an approval and gets a link token
 *   bound to that exact action (agent entrypoint);
 * - the operator opens the link behind Access and decides (admin entrypoint, gateway only);
 * - on approval the broker runs the stored request itself through `act()`, so what runs is what
 *   was shown, and the agent never needs to come back.
 */
export const APPROVAL_TTL_SECONDS = 86_400;
/** Pending requests per agent: a looping agent cannot flood the operator's queue. */
export const MAX_PENDING_PER_AGENT = 20;

export type CreateApprovalResult =
  | { ok: true; approval: ApprovalRequest; token: string }
  | { ok: false; status: 403 | 404; error: string };

export async function createApproval(
  env: BrokerEnv,
  req: BrokerRequest,
  rationale: string,
  now = new Date(),
): Promise<CreateApprovalResult> {
  if (!policy.agents[req.agentId]) return { ok: false, status: 404, error: 'unknown agent' };
  // Only for an action the policy allows and that really needs an approval: an agent cannot park
  // arbitrary requests in the operator's queue.
  const decision = evaluatePolicy(policy, req);
  if (!decision.allow) return { ok: false, status: 403, error: decision.reason };
  if (!decision.needsApproval)
    return { ok: false, status: 403, error: 'this action needs no approval' };
  if ((await new KillSwitch(env.KILL_SWITCH).state(req.agentId)).halted)
    return { ok: false, status: 403, error: 'agent is halted' };
  const store = new ApprovalStore(env.AUDIT);
  if ((await store.countPending(req.agentId, now)) >= MAX_PENDING_PER_AGENT)
    return { ok: false, status: 403, error: 'too many pending approvals' };
  // Only what the page shows gets posted: `onBehalfOf` would add a mention to the public trailer
  // that the operator never saw, so it is not carried into an approval.
  const { approvalId: _ignored, onBehalfOf: _notShown, ...request } = req;
  const actionHash = await sha256Hex(canonicalJson(req.action));
  const approval = await store.create(request, rationale, actionHash, APPROVAL_TTL_SECONDS, now);
  // A newer request for the same pull request or issue replaces the older ones. After the insert,
  // so two requests at once at worst reject each other (fail closed) instead of both staying live.
  const superseded = await store.supersedePending(
    req.agentId,
    targetOf(req.action),
    approval.id,
    now,
  );
  const token = await keyring(env).approvalToken(
    { approvalId: approval.id, agentId: approval.agentId, actionHash },
    APPROVAL_TTL_SECONDS,
    now.getTime(),
  );
  console.log(
    JSON.stringify({
      event: 'broker.approval.requested',
      approvalId: approval.id,
      agentId: approval.agentId,
      action: req.action.type,
      repo: req.action.repo,
      superseded,
    }),
  );
  return { ok: true, approval, token };
}

/** What an action is about: one pull request or issue of one repository. */
export function targetOf(action: BrokerRequest['action']): { repo: string; number: number } {
  return { repo: action.repo, number: 'pull' in action ? action.pull : action.issue };
}

export type TokenLookup =
  | { ok: true; approval: ApprovalRequest }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad_signature' | 'not_found' };

/** The approval a link token names, if the token is valid for that approval's exact action. */
export async function approvalByToken(
  env: BrokerEnv,
  token: string,
  now = new Date(),
): Promise<TokenLookup> {
  const parsed = parseApprovalToken(token);
  if (!parsed.ok) return parsed;
  const store = new ApprovalStore(env.AUDIT);
  const stored = await store.get(parsed.approvalId);
  if (!stored) return { ok: false, reason: 'not_found' };
  const check = await keyring(env).checkApprovalToken(
    token,
    { approvalId: stored.id, agentId: stored.agentId, actionHash: stored.actionHash },
    now.getTime(),
  );
  if (!check.ok) return check;
  // Show the copy that would run, and only if it is the action the token is bound to.
  const request = await store.requestOf(stored.id);
  if (!request || (await sha256Hex(canonicalJson(request.action))) !== stored.actionHash)
    return { ok: false, reason: 'not_found' };
  const { actionHash: _h, consumedAt: _c, ...approval } = stored;
  return { ok: true, approval: { ...approval, action: request.action } };
}

export type DecideOutcome =
  | { result: 'not_found' | 'not_pending' | 'expired' }
  | { result: 'ok'; decision: 'rejected' }
  | { result: 'ok'; decision: 'approved'; executed: BrokerResponse };

/** Records the decision; on approval runs the stored request once, through the full pipeline. */
export async function decideApproval(
  env: BrokerEnv,
  id: string,
  decision: 'approved' | 'rejected',
  by: string,
  now = new Date(),
): Promise<DecideOutcome> {
  const store = new ApprovalStore(env.AUDIT);
  const result = await store.decide(id, decision, by, now);
  if (result !== 'ok') return { result };
  console.log(JSON.stringify({ event: 'broker.approval.decided', approvalId: id, decision }));
  if (decision === 'rejected') return { result, decision };
  const request = await store.requestOf(id);
  let executed: BrokerResponse;
  try {
    executed = request
      ? await act(env, { ...request, approvalId: id }, now)
      : { ok: false, code: 'approval_invalid', reason: 'stored request is missing' };
  } finally {
    // Single shot: an approval that did not post (halted, rate limit, error) cannot be spent later.
    await store.consume(id, now);
  }
  return { result, decision, executed };
}
