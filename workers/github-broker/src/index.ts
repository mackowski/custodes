import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  accessTokenOf,
  canonicalJson,
  isApprover,
  KillSwitch,
  sha256Hex,
  verifyAccessToken,
} from '@custodes/core';
import {
  AgentId,
  type AgentKeys,
  BrokerReadRequest,
  BrokerRequest,
  BundleApprovalAsk,
  type CallerName,
  CallerSignature,
  HaltRequest,
  type AdminActor,
} from '@custodes/schema';
import { act } from './act.js';
import {
  approvalByToken,
  createApproval,
  createBundleApproval,
  decideApproval,
} from './approvals.js';
import {
  agentKeys,
  authenticateCaller,
  CALLER_AGENTS,
  CALLER_ENTRYPOINTS,
  type VerifiedCall,
} from './callers.js';
import { read } from './read.js';
import { keyring, type BrokerEnv } from './env.js';

export { Keyring } from './keyring.js';
import { policy } from './policy.js';
import { accessOptions } from './access-options.js';
import { ApprovalStore, AuditStore } from './store.js';

/**
 * Not internet-facing (workers_dev=false, no routes). Who may call what is fixed by the service
 * bindings, not by trust in the caller (ADR 0017 amendment, ADR 0018):
 * - one entrypoint per agent Worker (`PrGateBroker`, ...): act, read, state and asking for an
 *   approval, only with a request signed by a key pinned for that Worker, and only for the agent
 *   ids that Worker hosts;
 * - the default one, unsigned: it serves no agent (every agent has its own Worker), refuses every
 *   request but /healthz, and no Worker may bind it (bindings.test);
 * - `BrokerAdmin`, bound only by the gateway, which authenticates with Access first: deciding
 *   approvals, the audit log and keys. An agent cannot approve its own request.
 */
/** `call` is set only on a per-agent entrypoint, after the signature and nonce checks passed. */
export type App = Hono<{ Bindings: BrokerEnv; Variables: { call?: VerifiedCall } }>;

/** Null when `agentId` may be served on this entrypoint, else the reason it may not. */
type Admit = (agentId: string) => string | null;

const refused = (reason: string) => ({
  ok: false as const,
  code: 'policy_denied' as const,
  reason,
});

const StateRequest = z.object({ agentId: AgentId });
const CreateApproval = z.object({
  request: BrokerRequest,
  /** Shown to the operator. Untrusted: may contain model output. */
  rationale: z.string().max(4000),
});

/**
 * The routes agents use, behind `admit`. Shared by the default and the per-Worker entrypoints;
 * exported so the route tests can run them with their own `admit`.
 */
