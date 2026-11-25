import {
  buildAuditRecord,
  canonicalJson,
  commentProblem,
  evaluatePolicy,
  KillSwitch,
  sha256Hex,
} from '@custodes/core';
import {
  appendTrailers,
  executeAction,
  GitHubApiError,
  GitHubRest,
  PatIdentity,
} from '@custodes/github';
import {
  isTriggerLabel,
  numberOf,
  TRIGGER_LABEL_DAILY_CAP,
  type Attestation,
  type AuditDecision,
  type AuditRecord,
  type BrokerDenialCode,
  type BrokerRequest,
  type BrokerResponse,
  type CallerSignature,
} from '@custodes/schema';
import { keyring, secretBinding, type BrokerEnv } from './env.js';
import {
  commentBody,
  namedBy,
  readIssueThread,
  readPullThread,
  strangerProblem,
} from './thread.js';
import { policy } from './policy.js';
import { ApprovalStore, AuditStore, EXECUTION_FAILED } from './store.js';

/**
 * The broker pipeline for one requested side effect:
 *   validate → policy → kill switch → approval → rate limit → execute → audit + attest.
 * Every branch for a known agent, including denials, produces a signed audit record.
 */
export async function act(
  env: BrokerEnv,
  req: BrokerRequest,
  now = new Date(),
  /** The agent Worker's signature over `req` (per-agent entrypoints, ADR 0018); kept in every record. */
  callerSignature?: CallerSignature,
): Promise<BrokerResponse> {
  const signed = callerSignature !== undefined ? { callerSignature } : {};
  const audit = new AuditStore(env.AUDIT);
  const approvals = new ApprovalStore(env.AUDIT);

  const attest = async (record: AuditRecord): Promise<Attestation> => {
    const { keyId, signature } = await keyring(env).sign(record.agentId, canonicalJson(record));
    const att: Attestation = { record, keyId, signature };
    await audit.insert(att);
    return att;
  };

  /**
   * Attests a record written after GitHub was already called. The action (or part of it) is live
   * whatever happens here, so a failure to sign or store must not become a 500: the agent would
   * read that as "nothing happened" and might repeat the action. One retry, then a log line with
   * ids only and a halt of that agent; the answer to the agent stays the truth about GitHub.
   */
  const attestAfterExecution = async (record: AuditRecord): Promise<void> => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await attest(record);
        return;
      } catch {
        // A write can be applied although the call reported an error; then the retry would hit
        // the primary key and look like a loss.
        if (await audit.get(record.id).catch(() => null)) return;
        if (attempt < 2) continue;
        console.error(
          JSON.stringify({
            event: 'broker.audit.lost',
            attestationId: record.id,
            agentId: record.agentId,
            action: record.action.type,
            repo: record.action.repo,
            decision: record.decision,
          }),
        );
        // No audit trail means no rate limit either (it counts audit rows): stop this agent until
        // an operator has looked. The halt flag lives in KV, so it does not need the store that
        // just failed.
        try {
          await new KillSwitch(env.KILL_SWITCH).halt(
            record.agentId,
            'audit record could not be stored',
            'broker',
          );
        } catch {
          // Nothing more to do here; the log line above is the alarm.
        }
      }
    }
  };

  const deny = async (
    code: BrokerDenialCode,
    reason: string,
    decision: AuditDecision = 'denied',
  ): Promise<BrokerResponse> => {
    // Unknown agents get no key (that would let garbage requests mint keys); log and return.
    if (!policy.agents[req.agentId]) {
      console.warn(
        JSON.stringify({
          event: 'broker.deny',
          code,
          reason,
          agentId: req.agentId,
          runId: req.runId,
        }),
      );
      return { ok: false, code, reason };
    }
    const record = await buildAuditRecord({ request: req, decision, reason, now, ...signed });
    await attest(record);
    return { ok: false, code, reason, attestationId: record.id };
  };

  const decision = evaluatePolicy(policy, req);
  if (!decision.allow) return deny(decision.code, decision.reason);
  const agentPolicy = policy.agents[req.agentId];
  if (!agentPolicy) return deny('unknown_agent', 'no policy');

  const ks = new KillSwitch(env.KILL_SWITCH);
  const halt = await ks.state(req.agentId);
  if (halt.halted) return deny('halted', halt.reason ?? 'halted', 'halted');

  if (decision.needsApproval) {
    if (!req.approvalId) return deny('approval_required', 'this action needs a human approval');
    const approval = await approvals.get(req.approvalId);
    const actionHash = await sha256Hex(canonicalJson(req.action));
    if (!approval) return deny('approval_invalid', 'approval not found');
    if (approval.agentId !== req.agentId)
      return deny('approval_invalid', 'approval belongs to another agent');
    // A bundle (ADR 0019) covers each of its actions; the token was bound to the whole bundle.
    const covered = approval.bundle
      ? (
          await Promise.all(approval.bundle.actions.map((a) => sha256Hex(canonicalJson(a))))
        ).includes(actionHash)
      : approval.actionHash === actionHash;
    if (!covered) return deny('approval_invalid', 'approval was for a different action');
    if (approval.status !== 'approved')
      return deny('approval_invalid', `approval status is ${approval.status}`);
    if (new Date(approval.expiresAt) < now) return deny('approval_invalid', 'approval expired');
    if (approval.bundle) {
      // Consumed once by runBundle after its last action, not per action.
      if (approval.consumedAt !== null) return deny('approval_invalid', 'approval already used');
    } else if (!(await approvals.consume(req.approvalId, now)))
      return deny('approval_invalid', 'approval already used');
  }

  const used = await audit.usedThisHour(req.agentId, req.action.repo, now);
  if (used >= agentPolicy.rateLimitPerHour) {
    return deny(
      'policy_denied',
      `rate limit of ${agentPolicy.rateLimitPerHour}/h on ${req.action.repo} reached`,
    );
  }

  // ADR 0024: a trigger label starts automation as the operator; cap it per agent and repository.
  const capped = await triggerLabelCapped(env, req.agentId, [req.action], now);
  if (capped !== null) return deny('policy_denied', capped);

  // ADR 0024: the comment rules on every path. The mention rule below reads `@` only, so a
  // character reference (`&#64;x` renders as `@x`) or a hidden comment would slip past it; links
  // and other-repository references put model text in someone else's timeline under the
  // operator's name. pr-gate's pr.close keeps links: its code-built close comment links
  // CONTRIBUTING.md (operator decision, 2026-11-25).
  const body = commentBody(req.action);
  if (body !== null) {
    const problem = commentProblem(body, req.action.repo);
    // pr-gate only: any other agent's close text may come from a model (CI review of #165).
    const linksAllowed = req.action.type === 'pr.close' && req.agentId === 'pr-gate';
    if (
      problem !== null &&
      !(linksAllowed && (problem === 'link' || problem === 'other_repository'))
    )
      return deny('policy_denied', `comment refused: ${problem.replace('_', ' ')}`);
  }

  // ADR 0024: an action names only thread people (or, in text, listed maintainers), hotl included.
  // issue.close always reads the issue: GitHub's issue endpoints accept a pull request number, and
  // closing one is pr.close's grant, not issue.close's. A runtime write carries the snapshot the
  // agent read, and runs only if the target still matches it (ADR 0023). A failed read refuses.
  if (
    req.action.type === 'issue.close' ||
    req.snapshot !== undefined ||
    namedBy(req.action).length > 0
  ) {
    const problem = await threadProblem(env, req);
    if (problem !== null) return deny('policy_denied', problem);
  }

  // Execute. The attestation id is fixed up front so the trailer can reference it.
  const attestationId = crypto.randomUUID();
  const identity = new PatIdentity(req.agentId, secretBinding(env, agentPolicy.tokenBinding));
  const api = new GitHubRest(identity);
  let githubUrl: string | undefined;
  try {
    const result = await executeAction(api, req.action, (body) =>
      appendTrailers(body, {
        agentId: req.agentId,
        agentVersion: req.agentVersion,
        attestationId,
        verifyUrl: env.VERIFY_URL,
        visibility: agentPolicy.trailer,
      }),
    );
    githubUrl = result.githubUrl;
  } catch (err) {
    // Execution started, so part of the action may be live (pr.close posts its comment before
    // closing). Record it under the id already written into that comment's trailer, so /verify
    // works, and so the rate limit counts it (EXECUTION_FAILED prefix, see countAllowedSince).
    // Status and path only. The record is signed and served by the public /verify, and GitHub's
    // error body is text we do not control.
    const detail =
      err instanceof GitHubApiError
        ? `GitHub ${err.status} on ${err.path}`
        : 'github request failed';
    const reason = `${EXECUTION_FAILED}${detail}`.slice(0, 500);
    const record = await buildAuditRecord({
      request: req,
      decision: 'denied',
      reason,
      now,
      id: attestationId,
      ...signed,
    });
    await attestAfterExecution(record);
    return { ok: false, code: 'github_error', reason, attestationId };
  }

  const record = await buildAuditRecord({
    request: req,
    decision: 'allowed',
    now,
    id: attestationId,
    ...signed,
    ...(githubUrl !== undefined ? { githubUrl } : {}),
  });
  await attestAfterExecution(record);
  return { ok: true, attestationId, ...(githubUrl !== undefined ? { githubUrl } : {}) };
}

