import { Hono } from 'hono';
import { z } from 'zod';
import {
  importPublicKey,
  KillSwitch,
  verifyApprovalToken,
  verifyAttestation,
} from '@custodes/core';
import { isTrustedSender, parseApprovalAddress } from '@custodes/email';
import { verifyGitHubWebhookSignature } from '@custodes/github';
import {
  AgentId,
  GitHubWebhookEnvelope,
  HaltRequest,
  type AdminActor,
  type InboundEvent,
  type PublicKeyEntry,
} from '@custodes/schema';
import { verifyAccessJwt } from './access.js';
import type { GatewayEnv } from './env.js';

interface Vars {
  actor: AdminActor;
}
const app = new Hono<{ Bindings: GatewayEnv; Variables: Vars }>();

app.get('/healthz', (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));

// ---------- Public: verify an attestation ----------
app.get('/verify/:id', async (c) => {
  const id = c.req.param('id');
  if (!z.uuid().safeParse(id).success) return c.json({ error: 'bad id' }, 400);
  const attRes = await c.env.BROKER.fetch(`https://broker.internal/v1/attestations/${id}`);
  if (attRes.status === 404) return c.json({ error: 'not found' }, 404);
  if (!attRes.ok) return c.json({ error: 'broker unavailable' }, 502);
  const att = await attRes.json<{ keyId: string }>();
  const keysRes = await c.env.BROKER.fetch('https://broker.internal/v1/keys');
  if (!keysRes.ok) return c.json({ error: 'broker unavailable' }, 502);
  const keys = await keysRes.json<PublicKeyEntry[]>();
  const key = keys.find((k) => k.keyId === att.keyId);
  if (!key) return c.json({ valid: false, reason: 'unknown key' });
  const result = await verifyAttestation(att, await importPublicKey(key.jwk));
  return c.json({ valid: result.valid, reason: result.reason, attestation: result.attestation });
});

// ---------- GitHub webhooks (optional per repo; polling is the default) ----------
app.post('/webhooks/github', async (c) => {
  const raw = await c.req.text();
  const ok = await verifyGitHubWebhookSignature(
    c.env.GITHUB_WEBHOOK_SECRET,
    raw,
    c.req.header('x-hub-signature-256'),
  );
  if (!ok) return c.json({ error: 'bad signature' }, 401);
  const event = c.req.header('x-github-event') ?? 'unknown';
  const deliveryId = c.req.header('x-github-delivery') ?? crypto.randomUUID();
  const parsed = GitHubWebhookEnvelope.safeParse(JSON.parse(raw));
  if (!parsed.success) return c.json({ error: 'unsupported payload' }, 400);
  const msg: InboundEvent = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    source: 'github-webhook',
    event,
    deliveryId,
    repo: parsed.data.repository.full_name,
    payload: parsed.data,
  };
  await c.env.INBOUND.send(msg, { contentType: 'json' });
  return c.json({ queued: msg.id }, 202);
});

// ---------- Admin API: Cloudflare Access required ----------
const admin = new Hono<{ Bindings: GatewayEnv; Variables: Vars }>();
admin.use('*', async (c, next) => {
  const actor = await verifyAccessJwt(c.req.raw, c.env.ACCESS_TEAM, c.env.ACCESS_AUD);
  if (!actor) return c.json({ error: 'unauthorized' }, 401);
  c.set('actor', actor);
  await next();
});

admin.get('/whoami', (c) => c.json(c.get('actor')));

admin.get('/agents', async (c) => {
  const res = await c.env.AGENTS.fetch('https://agents.internal/registry');
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
});

admin.post('/agents/:id/halt', async (c) => {
  const id = c.req.param('id');
  if (id !== '*' && !AgentId.safeParse(id).success) return c.json({ error: 'bad agent id' }, 400);
  const body = HaltRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.message }, 400);
  const actor = c.get('actor');
  await new KillSwitch(c.env.KILL_SWITCH).halt(id, body.data.reason, actor.subject);
  console.log(
    JSON.stringify({
      event: 'admin.halt',
      agentId: id,
      by: actor.subject,
      reason: body.data.reason,
    }),
  );
  return c.json({ halted: id });
});

