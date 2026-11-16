import { REGISTRY } from './registry.js';

/**
 * Entry point of `custodes-agents` (ADR 0018). Every agent runs in its own Worker since the
 * cutovers (custodes-triage, custodes-triage-apply, custodes-pr-gate, custodes-cheatsheet-review),
 * so this Worker runs no agent: it has no Durable Object, no secret, no cron, no queue and no
 * binding. It only answers the gateway's `/admin/agents` listing from the manifests.
 */
export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if (url.pathname === '/healthz') return Response.json({ ok: true });
    if (url.pathname === '/registry') return Response.json(REGISTRY);
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler;