/**
 * Why the action may not run on its thread, or null: the target is not what the action is for, it
 * cannot be read, or it names someone neither in the thread nor allowed by the policy. An issue
 * comment may sit on a pull request, so its issue read falls back to the pull request; issue.close
 * never does.
 */
async function threadProblem(env: BrokerEnv, req: BrokerRequest): Promise<string | null> {
  const { repo } = req.action;
  const number = numberOf(req.action);
  // A snapshot names its kind (a pull request's has a head SHA); without one, the action does.
  const pull =
    req.snapshot !== undefined ? 'headSha' in req.snapshot : req.action.type === 'pr.close';
  let thread = pull
    ? await readPullThread(env, req.agentId, req.runId, repo, number)
    : await readIssueThread(env, req.agentId, req.runId, repo, number);
  if (
    !thread.ok &&
    thread.reason === 'not an issue' &&
    req.action.type !== 'issue.close' &&
    req.snapshot === undefined
  )
    thread = await readPullThread(env, req.agentId, req.runId, repo, number);
  if (!thread.ok) return `cannot check the thread: ${thread.reason}`;
  if (req.snapshot !== undefined && canonicalJson(thread.snapshot) !== canonicalJson(req.snapshot))
    return 'stale: the target changed since it was read';
  return strangerProblem(req.action, thread.people);
}

/**
 * Why these actions would pass the trigger-label daily cap (ADR 0024), or null. One definition for
 * `act()` and the bundle pre-check, which must agree or a bundle stops half-way.
 */
export async function triggerLabelCapped(
  env: BrokerEnv,
  agentId: string,
  actions: readonly BrokerRequest['action'][],
  now: Date,
): Promise<string | null> {
  const audit = new AuditStore(env.AUDIT);
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  for (const a of actions) {
    if (a.type !== 'issue.label.add') continue;
    for (const label of a.labels.filter(isTriggerLabel)) {
      if (
        (await audit.countLabelAddsSince(agentId, a.repo, label, since)) >= TRIGGER_LABEL_DAILY_CAP
      )
        return `daily cap of ${TRIGGER_LABEL_DAILY_CAP} for label ${label} on ${a.repo} reached`;
    }
  }
  return null;
}