admin.post('/agents/:id/resume', async (c) => {
  const id = c.req.param('id');
  if (id !== '*' && !AgentId.safeParse(id).success) return c.json({ error: 'bad agent id' }, 400);
  await new KillSwitch(c.env.KILL_SWITCH).resume(id);
  console.log(JSON.stringify({ event: 'admin.resume', agentId: id, by: c.get('actor').subject }));
  return c.json({ resumed: id });
});

admin.get('/approvals', (c) => proxy(c.env.BROKER, '/v1/approvals'));
admin.post('/approvals/:id/:decision{approve|reject}', async (c) => {
  const decision = c.req.param('decision') === 'approve' ? 'approved' : 'rejected';
  return proxy(c.env.BROKER, `/v1/approvals/${c.req.param('id')}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision, by: c.get('actor').subject }),
  });
});
admin.get('/audit', (c) => {
  const q = new URL(c.req.url).search;
  return proxy(c.env.BROKER, `/v1/attestations${q}`);
});
admin.get('/audit/:id', (c) => proxy(c.env.BROKER, `/v1/attestations/${c.req.param('id')}`));
admin.get('/keys', (c) => proxy(c.env.BROKER, '/v1/keys'));
admin.post('/keys/:agent/rotate', (c) => {
  const agent = c.req.param('agent');
  if (!AgentId.safeParse(agent).success) return c.json({ error: 'bad agent id' }, 400);
  console.log(
    JSON.stringify({ event: 'admin.keys.rotate', agentId: agent, by: c.get('actor').subject }),
  );
  return proxy(c.env.BROKER, `/v1/keys/${agent}/rotate`, { method: 'POST' });
});

app.route('/admin', admin);

// Agent HTTP/WebSocket access (CLI interactive mode) also sits behind Access.
app.all('/agents/*', async (c) => {
  const actor = await verifyAccessJwt(c.req.raw, c.env.ACCESS_TEAM, c.env.ACCESS_AUD);
  if (!actor) return c.json({ error: 'unauthorized' }, 401);
  const url = new URL(c.req.url);
  url.host = 'agents.internal';
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-custodes-actor', actor.subject);
  return c.env.AGENTS.fetch(
    new Request(url, { method: c.req.method, headers, body: c.req.raw.body }),
  );
});

async function proxy(fetcher: Fetcher, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetcher.fetch(`https://broker.internal${path}`, init);
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  fetch: app.fetch,

  /**
   * Approval by email. Email Routing rule: approve+*@<domain> and reject+*@<domain> → this Worker.
   * Everything else addressed to agents goes straight to the agents Worker.
   */
  async email(message: ForwardableEmailMessage, env: GatewayEnv): Promise<void> {
    const allow = env.APPROVER_EMAILS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const trust = isTrustedSender(
      message.from,
      message.headers.get('authentication-results'),
      allow,
    );
    if (!trust.trusted) {
      console.warn(JSON.stringify({ event: 'email.rejected', reason: trust.reason }));
      message.setReject('Not accepted');
      return;
    }
    const parsed = parseApprovalAddress(message.to);
    if (!parsed) {
      message.setReject('Unknown recipient');
      return;
    }
    const tok = await verifyApprovalToken(parsed.token, env.APPROVAL_TOKEN_SECRET);
    if (!tok.ok) {
      console.warn(JSON.stringify({ event: 'email.approval.invalid', reason: tok.reason }));
      return;
    }
    await env.BROKER.fetch(`https://broker.internal/v1/approvals/${tok.approvalId}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: parsed.verb === 'approve' ? 'approved' : 'rejected',
        by: `email:${message.from}`,
      }),
    });
    console.log(
      JSON.stringify({
        event: 'email.approval.decided',
        approvalId: tok.approvalId,
        verb: parsed.verb,
      }),
    );
  },
} satisfies ExportedHandler<GatewayEnv>;
