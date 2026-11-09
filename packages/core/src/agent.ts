import * as workers from 'cloudflare:workers';
import { Agent, type Connection } from 'agents';
import {
  type AgentManifest,
  ApprovalCreated,
  type BrokerAction,
  KillSwitchState,
  BrokerResponse,
  type BrokerRequest,
  type Trigger,
} from '@custodes/schema';
import type { Keyholder } from './keyholder.js';
import { type BrokerFetcher, signingBroker } from './signed-broker.js';
import { conversationOf, executeTool, NO_TRACER, type Tracer, type Turn } from './tracing.js';

/** Bindings every Custodes agent Worker must have. Extend per Worker. */
export interface CustodesEnv {
  /** Service binding to workers/github-broker. Agents never talk to GitHub directly. */
  BROKER: Fetcher;
  /** `"true"` records model and tool payloads in trace spans (ADR 0016). */
  TRACE_PAYLOADS: string;
  /**
   * Set only in a per-agent Worker (ADR 0018): its `Keyholder` and its caller name, e.g.
   * `custodes-pr-gate`. With both, every broker call is signed; the shared Worker has neither.
   */
  KEYHOLDER?: DurableObjectNamespace<Keyholder>;
  CALLER_NAME?: string;
}

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
   * The broker, as this agent must call it: signed with the Worker's own key in a per-agent Worker,
   * plain on the shared Worker until it moves (ADR 0018). Read on every call, so tests that replace
   * `env.BROKER` keep working. Use this, never `env.BROKER`, for every broker request.
   */
  protected get broker(): BrokerFetcher {
    const keyholder = this.keyholder;
    return keyholder === null ? this.env.BROKER : signingBroker(this.env.BROKER, keyholder);
  }

  /** This Worker's Keyholder, or null on the shared Worker. Throws when half-configured. */
  private get keyholder(): DurableObjectStub<Keyholder> | null {
    const { KEYHOLDER, CALLER_NAME } = this.env;
    if (KEYHOLDER === undefined && CALLER_NAME === undefined) return null;
    // Half-configured is a deploy mistake: fail loudly instead of sending unsigned requests.
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
   * threat D1). A no-op on the shared Worker and when there is no next key; never blocks a run.
   */
  private async adoptNextKey(): Promise<void> {
    try {
      const keyholder = this.keyholder;
      if (keyholder !== null && (await keyholder.activateNextIfAccepted()))
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

  /** Requests a GitHub side effect. The broker decides; this method only reports the outcome. */
  protected async act(
    action: BrokerAction,
    runId: string,
    triggeredBy: Trigger,
    opts: { onBehalfOf?: string; turn?: Turn } = {},
  ): Promise<BrokerResponse> {
    if (this.manifest.mode === 'readonly') {
      throw new Error(`agent ${this.manifest.id} is read-only and cannot request side effects`);
    }
    await this.guard();
    const request: BrokerRequest = {
      agentId: this.manifest.id,
      agentVersion: this.manifest.version,
      runId,
      triggeredBy,
      action,
      ...(opts.onBehalfOf !== undefined ? { onBehalfOf: opts.onBehalfOf } : {}),
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
    await this.guard();
    const request: BrokerRequest = {
      agentId: this.manifest.id,
      agentVersion: this.manifest.version,
      runId,
      triggeredBy,
      action,
    };
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
}
