import { Hono } from 'hono';
import { z } from 'zod';
import { importPublicKey, KillSwitch, verifyAttestation } from '@custodes/core';
import { verifyGitHubWebhookSignature } from '@custodes/github';
import {
  AgentId,
  ApprovalRequest,
  GitHubWebhookEnvelope,
  HaltRequest,
  type AdminActor,
  type InboundEvent,
  type PublicKeyEntry,
} from '@custodes/schema';
import { adminWriteAllowed, agentWriteAllowed, crossSiteWrite, verifyAccessJwt } from './access.js';
import {
  approvalPage,
  invalidPage,
  isApprover,
  PAGE_HEADERS,
  resultPage,
  type DecideResult,
} from './approval-page.js';
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

/**
 * Only the fields consumers use go on the queue (and into its dead-letter queue): never PR or
 * issue bodies, and no message near the 128 KB queue limit.
 */
function queuedFields(p: GitHubWebhookEnvelope): GitHubWebhookEnvelope {
  return {
    ...(p.action !== undefined ? { action: p.action } : {}),
    repository: { full_name: p.repository.full_name },
    sender: {
      login: p.sender.login,
      ...(p.sender.type !== undefined ? { type: p.sender.type } : {}),
    },
    ...(p.issue ? { issue: { number: p.issue.number } } : {}),
    ...(p.pull_request
      ? {
          pull_request: {
            number: p.pull_request.number,
            ...(p.pull_request.updated_at !== undefined
              ? { updated_at: p.pull_request.updated_at }
              : {}),
          },
        }
      : {}),
    // A label name is set by a repository's maintainers, not by an author's text (ADR 0017).
    ...(p.label ? { label: { name: p.label.name.slice(0, 50) } } : {}),
  };
}
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
    // Unsigned headers: clipped, and only ever logged or compared.
    event: event.slice(0, 64),
    deliveryId: deliveryId.slice(0, 64),
    repo: parsed.data.repository.full_name,
    payload: queuedFields(parsed.data),
  };
  await c.env.INBOUND.send(msg, { contentType: 'json' });
  return c.json({ queued: msg.id }, 202);
});

// ---------- Admin API: Cloudflare Access required ----------
const admin = new Hono<{ Bindings: GatewayEnv; Variables: Vars }>();
admin.use('*', async (c, next) => {
  if (crossSiteWrite(c.req.raw)) return c.json({ error: 'cross-site request refused' }, 403);
  const actor = await verifyAccessJwt(c.req.raw, c.env.ACCESS_TEAM, c.env.ACCESS_AUD);
  if (!actor) return c.json({ error: 'unauthorized' }, 401);
  if (!adminWriteAllowed(actor, c.req.method))
    return c.json({ error: 'service tokens are read-only on /admin' }, 403);
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

// The link in an approval e-mail (ADR 0017 amendment). Access proves who clicks; the token, checked
// by the broker against the stored approval, proves which action. GET shows, only POST decides.
admin.get('/approvals/link/:token', async (c) => {
  if (!isApprover(c.get('actor'), c.env.APPROVER_EMAILS))
    return c.json({ error: 'only an approver may open approval links' }, 403);
  const res = await c.env.BROKER.fetch(
    `https://broker.internal/v1/approvals/token/${encodeURIComponent(c.req.param('token'))}`,
  );
  const approval = res.ok ? ApprovalRequest.safeParse(await res.json()) : null;
  if (!approval?.success) return c.body(invalidPage(), 404, PAGE_HEADERS);
  return c.body(approvalPage(approval.data), 200, PAGE_HEADERS);
});
admin.post('/approvals/link/:token', async (c) => {
  const actor = c.get('actor');
  if (!isApprover(actor, c.env.APPROVER_EMAILS))
    return c.json({ error: 'only an approver may decide' }, 403);
  const form = await c.req.parseBody();
  const choice = form['decision'];
  if (choice !== 'approve' && choice !== 'reject') return c.json({ error: 'bad decision' }, 400);
  const res = await c.env.BROKER.fetch(
    `https://broker.internal/v1/approvals/token/${encodeURIComponent(c.req.param('token'))}/decide`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: choice === 'approve' ? 'approved' : 'rejected',
        by: actor.subject,
      }),
    },
  );
  if (res.status === 404) return c.body(invalidPage(), 404, PAGE_HEADERS);
  const out = await res.json<DecideResult>();
  console.log(
    JSON.stringify({ event: 'admin.approval.link', decision: choice, result: out.result }),
  );
  return c.body(resultPage(out), 200, PAGE_HEADERS);
});

admin.post('/approvals/:id/:decision{approve|reject}', async (c) => {
  if (!isApprover(c.get('actor'), c.env.APPROVER_EMAILS))
    return c.json({ error: 'only an approver may decide' }, 403);
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
  if (crossSiteWrite(c.req.raw)) return c.json({ error: 'cross-site request refused' }, 403);
  const actor = await verifyAccessJwt(c.req.raw, c.env.ACCESS_TEAM, c.env.ACCESS_AUD);
  if (!actor) return c.json({ error: 'unauthorized' }, 401);
  const url = new URL(c.req.url);
  if (!agentWriteAllowed(actor, c.req.method, url.pathname))
    return c.json({ error: 'service tokens may only trigger run, digest or summary' }, 403);
  url.host = 'agents.internal';
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-custodes-actor', actor.subject);
  headers.set('x-custodes-actor-via', actor.via);
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
   * Replies to approve+…/reject+… addresses (Email Routing still sends them here) are refused:
   * approvals happen through the link behind Access, which also checks who clicks (ADR 0017
   * amendment). A reply cannot carry a token intact: addresses are case-folded.
   */
  email(message: ForwardableEmailMessage): Promise<void> {
    console.warn(JSON.stringify({ event: 'email.approval.refused', reason: 'link_only' }));
    message.setReject('Approve with the link in the e-mail; replies are not accepted');
    return Promise.resolve();
  },
} satisfies ExportedHandler<GatewayEnv>;
