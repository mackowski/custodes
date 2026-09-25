import {
  buildAuditRecord,
  canonicalJson,
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
import type {
  Attestation,
  AuditDecision,
  AuditRecord,
  BrokerDenialCode,
  BrokerRequest,
  BrokerResponse,
} from '@custodes/schema';
import { keyring, secretBinding, type BrokerEnv } from './env.js';
import { policy } from './policy.js';
import { ApprovalStore, AuditStore } from './store.js';

/**
 * The broker pipeline for one requested side effect:
 *   validate → policy → kill switch → approval → rate limit → execute → audit + attest.
 * Every branch for a known agent, including denials, produces a signed audit record.
 */
export async function act(
  env: BrokerEnv,
  req: BrokerRequest,
  now = new Date(),
): Promise<BrokerResponse> {
  const audit = new AuditStore(env.AUDIT);
  const approvals = new ApprovalStore(env.AUDIT);

  const attest = async (record: AuditRecord): Promise<Attestation> => {
    const { keyId, signature } = await keyring(env).sign(record.agentId, canonicalJson(record));
    const att: Attestation = { record, keyId, signature };
    await audit.insert(att);
    return att;
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
    const record = await buildAuditRecord({ request: req, decision, reason, now });
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
    if (approval.actionHash !== actionHash)
      return deny('approval_invalid', 'approval was for a different action');
    if (approval.status !== 'approved')
      return deny('approval_invalid', `approval status is ${approval.status}`);
    if (!(await approvals.consume(req.approvalId, now)))
      return deny('approval_invalid', 'approval already used');
  }

  const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
  if ((await audit.countAllowedSince(req.agentId, hourAgo)) >= agentPolicy.rateLimitPerHour) {
    return deny('policy_denied', `rate limit of ${agentPolicy.rateLimitPerHour}/h reached`);
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
        ...(req.onBehalfOf !== undefined ? { onBehalfOf: req.onBehalfOf } : {}),
      }),
    );
    githubUrl = result.githubUrl;
  } catch (err) {
    const reason = err instanceof GitHubApiError ? err.message : 'github request failed';
    return deny('github_error', reason);
  }

  const record = await buildAuditRecord({
    request: req,
    decision: 'allowed',
    now,
    id: attestationId,
    ...(githubUrl !== undefined ? { githubUrl } : {}),
  });
  await attest(record);
  return { ok: true, attestationId, ...(githubUrl !== undefined ? { githubUrl } : {}) };
}
