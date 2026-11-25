import {
  canonicalJson,
  evaluatePolicy,
  KillSwitch,
  parseApprovalToken,
  sha256Hex,
} from '@custodes/core';
import {
  type ApprovalBundle,
  type ApprovalRequest,
  type BrokerRequest,
  type BrokerResponse,
  type BundleApprovalAsk,
  type BundleStep,
  type DecideOutcome,
  DEFAULT_APPROVAL_TTL_HOURS,
  DEFAULT_MAX_PENDING_APPROVALS,
  isPullBundle,
  type BrokerAction,
} from '@custodes/schema';
import { act } from './act.js';
import {
  allowedPeople,
  commentBody,
  commentProblem,
  namedBy,
  readIssueThread,
  readPullThread,
} from './thread.js';
import { keyring, type BrokerEnv } from './env.js';
import { policy } from './policy.js';
import { ApprovalStore, AuditStore } from './store.js';

/**
 * Human approval of one side effect (ADR 0004, ADR 0017 amendment):
 * - an agent whose action came back `approval_required` asks for an approval and gets a link token
 *   bound to that exact action (agent entrypoint);
 * - the operator opens the link behind Access and decides (admin entrypoint, gateway only);
 * - on approval the broker runs the stored request itself through `act()`, so what runs is what
 *   was shown, and the agent never needs to come back.
 */
export const APPROVAL_TTL_SECONDS = DEFAULT_APPROVAL_TTL_HOURS * 3600;
/** Pending requests per agent: a looping agent cannot flood the operator's queue. */
export const MAX_PENDING_PER_AGENT = DEFAULT_MAX_PENDING_APPROVALS;

/** Bundle approval requests per agent per hour, refused ones included (review L5). */
export const MAX_BUNDLE_ASKS_PER_HOUR = 40;

/** The agent's approval lifetime: its policy's `approvalTtlHours`, else the default. */
export function approvalTtlSeconds(agentId: string): number {
  const hours = policy.agents[agentId]?.approvalTtlHours;
  return hours !== undefined ? hours * 3600 : APPROVAL_TTL_SECONDS;
}
function maxPending(agentId: string): number {
  return policy.agents[agentId]?.maxPendingApprovals ?? MAX_PENDING_PER_AGENT;
}

/** What one approval's token is bound to: the action, or a bundle's actions and snapshot. */
export async function approvalHash(
  action: BrokerRequest['action'],
  bundle?: ApprovalBundle,
): Promise<string> {
  return sha256Hex(
    canonicalJson(bundle ? { actions: bundle.actions, snapshot: bundle.snapshot } : action),
  );
}

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
  // ADR 0019: a bundle-only agent never gets a one-action approval, which would skip the snapshot
  // and the thread-people checks.
  if (policy.agents[req.agentId]?.bundleOnly)
    return { ok: false, status: 403, error: 'this agent asks for bundle approvals only' };
  // Only for an action the policy allows and that really needs an approval: an agent cannot park
  // arbitrary requests in the operator's queue.
  const decision = evaluatePolicy(policy, req);
  if (!decision.allow) return { ok: false, status: 403, error: decision.reason };
  if (!decision.needsApproval)
    return { ok: false, status: 403, error: 'this action needs no approval' };
  if ((await new KillSwitch(env.KILL_SWITCH).state(req.agentId)).halted)
    return { ok: false, status: 403, error: 'agent is halted' };
  return storeApproval(env, req, rationale, undefined, now);
}

/**
 * Asks for one approval of a bundle (ADR 0019): every action must be allowed and need an approval,
 * and the assignee and every @mention must be the issue's author or a commenter right now.
 */
export async function createBundleApproval(
  env: BrokerEnv,
  ask: BundleApprovalAsk,
  now = new Date(),
): Promise<CreateApprovalResult> {
  const { bundle, ...base } = ask.request;
  if (!policy.agents[base.agentId]) return { ok: false, status: 404, error: 'unknown agent' };
  for (const action of bundle.actions) {
    const decision = evaluatePolicy(policy, { ...base, action });
    if (!decision.allow) return { ok: false, status: 403, error: decision.reason };
    if (!decision.needsApproval)
      return { ok: false, status: 403, error: `${action.type} needs no approval` };
  }
  if ((await new KillSwitch(env.KILL_SWITCH).state(base.agentId)).halted)
    return { ok: false, status: 403, error: 'agent is halted' };
  const first = bundle.actions[0];
  if (!first) return { ok: false, status: 403, error: 'empty bundle' };
  // Before the reads: a looping agent must not spend the shared read token on refused requests.
  // Pending alone is not enough: a newer bundle for the same issue supersedes the older one, so a
  // loop on one issue always sees one pending; the hourly count of requests closes that.
  const store = new ApprovalStore(env.AUDIT);
  if ((await store.countPending(base.agentId, now)) >= maxPending(base.agentId))
    return { ok: false, status: 403, error: 'too many pending approvals' };
  if ((await store.recordBundleAsk(base.agentId, now)) > MAX_BUNDLE_ASKS_PER_HOUR)
    return { ok: false, status: 403, error: 'too many approval requests this hour' };
  const check = await checkBundle(env, base.agentId, base.runId, bundle);
  if (!check.ok) return { ok: false, status: 403, error: check.reason };
  return storeApproval(env, { ...base, action: first }, ask.rationale, bundle, now);
}

