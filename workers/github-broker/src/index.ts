import { Hono } from 'hono';
import { z } from 'zod';
import { canonicalJson, sha256Hex } from '@custodes/core';
import { AgentId, BrokerRequest } from '@custodes/schema';
import { act } from './act.js';
import { keyring, type BrokerEnv } from './env.js';

export { Keyring } from './keyring.js';
import { policy } from './policy.js';
import { ApprovalStore, AuditStore } from './store.js';

/**
 * Not internet-facing (workers_dev=false, no routes). Callers are the agents Worker and the
 * gateway Worker over service bindings. The gateway performs Access authentication before
 * forwarding any admin call here.
 */
const app = new Hono<{ Bindings: BrokerEnv }>();

app.get('/healthz', (c) => c.json({ ok: true, agents: Object.keys(policy.agents) }));

app.post('/v1/act', async (c) => {
  const parsed = BrokerRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ ok: false, code: 'invalid', reason: parsed.error.message }, 400);
  return c.json(await act(c.env, parsed.data));
});

const CreateApproval = z.object({
  request: BrokerRequest,
  rationale: z.string().max(4000),
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(7 * 86400)
    .default(86400),
});
app.post('/v1/approvals', async (c) => {
  const parsed = CreateApproval.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const { request, rationale, ttlSeconds } = parsed.data;
  if (!policy.agents[request.agentId]) return c.json({ error: 'unknown agent' }, 404);
  const hash = await sha256Hex(canonicalJson(request.action));
  return c.json(
    await new ApprovalStore(c.env.AUDIT).create(request, rationale, hash, ttlSeconds),
    201,
  );
});

app.get('/v1/approvals', async (c) =>
  c.json(await new ApprovalStore(c.env.AUDIT).listPending(100)),
);
app.get('/v1/approvals/:id', async (c) => {
  const a = await new ApprovalStore(c.env.AUDIT).get(c.req.param('id'));
  return a ? c.json(a) : c.json({ error: 'not found' }, 404);
});

const Decide = z.object({
  decision: z.enum(['approved', 'rejected']),
  by: z.string().min(1).max(200),
});
app.post('/v1/approvals/:id/decide', async (c) => {
  const parsed = Decide.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const result = await new ApprovalStore(c.env.AUDIT).decide(
    c.req.param('id'),
    parsed.data.decision,
    parsed.data.by,
  );
  return c.json({ result }, result === 'ok' ? 200 : 409);
});

app.get('/v1/attestations/:id', async (c) => {
  const att = await new AuditStore(c.env.AUDIT).get(c.req.param('id'));
  return att ? c.json(att) : c.json({ error: 'not found' }, 404);
});

app.get('/v1/attestations', async (c) => {
  const agent = c.req.query('agent');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  if (agent !== undefined && !AgentId.safeParse(agent).success)
    return c.json({ error: 'bad agent id' }, 400);
  return c.json(await new AuditStore(c.env.AUDIT).list(agent, limit));
});

/** Public keys (active and retired) for verification. Private halves never leave the Keyring. */
app.get('/v1/keys', async (c) => c.json(await keyring(c.env).publicKeys()));

/** Rotate an agent's signing key. Reached only through the Access-protected gateway. */
app.post('/v1/keys/:agent/rotate', async (c) => {
  const agent = c.req.param('agent');
  if (!AgentId.safeParse(agent).success || !policy.agents[agent])
    return c.json({ error: 'unknown agent' }, 404);
  const entry = await keyring(c.env).rotate(agent);
  console.log(JSON.stringify({ event: 'keyring.rotated', agentId: agent, keyId: entry.keyId }));
  return c.json(entry, 201);
});

export default app;
