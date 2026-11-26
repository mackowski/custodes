import type { RunEvent } from './run-store.js';

const RUN_ROUTE =
  /\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(kill|events)$/;

/**
 * The operator's run routes on an agent (ADR 0023), reached only through the Access-protected
 * gateway (`/agents/*`, which verifies the Access JWT, strips credentials and sets
 * `x-custodes-actor-via`): `POST …/runs/<id>/kill` kills a run and its tree, `GET …/runs/<id>/events`
 * lists its events. People only: the gateway already refuses a service token's write, and events
 * carry model text. The answer marks events as untrusted data. Null when the path is not a run route.
 */
export async function runRoute(
  request: Request,
  ops: { kill(runId: string): Promise<number>; events(runId: string): Promise<RunEvent[]> },
): Promise<Response | null> {
  const m = RUN_ROUTE.exec(new URL(request.url).pathname);
  if (!m) return null;
  const [, runId = '', what] = m;
  if (request.headers.get('x-custodes-actor-via') !== 'access-user')
    return Response.json({ error: 'run routes are for people only' }, { status: 403 });
  if (what === 'kill' && request.method === 'POST')
    return Response.json({ runId, killed: await ops.kill(runId) });
  if (what === 'events' && request.method === 'GET')
    return Response.json({ runId, untrusted: true, events: await ops.events(runId) });
  return Response.json({ error: 'method not allowed' }, { status: 405 });
}
