import * as workers from 'cloudflare:workers';
import { Agent, type Connection } from 'agents';
import {
  type AgentManifest,
  ApprovalCreated,
  type ApprovalBundle,
  type BrokerAction,
  KillSwitchState,
  BrokerResponse,
  type BrokerRequest,
  type IssueSnapshot,
  type PullSnapshot,
  type Trigger,
} from '@custodes/schema';
import type { Keyholder } from './keyholder.js';
import { RunStore, type RunEvent, type SqlLike } from './runtime/run-store.js';
import { runRoute } from './runtime/run-routes.js';
import { type BrokerFetcher, signingBroker } from './signed-broker.js';
import { conversationOf, executeTool, NO_TRACER, type Tracer, type Turn } from './tracing.js';

/** Bindings every Custodes agent Worker must have. Extend per Worker. */
export interface CustodesEnv {
  /** Service binding to workers/github-broker. Agents never talk to GitHub directly. */
  BROKER: Fetcher;
  /** `"true"` records model and tool payloads in trace spans (ADR 0016). */
  TRACE_PAYLOADS: string;
  /**
   * The agent Worker's `Keyholder` and its caller name, e.g. `custodes-pr-gate` (ADR 0018): every
   * broker call is signed with them. Optional in the type only because `custodes-agents`, which
   * runs no agent, shares this env shape; an agent without both refuses to call the broker.
   */
  KEYHOLDER?: DurableObjectNamespace<Keyholder>;
  CALLER_NAME?: string;
}

/** When the daily prune of run events runs (ADR 0023: 14 days of retention). */
export const RUNTIME_PRUNE_CRON = '23 3 * * *';

export class AgentHaltedError extends Error {
  constructor(agentId: string, reason?: string) {
    super(`agent ${agentId} is halted${reason ? `: ${reason}` : ''}`);
    this.name = 'AgentHaltedError';
  }
}

/** The runtime's `tracing`, or no spans when this runtime has none. */
function runtimeTracer(): Tracer {
  const runtime = (workers as { tracing?: Partial<Tracer> }).tracing;
  return typeof runtime?.enterSpan === 'function' ? (runtime as Tracer) : NO_TRACER;
}

/**
 * Base class for all Custodes agents. Adds:
 *  - a manifest (identity, version, mode, repos),
 *  - a kill-switch check before any side effect,
 *  - `act()` which routes every GitHub write through the broker,
 *  - `turn()` which identifies one unit of work for tracing (ADR 0016).
 */
export abstract class CustodesAgent<
  Env extends CustodesEnv & Cloudflare.Env,
  State = unknown,