async function storeApproval(
  env: BrokerEnv,
  req: BrokerRequest,
  rationale: string,
  bundle: ApprovalBundle | undefined,
  now: Date,
): Promise<CreateApprovalResult> {
  const store = new ApprovalStore(env.AUDIT);
  if ((await store.countPending(req.agentId, now)) >= maxPending(req.agentId))
    return { ok: false, status: 403, error: 'too many pending approvals' };
  const { approvalId: _ignored, ...request } = req;
  const actionHash = await approvalHash(req.action, bundle);
  const ttl = approvalTtlSeconds(req.agentId);
  const approval = await store.create(request, rationale, actionHash, ttl, now, bundle);
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
    ttl,
    now.getTime(),
  );
  console.log(
    JSON.stringify({
      event: 'broker.approval.requested',
      approvalId: approval.id,
      agentId: approval.agentId,
      action: req.action.type,
      repo: req.action.repo,
      ...(bundle ? { bundle: bundle.actions.map((a) => a.type) } : {}),
      superseded,
    }),
  );
  return { ok: true, approval, token };
}

/**
 * The bundle against its target now: same snapshot, the shared comment rules, and only thread
 * people or listed maintainers assigned or named (ADR 0019, ADR 0024).
 */
export async function checkBundle(
  env: BrokerEnv,
  agentId: string,
  runId: string,
  bundle: ApprovalBundle,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const first = bundle.actions[0];
  if (!first) return { ok: false, reason: 'empty bundle' };
  const { repo, number } = targetOf(first);
  const thread = isPullBundle(bundle)
    ? await readPullThread(env, agentId, runId, repo, number, fetchImpl)
    : await readIssueThread(env, agentId, runId, repo, number, fetchImpl);
  if (!thread.ok) return thread;
  if (canonicalJson(thread.snapshot) !== canonicalJson(bundle.snapshot))
    return { ok: false, reason: 'stale: the target changed since the proposal' };
  return checkPeopleAndText(bundle.actions, repo, thread.people);
}

/** The comment rules and the people rule for actions on one thread whose people are known. */
export function checkPeopleAndText(
  actions: readonly BrokerAction[],
  repo: string,
  threadPeople: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  const allowed = allowedPeople(repo, threadPeople).map((p) => p.toLowerCase());
  for (const a of actions) {
    const body = commentBody(a);
    if (body !== null) {
      const bad = commentProblem(body, a.repo);
      if (bad !== null) return { ok: false, reason: bad };
    }
    const stranger = namedBy(a).find((l) => !allowed.includes(l.toLowerCase()));
    if (stranger !== undefined)
      return {
        ok: false,
        reason: `@${stranger} is neither in the thread nor a listed maintainer`,
      };
  }
  return { ok: true };
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
  if (!request || (await approvalHash(request.action, stored.bundle)) !== stored.actionHash)
    return { ok: false, reason: 'not_found' };
  const { actionHash: _h, consumedAt: _c, ...approval } = stored;
  return { ok: true, approval: { ...approval, action: request.action } };
}

/** Records the decision; on approval runs the stored request once, through the full pipeline. */
export async function decideApproval(
  env: BrokerEnv,
  id: string,
  decision: 'approved' | 'rejected',
  by: string,
  now = new Date(),
): Promise<DecideOutcome> {
  const store = new ApprovalStore(env.AUDIT);
  // A bundle that does not fit in this hour's rate limit would stop half-way and use up its
  // approval: refuse before deciding, so it stays pending and the operator can approve it later
  // (security review of #113).
  if (decision === 'approved') {
    const pending = await store.get(id);
    const agentPolicy = pending ? policy.agents[pending.agentId] : undefined;
    if (pending?.bundle && agentPolicy) {
      const used = await new AuditStore(env.AUDIT).usedThisHour(
        pending.agentId,
        pending.action.repo,
        now,
      );
      if (used + pending.bundle.actions.length > agentPolicy.rateLimitPerHour)
        return { result: 'rate_limited' };
    }
  }
  const result = await store.decide(id, decision, by, now);
  if (result !== 'ok') return { result };
  console.log(JSON.stringify({ event: 'broker.approval.decided', approvalId: id, decision }));
  if (decision === 'rejected') return { result, decision };
  const request = await store.requestOf(id);
  const bundle = (await store.get(id))?.bundle;
  if (bundle && request) return runBundle(env, store, id, request, bundle, now);
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

/**
 * Runs an approved bundle once (ADR 0019): the issue must still match the snapshot, then the
 * actions run in order and stop at the first failure. The approval is consumed at the end either
 * way, so a bundle that stopped half-way cannot be run again from the same link.
 */
async function runBundle(
  env: BrokerEnv,
  store: ApprovalStore,
  id: string,
  request: BrokerRequest,
  bundle: ApprovalBundle,
  now: Date,
): Promise<DecideOutcome> {
  const steps: BundleStep[] = bundle.actions.map((a) => ({ type: a.type, outcome: 'not_run' }));
  let executed: BrokerResponse = { ok: false, code: 'approval_invalid', reason: 'not run' };
  try {
    const check = await checkBundle(env, request.agentId, request.runId, bundle);
    if (!check.ok) {
      executed = { ok: false, code: 'approval_invalid', reason: check.reason };
      return { result: 'ok', decision: 'approved', executed, steps };
    }
    for (const [i, action] of bundle.actions.entries()) {
      executed = await act(env, { ...request, action, approvalId: id }, now);
      const step = steps[i];
      if (!step) break;
      if (!executed.ok) {
        step.outcome = 'failed';
        step.code = executed.code;
        break;
      }
      step.outcome = 'done';
      if (executed.githubUrl !== undefined) step.githubUrl = executed.githubUrl;
    }
    return { result: 'ok', decision: 'approved', executed, steps };
  } finally {
    await store.consume(id, now);
    console.log(
      JSON.stringify({
        event: 'broker.approval.bundle',
        approvalId: id,
        steps: steps.map((s) => `${s.type}:${s.outcome}`),
      }),
    );
  }
}