export function agentRoutes(app: App, admitAgent: Admit, entrypoint: string): App {
  // Every route needs a verified call (the caller's signature, checked by the middleware before
  // this one), whatever `admit` says: reused without signing, these routes serve no one.
  app.use('*', async (c, next) => {
    if (c.get('call') === undefined)
      return c.json({ ok: false, code: 'unauthenticated', reason: 'missing' }, 401);
    await next();
  });
  /**
   * Logs every refusal: a signed request from one Worker naming another Worker's agent is the
   * clearest sign of the compromise ADR 0018 is about (threat S1). Ids only.
   */
  const admit: Admit = (agentId) => {
    const no = admitAgent(agentId);
    if (no !== null)
      console.warn(JSON.stringify({ event: 'broker.admit.refused', entrypoint, agentId }));
    return no;
  };
  app.post('/v1/act', async (c) => {
    const parsed = BrokerRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ ok: false, code: 'invalid', reason: parsed.error.message }, 400);
    const no = admit(parsed.data.agentId);
    if (no !== null) return c.json(refused(no), 403);
    // An approved action is run by the broker when the operator decides; an agent never spends
    // an approval itself.
    if (parsed.data.approvalId !== undefined) {
      console.warn(
        JSON.stringify({
          event: 'broker.act.approval_id_refused',
          agentId: parsed.data.agentId,
          runId: parsed.data.runId,
        }),
      );
      return c.json(
        { ok: false, code: 'invalid', reason: 'approved actions are run by the broker' },
        400,
      );
    }
    const call = c.get('call');
    // Every action is signed (ADR 0018): fail closed if a request ever reaches here unverified.
    if (call === undefined)
      return c.json({ ok: false, code: 'unauthenticated', reason: 'missing' }, 401);
    // Signed: the body must be the canonical JSON of the request, so the audit record (which holds
    // the parsed request) lets /verify recompute what the agent signed (ADR 0018, R1).
    if ((await sha256Hex(canonicalJson(parsed.data))) !== call.bodySha256)
      return c.json(
        { ok: false, code: 'invalid', reason: 'body must be the canonical JSON of the request' },
        400,
      );
    // Parsed before any side effect: a record the audit log cannot read back would hide the action.
    const { admittedAt, ...signedFields } = call;
    const callerSignature = CallerSignature.safeParse({
      ...signedFields,
      method: 'POST',
      path: '/v1/act',
    });
    if (!callerSignature.success) {
      console.warn(
        JSON.stringify({
          event: 'broker.caller.refused',
          caller: call.caller,
          reason: 'signature_fields',
        }),
      );
      return c.json({ ok: false, code: 'invalid', reason: 'signature fields' }, 400);
    }
    return c.json(await act(c.env, parsed.data, new Date(admittedAt), callerSignature.data));
  });

  /** GET-only, allow-listed GitHub reads for agents (ADR 0009). */
  app.post('/v1/read', async (c) => {
    const parsed = BrokerReadRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ ok: false, code: 'invalid', reason: parsed.error.message }, 400);
    const no = admit(parsed.data.agentId);
    if (no !== null) return c.json(refused(no), 403);
    return c.json(await read(c.env, parsed.data));
  });

  /**
   * The kill-switch state for one agent. Agents do not bind the KV namespace (a KV binding can
   * write, so an agent could delete its own halt flag); they read the flag here (#103, threat T1).
   */
  app.post('/v1/state', async (c) => {
    const parsed = StateRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const no = admit(parsed.data.agentId);
    if (no !== null) return c.json({ error: no }, 403);
    // Only what the agent needs: who halted it (the operator's e-mail) stays out of agent reach.
    const { halted, reason } = await new KillSwitch(c.env.KILL_SWITCH).state(parsed.data.agentId);
    return c.json(reason === undefined ? { halted } : { halted, reason });
  });

  /** Asks for an approval of one action; the answer carries the link token for the operator. */
  app.post('/v1/approvals', async (c) => {
    const parsed = CreateApproval.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const no = admit(parsed.data.request.agentId);
    if (no !== null) return c.json({ error: no }, 403);
    const out = await createApproval(c.env, parsed.data.request, parsed.data.rationale);
    return out.ok
      ? c.json({ approval: out.approval, token: out.token }, 201)
      : c.json({ error: out.error }, out.status);
  });

  /** One approval for several actions on one issue (ADR 0019); same answer as above. */
  app.post('/v1/approvals/bundle', async (c) => {
    const parsed = BundleApprovalAsk.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const no = admit(parsed.data.request.agentId);
    if (no !== null) return c.json({ error: no }, 403);
    const out = await createBundleApproval(c.env, parsed.data);
    return out.ok
      ? c.json({ approval: out.approval, token: out.token }, 201)
      : c.json({ error: out.error }, out.status);
  });
  return app;
}

// ---------- Default entrypoint ----------
/**
 * The default entrypoint is unsigned, so it serves no agent: every agent runs in its own Worker
 * with its own signed entrypoint (ADR 0018), and no Worker binds this one (a binding test checks).
 * It refuses every agent id in code, not by a flag in the policy: a new agent added to the policy
 * is refused here without anyone having to remember a flag.
 */
export function sharedAgentApp(): App {
  const app: App = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  // Not agentRoutes with an admit that says no: no route here ever reaches the action pipeline.
  app.all('*', (c) => {
    // Nothing binds this entrypoint, so any request is a sign of a misconfiguration or worse.
    console.warn(
      // The first two segments only: a full path could carry an approval link token (ids only).
      JSON.stringify({
        event: 'broker.default.refused',
        path: new URL(c.req.url).pathname.split('/').slice(0, 3).join('/'),
      }),
    );
    return c.json(
      {
        ok: false,
        code: 'refused',
        reason: "no agent is served here; use its Worker's signed broker entrypoint",
      },
      403,
    );
  });
  return app;
}
const agentApp: App = sharedAgentApp();

