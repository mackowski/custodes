import { KillSwitch } from '@custodes/core';
import { buildReadPath, GitHubReadClient, PatIdentity } from '@custodes/github';
import type { BrokerReadRequest, BrokerReadResponse } from '@custodes/schema';
import { secretBinding, type BrokerEnv } from './env.js';
import { policy } from './policy.js';

/**
 * Agent reads: policy (agent + repo + resource allow-list) → kill switch → GET with the read-only token.
 * Reads have no side effects, so they are logged but not attested.
 */
export async function read(
  env: BrokerEnv,
  req: BrokerReadRequest,
  fetchImpl?: typeof fetch,
): Promise<BrokerReadResponse> {
  const rp = policy.reads[req.agentId];
  if (!rp)
    return { ok: false, code: 'unknown_agent', reason: `no read policy for agent ${req.agentId}` };
  if (!rp.repos.includes(req.repo))
    return { ok: false, code: 'policy_denied', reason: `repo ${req.repo} not allowed` };
  if (!rp.resources.includes(req.resource))
    return { ok: false, code: 'policy_denied', reason: `resource ${req.resource} not allowed` };
  const halt = await new KillSwitch(env.KILL_SWITCH).state(req.agentId);
  if (halt.halted) return { ok: false, code: 'halted', reason: halt.reason ?? 'halted' };

  const path = buildReadPath(req);
  const client = new GitHubReadClient(
    new PatIdentity(req.agentId, secretBinding(env, rp.tokenBinding)),
    fetchImpl,
  );
  const result = await client.get(path);
  console.log(
    JSON.stringify({
      event: 'broker.read',
      agentId: req.agentId,
      runId: req.runId,
      resource: req.resource,
      repo: req.repo,
      ...(req.number !== undefined ? { number: req.number } : {}),
      ok: result.ok,
      ...(result.ok ? {} : { status: result.status }),
    }),
  );
  if (result.ok) return { ok: true, data: result.data };
  return {
    ok: false,
    code: 'github_error',
    reason: `GitHub ${result.status} on ${req.resource}`,
    status: result.status,
    rateLimited: result.rateLimited,
  };
}