> extends Agent<Env, State> {
  abstract readonly manifest: AgentManifest;

  /**
   * Agent state is server-owned. The SDK otherwise lets connected WebSocket clients overwrite it
   * with cf_agent_state frames; through the gateway that would mean any Access session.
   */
  override validateStateChange(_next: State, source: Connection | 'server'): void {
    if (source !== 'server') throw new Error('agent state is server-owned');
  }

  /** A second layer for the same rule: the SDK refuses a state frame from a read-only connection. */
  override shouldConnectionBeReadonly(): boolean {
    return true;
  }

  /**
   * Workers custom spans; tests replace it with a recording fake. A namespace import, so a runtime
   * without `tracing` falls back to no spans instead of failing to load the Worker.
   */
  protected tracer: Tracer = runtimeTracer();

  /** The trace turn for one issue or pull request of `repo` in run `runId`. */
  protected turn(repo: string, number: number, runId: string): Turn {
    return {
      identity: {
        agentName: this.manifest.id,
        agentId: `${this.manifest.id}/${this.name}`,
        conversationId: conversationOf(repo, number),
        runId,
      },
      tracer: this.tracer,
      payloads: this.env.TRACE_PAYLOADS === 'true',
    };
  }

  /**
   * The broker, as this agent must call it: every request signed with the Worker's own key
   * (ADR 0018). Read on every call, so tests that replace `env.BROKER` keep working. Use this,
   * never `env.BROKER`, for every broker request.
   */
  protected get broker(): BrokerFetcher {
    return signingBroker(this.env.BROKER, this.keyholder);
  }

  /**
   * This Worker's Keyholder. Every agent runs in its own Worker with one (the shared Worker that
   * sent unsigned requests is gone), so a missing binding is a deploy mistake: fail loudly.
   */
  private get keyholder(): DurableObjectStub<Keyholder> {
    const { KEYHOLDER, CALLER_NAME } = this.env;
    if (KEYHOLDER === undefined || CALLER_NAME === undefined) {
      console.error(
        JSON.stringify({ event: 'agent.broker.misconfigured', agentId: this.manifest.id }),
      );
      throw new Error('KEYHOLDER and CALLER_NAME must be set together');
    }
    return KEYHOLDER.get(KEYHOLDER.idFromName('default'));
  }

  /**
   * This agent's kill-switch state, read from the broker: agents do not bind the KV namespace,
   * because a KV binding can also write and an agent could clear its own halt flag (#103, threat T1).
   * Fails closed: if the broker does not answer with a valid state, the agent counts as halted.
   */
  protected async haltState(): Promise<KillSwitchState> {
    let status: number | null = null;
    try {
      const res = await this.broker.fetch('https://broker.internal/v1/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: this.manifest.id }),
      });
      status = res.status;
      const parsed = res.ok ? KillSwitchState.safeParse(await res.json()) : null;
      if (parsed?.success) return parsed.data;
    } catch {
      // fall through: unreachable broker counts as halted
    }
    // Ids and status only: tells a broker outage or rollback apart from an operator halt in logs.
    console.warn(
      JSON.stringify({ event: 'agent.halt_state.unavailable', agentId: this.manifest.id, status }),
    );
    return { halted: true, reason: 'kill-switch state unavailable' };
  }

  /**
   * After a rotation, switches the Worker to its next key once the broker accepts it (ADR 0018,
   * threat D1). A no-op when there is no next key; never blocks a run.
   */
  private async adoptNextKey(): Promise<void> {
    try {
      if (await this.keyholder.activateNextIfAccepted())
        console.log(JSON.stringify({ event: 'agent.key.activated', agentId: this.manifest.id }));
    } catch {
      // A half-configured Worker or an unreachable keyholder: haltState() fails closed next.
    }
  }

  /** Throws if this agent (or the whole fleet) is halted. Call at the start of every run. */
  protected async guard(): Promise<void> {
    await this.adoptNextKey();
    const state = await this.haltState();
    if (state.halted) throw new AgentHaltedError(this.manifest.id, state.reason);
  }

  /**
   * The start of every request for a side effect (`act`, `requestApproval`,
   * `requestBundleApproval`): a read-only agent is refused here, the kill switch is checked, and
   * the fields that identify the request are built. One place, so the three cannot drift.
   */
  private async sideEffect(
    runId: string,
    triggeredBy: Trigger,
  ): Promise<Pick<BrokerRequest, 'agentId' | 'agentVersion' | 'runId' | 'triggeredBy'>> {
    if (this.manifest.mode === 'readonly') {
      throw new Error(`agent ${this.manifest.id} is read-only and cannot request side effects`);
    }
    await this.guard();
    return {
      agentId: this.manifest.id,
      agentVersion: this.manifest.version,
      runId,
      triggeredBy,
    };
  }

  /**
   * Requests a GitHub side effect. The broker decides; this method only reports the outcome. A
   * runtime write passes the snapshot it read, and the broker refuses it if the target changed
   * (ADR 0023).
   */
  protected async act(
    action: BrokerAction,
    runId: string,
    triggeredBy: Trigger,
    opts: { turn?: Turn; snapshot?: IssueSnapshot | PullSnapshot } = {},
  ): Promise<BrokerResponse> {
    const request: BrokerRequest = {
      ...(await this.sideEffect(runId, triggeredBy)),
      action,
      ...(opts.snapshot !== undefined ? { snapshot: opts.snapshot } : {}),
    };
    return executeTool(opts.turn, action.type, async (span) => {
      // The action is our own output (it becomes public on GitHub); approval ids are not recorded.
      span.payload('gen_ai.tool.call.arguments', action);
      const res = await this.broker.fetch('https://broker.internal/v1/act', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const out = BrokerResponse.parse(await res.json());
      span.set('custodes.broker.outcome', out.ok ? 'ok' : out.code);
      return out;
    });
  }

  /**
   * Asks for a human approval of an action the broker answered with `approval_required`. Returns
   * the link token to send to the operator; the broker runs the action itself once approved, so
   * the agent does not come back to it (ADR 0017 amendment). The agent can ask, never decide.
   */
  protected async requestApproval(
    action: BrokerAction,
    rationale: string,
    runId: string,
    triggeredBy: Trigger,
    opts: { turn?: Turn } = {},
  ): Promise<{ ok: true; created: ApprovalCreated } | { ok: false; status: number }> {
    const request: BrokerRequest = { ...(await this.sideEffect(runId, triggeredBy)), action };
    return executeTool(opts.turn, 'approval.request', async (span) => {
      const res = await this.broker.fetch('https://broker.internal/v1/approvals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request, rationale: rationale.slice(0, 4_000) }),
      });
      span.set('custodes.broker.status', res.status);
      if (res.status !== 201) return { ok: false, status: res.status };
      // The token is a credential for the operator's click: never put in a span.
      return { ok: true, created: ApprovalCreated.parse(await res.json()) };
    });
  }

  /**
   * Asks for one approval of several actions on one issue (ADR 0019). The broker checks the
   * snapshot and the people named against GitHub, and runs the bundle itself once approved.
   */
  protected async requestBundleApproval(
    bundle: ApprovalBundle,
    rationale: string,
    runId: string,
    triggeredBy: Trigger,
  ): Promise<
    { ok: true; created: ApprovalCreated } | { ok: false; status: number; error?: string }
  > {
    const request = { ...(await this.sideEffect(runId, triggeredBy)), bundle };
    const res = await this.broker.fetch('https://broker.internal/v1/approvals/bundle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request, rationale: rationale.slice(0, 4_000) }),
    });
    if (res.status !== 201) {
      // The broker's reason (policy, stale, a stranger named) is ours to log; it holds no secret.
      const body = await res.json<{ error?: unknown }>().catch(() => ({ error: undefined }));
      const error = typeof body.error === 'string' ? body.error.slice(0, 200) : undefined;
      return error !== undefined
        ? { ok: false, status: res.status, error }
        : { ok: false, status: res.status };
    }
    return { ok: true, created: ApprovalCreated.parse(await res.json()) };
  }

  // ---------- Agent runtime (ADR 0023): run store, kill, events, retention ----------

  private runtimeRunStore: RunStore | undefined;

  /**
   * This agent's run store in its Durable Object's SQLite. The first open schedules the daily
   * prune (a cron schedule, idempotent across restarts), so retention holds for any agent that
   * runs the runtime.
   */
  protected async runStore(): Promise<RunStore> {
    if (this.runtimeRunStore) return this.runtimeRunStore;
    // `SqlLike` is the subset the store uses; its row type is looser than SqlStorage's generic.
    this.runtimeRunStore = new RunStore(this.ctx.storage.sql as unknown as SqlLike);
    await this.schedule(RUNTIME_PRUNE_CRON, 'pruneRuntimeRuns');
    return this.runtimeRunStore;
  }

  /** Called by the daily schedule: drops runs and events past ADR 0023's 14 days. */
  async pruneRuntimeRuns(): Promise<void> {
    (await this.runStore()).prune();
  }

  /**
   * Kills a run and its whole tree (ADR 0023). Durable Object RPC, never `@callable`: only code
   * holding this agent's namespace binding reaches it (the agent Worker, for the operator's
   * Access-checked request). Returns how many runs it marked.
   */
  async killRun(runId: string): Promise<number> {
    const n = (await this.runStore()).kill(runId);
    console.log(JSON.stringify({ event: 'runtime.kill', agentId: this.manifest.id, runId, n }));
    return n;
  }

  /**
   * A run's events and its children's (ADR 0023): untrusted model text and tool arguments, capped
   * and redacted. Durable Object RPC for the supervisor (#135), read only.
   */
  async listRunEvents(runId: string, limit?: number): Promise<RunEvent[]> {
    return (await this.runStore()).listEvents(runId, limit);
  }

  /**
   * The operator's run routes, for an agent's `onRequest` (`runRoute`): kill a run, list its
   * events. Null when the path is not a run route.
   */
  protected handleRunRequest(request: Request): Promise<Response | null> {
    return runRoute(request, {
      kill: (runId) => this.killRun(runId),
      events: (runId) => this.listRunEvents(runId),
    });
  }
}