// ---------- Per-agent Workers (ADR 0018) ----------
const SIGNED_PATHS = new Set([
  '/v1/act',
  '/v1/read',
  '/v1/state',
  '/v1/approvals',
  '/v1/approvals/bundle',
]);
/** The routes for one agent Worker: signature first, then only the agent ids it hosts. */
export function callerApp(caller: CallerName, keys: AgentKeys = agentKeys): App {
  const app: App = new Hono();
  app.use('*', async (c, next) => {
    // Only the literal paths: Hono would also route `/v1/%61ct` to `/v1/act`, and the audit record
    // stores the literal path, so an encoded one would make an honest record look forged.
    if (c.req.method !== 'POST' || !SIGNED_PATHS.has(new URL(c.req.url).pathname))
      return c.json({ ok: false, code: 'invalid', reason: 'unknown route' }, 404);
    // The exact bytes sent are what was signed; Hono keeps them for the handlers' json().
    const body = await c.req.text();
    const auth = await authenticateCaller(c.env, caller, c.req.raw, body, keys);
    if (!auth.ok) return c.json({ ok: false, code: 'unauthenticated', reason: auth.reason }, 401);
    c.set('call', auth.call);
    await next();
  });
  const hosted = CALLER_AGENTS[caller];
  return agentRoutes(
    app,
    (id) => (hosted.includes(id) ? null : `agent ${id} is not in ${caller}`),
    caller,
  );
}

const callerApps = {
  'custodes-pr-gate': callerApp('custodes-pr-gate'),
  'custodes-cheatsheet-review': callerApp('custodes-cheatsheet-review'),
  'custodes-triage': callerApp('custodes-triage'),
  'custodes-triage-apply': callerApp('custodes-triage-apply'),
} satisfies Record<CallerName, App>;

/** Bound only by `custodes-pr-gate` (checked by packages/core/test/bindings.test.ts). */
export class PrGateBroker extends WorkerEntrypoint {
  override fetch(request: Request): Response | Promise<Response> {
    return callerApps[CALLER_ENTRYPOINTS.PrGateBroker].fetch(request, this.env, this.ctx);
  }
}
/** Bound only by `custodes-cheatsheet-review`. */
export class CheatsheetReviewBroker extends WorkerEntrypoint {
  override fetch(request: Request): Response | Promise<Response> {
    return callerApps[CALLER_ENTRYPOINTS.CheatsheetReviewBroker].fetch(request, this.env, this.ctx);
  }
}
/** Bound only by `custodes-triage`. */
export class TriageBroker extends WorkerEntrypoint {
  override fetch(request: Request): Response | Promise<Response> {
    return callerApps[CALLER_ENTRYPOINTS.TriageBroker].fetch(request, this.env, this.ctx);
  }
}

/** Bound only by `custodes-triage-apply` (ADR 0019). */
export class TriageApplyBroker extends WorkerEntrypoint {
  override fetch(request: Request): Response | Promise<Response> {
    return callerApps[CALLER_ENTRYPOINTS.TriageApplyBroker].fetch(request, this.env, this.ctx);
  }
}

// ---------- Admin (BrokerAdmin entrypoint, gateway only) ----------
const adminApp: App = new Hono();

adminApp.get('/healthz', (c) => c.json({ ok: true }));

adminApp.get('/v1/approvals', async (c) =>
  c.json(await new ApprovalStore(c.env.AUDIT).listPending(100)),
);

/** The approval a link token names, for the confirmation page. Reading never decides. */
adminApp.get('/v1/approvals/token/:token', async (c) => {
  const found = await approvalByToken(c.env, c.req.param('token'));
  return found.ok ? c.json(found.approval) : c.json({ error: found.reason }, 404);
});

/**
 * The operator behind an admin write, from their own Access token, which the gateway forwards
 * (#104). The broker never takes an identity from the gateway: a compromised gateway can no longer
 * decide, rotate or resume in an approver's name without that approver's token.
 */
