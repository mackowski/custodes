import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { z } from 'zod';
import { AgentId, BrokerReadRequest, BrokerRequest } from '@custodes/schema';
import { act } from './act.js';
import { approvalByToken, createApproval, decideApproval } from './approvals.js';
import { read } from './read.js';
import { keyring, type BrokerEnv } from './env.js';

export { Keyring } from './keyring.js';
import { policy } from './policy.js';
import { ApprovalStore, AuditStore } from './store.js';

/**
 * Not internet-facing (workers_dev=false, no routes). Two entrypoints, so who may call what is
 * fixed by the service bindings, not by trust in the caller (ADR 0017 amendment):
 * - the default one, bound by the agents Worker: act, read, and asking for an approval;
 * - `BrokerAdmin`, bound only by the gateway, which authenticates with Access first: deciding
 *   approvals, the audit log and keys. An agent cannot approve its own request.
 */
type App = Hono<{ Bindings: BrokerEnv }>;

// ---------- Agents (default entrypoint) ----------
export const agentApp: App = new Hono();

agentApp.get('/healthz', (c) => c.json({ ok: true, agents: Object.keys(policy.agents) }));

agentApp.post('/v1/act', async (c) => {
  const parsed = BrokerRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ ok: false, code: 'invalid', reason: parsed.error.message }, 400);
  // An approved action is run by the broker when the operator decides; an agent never spends
  // an approval itself.
  if (parsed.data.approvalId !== undefined)
    return c.json(
      { ok: false, code: 'invalid', reason: 'approved actions are run by the broker' },
      400,
    );
  return c.json(await act(c.env, parsed.data));
});

/** GET-only, allow-listed GitHub reads for agents (ADR 0009). */
agentApp.post('/v1/read', async (c) => {
  const parsed = BrokerReadRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ ok: false, code: 'invalid', reason: parsed.error.message }, 400);
  return c.json(await read(c.env, parsed.data));
});

const CreateApproval = z.object({
  request: BrokerRequest,
  /** Shown to the operator. Untrusted: may contain model output. */
  rationale: z.string().max(4000),
});
/** Asks for an approval of one action; the answer carries the link token for the operator. */
agentApp.post('/v1/approvals', async (c) => {
  const parsed = CreateApproval.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const out = await createApproval(c.env, parsed.data.request, parsed.data.rationale);
  return out.ok
    ? c.json({ approval: out.approval, token: out.token }, 201)
    : c.json({ error: out.error }, out.status);
});

// ---------- Admin (BrokerAdmin entrypoint, gateway only) ----------
export const adminApp: App = new Hono();

adminApp.get('/healthz', (c) => c.json({ ok: true }));

adminApp.get('/v1/approvals', async (c) =>
  c.json(await new ApprovalStore(c.env.AUDIT).listPending(100)),
);

/** The approval a link token names, for the confirmation page. Reading never decides. */
adminApp.get('/v1/approvals/token/:token', async (c) => {
  const found = await approvalByToken(c.env, c.req.param('token'));
  return found.ok ? c.json(found.approval) : c.json({ error: found.reason }, 404);
});

const Decide = z.object({
  decision: z.enum(['approved', 'rejected']),
  by: z.string().min(1).max(200),
});

/** Decides through a link token: the token must be valid for the stored approval's action. */
adminApp.post('/v1/approvals/token/:token/decide', async (c) => {
  const parsed = Decide.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const found = await approvalByToken(c.env, c.req.param('token'));
  if (!found.ok) return c.json({ error: found.reason }, 404);
  const out = await decideApproval(c.env, found.approval.id, parsed.data.decision, parsed.data.by);
  return c.json(out, out.result === 'ok' ? 200 : 409);
});

adminApp.get('/v1/approvals/:id', async (c) => {
  const a = await new ApprovalStore(c.env.AUDIT).get(c.req.param('id'));
  return a ? c.json(a) : c.json({ error: 'not found' }, 404);
});

/**
 * Rejects by id (the operator CLI, behind Access). Approving needs the link: its page shows what
 * will be posted, the id alone does not.
 */
adminApp.post('/v1/approvals/:id/decide', async (c) => {
  const parsed = Decide.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  if (parsed.data.decision !== 'rejected')
    return c.json({ error: 'approve through the e-mailed link, which shows the action' }, 400);
  const out = await decideApproval(c.env, c.req.param('id'), parsed.data.decision, parsed.data.by);
  return c.json(out, out.result === 'ok' ? 200 : 409);
});

adminApp.get('/v1/attestations/:id', async (c) => {
  const att = await new AuditStore(c.env.AUDIT).get(c.req.param('id'));
  return att ? c.json(att) : c.json({ error: 'not found' }, 404);
});

adminApp.get('/v1/attestations', async (c) => {
  const agent = c.req.query('agent');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  if (agent !== undefined && !AgentId.safeParse(agent).success)
    return c.json({ error: 'bad agent id' }, 400);
  return c.json(await new AuditStore(c.env.AUDIT).list(agent, limit));
});

/** Public keys (active and retired) for verification. Private halves never leave the Keyring. */
adminApp.get('/v1/keys', async (c) => c.json(await keyring(c.env).publicKeys()));

/** Rotate an agent's signing key. Reached only through the Access-protected gateway. */
adminApp.post('/v1/keys/:agent/rotate', async (c) => {
  const agent = c.req.param('agent');
  if (!AgentId.safeParse(agent).success || !policy.agents[agent])
    return c.json({ error: 'unknown agent' }, 404);
  const entry = await keyring(c.env).rotate(agent);
  console.log(JSON.stringify({ event: 'keyring.rotated', agentId: agent, keyId: entry.keyId }));
  return c.json(entry, 201);
});

/** Bound only by the gateway (`entrypoint: "BrokerAdmin"` in its wrangler.jsonc). */
export class BrokerAdmin extends WorkerEntrypoint {
  override fetch(request: Request): Response | Promise<Response> {
    return adminApp.fetch(request, this.env, this.ctx);
  }
}

export default {
  fetch: (request, env, ctx) => agentApp.fetch(request, env, ctx),
} satisfies ExportedHandler<BrokerEnv>;