async function operator(
  req: Request,
  env: BrokerEnv,
  need: 'person' | 'approver',
): Promise<AdminActor | 'unauthorized' | 'forbidden'> {
  const token = accessTokenOf(req);
  const actor = token
    ? await verifyAccessToken(token, env.ACCESS_TEAM, env.ACCESS_AUD, accessOptions)
    : null;
  if (!actor) return 'unauthorized';
  if (actor.via !== 'access-user') return 'forbidden';
  if (need === 'approver' && !isApprover(actor, env.APPROVER_EMAILS)) return 'forbidden';
  return actor;
}
const refusal = (r: 'unauthorized' | 'forbidden') =>
  Response.json({ error: r }, { status: r === 'unauthorized' ? 401 : 403 });

/** The decision only: who decided comes from the approver's own token, never from the body. */
const Decide = z.object({ decision: z.enum(['approved', 'rejected']) });

/** Decides through a link token: the token must be valid for the stored approval's action. */
adminApp.post('/v1/approvals/token/:token/decide', async (c) => {
  const who = await operator(c.req.raw, c.env, 'approver');
  if (typeof who === 'string') return refusal(who);
  const parsed = Decide.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const found = await approvalByToken(c.env, c.req.param('token'));
  if (!found.ok) return c.json({ error: found.reason }, 404);
  const out = await decideApproval(c.env, found.approval.id, parsed.data.decision, who.subject);
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
  const who = await operator(c.req.raw, c.env, 'approver');
  if (typeof who === 'string') return refusal(who);
  const parsed = Decide.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  if (parsed.data.decision !== 'rejected')
    return c.json({ error: 'approve through the e-mailed link, which shows the action' }, 400);
  const out = await decideApproval(c.env, c.req.param('id'), parsed.data.decision, who.subject);
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
  // Immediate (not staged like agent keys): an approver's own token is required (#104).
  const who = await operator(c.req.raw, c.env, 'approver');
  if (typeof who === 'string') return refusal(who);
  const agent = c.req.param('agent');
  if (!AgentId.safeParse(agent).success || !policy.agents[agent])
    return c.json({ error: 'unknown agent' }, 404);
  const entry = await keyring(c.env).rotate(agent);
  console.log(
    JSON.stringify({
      event: 'keyring.rotated',
      agentId: agent,
      keyId: entry.keyId,
      by: who.subject,
    }),
  );
  return c.json(entry, 201);
});

/**
 * Every agent's own halt flag and the fleet's, for the operator's kill-switch page. Read only;
 * the flag's `by` is the operator who halted it (an e-mail, shown only behind Access).
 */
adminApp.get('/v1/agents/states', async (c) => {
  const ks = new KillSwitch(c.env.KILL_SWITCH);
  const ids = ['*', ...new Set([...Object.keys(policy.agents), ...Object.keys(policy.reads)])];
  return c.json(await Promise.all(ids.map(async (id) => ({ id, ...(await ks.flag(id)) }))));
});

/**
 * The kill switch, written here only (#104): any operator may halt (the safe direction), only an
 * approver may resume. The gateway no longer binds the namespace.
 */
adminApp.post('/v1/agents/:id/halt', async (c) => {
  const who = await operator(c.req.raw, c.env, 'person');
  if (typeof who === 'string') return refusal(who);
  const id = c.req.param('id');
  if (id !== '*' && !AgentId.safeParse(id).success) return c.json({ error: 'bad agent id' }, 400);
  const body = HaltRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.message }, 400);
  await new KillSwitch(c.env.KILL_SWITCH).halt(id, body.data.reason, who.subject);
  console.log(JSON.stringify({ event: 'admin.halt', agentId: id, by: who.subject }));
  return c.json({ halted: id });
});

adminApp.post('/v1/agents/:id/resume', async (c) => {
  const who = await operator(c.req.raw, c.env, 'approver');
  if (typeof who === 'string') return refusal(who);
  const id = c.req.param('id');
  if (id !== '*' && !AgentId.safeParse(id).success) return c.json({ error: 'bad agent id' }, 400);
  await new KillSwitch(c.env.KILL_SWITCH).resume(id);
  console.log(JSON.stringify({ event: 'admin.resume', agentId: id, by: who.subject }));
  return c.json({ resumed: id });
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
