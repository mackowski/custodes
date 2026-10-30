import * as workers from 'cloudflare:workers';
import { Agent, type Connection } from 'agents';
import {
  type AgentManifest,
  ApprovalCreated,
  type BrokerAction,
  BrokerResponse,
  type BrokerRequest,
  type Trigger,
} from '@custodes/schema';
import { KillSwitch } from './killswitch.js';
import { conversationOf, executeTool, NO_TRACER, type Tracer, type Turn } from './tracing.js';

/** Bindings every Custodes agent Worker must have. Extend per Worker. */
export interface CustodesEnv {
  /** Service binding to workers/github-broker. Agents never talk to GitHub directly. */
  BROKER: Fetcher;
  /** KV namespace holding kill-switch flags. */
  KILL_SWITCH: KVNamespace;
  /** `"true"` records model and tool payloads in trace spans (ADR 0016). */
  TRACE_PAYLOADS: string;
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

  protected get killSwitch(): KillSwitch {
    return new KillSwitch(this.env.KILL_SWITCH);
  }

  /** Throws if this agent (or the whole fleet) is halted. Call at the start of every run. */
  protected async guard(): Promise<void> {
    const state = await this.killSwitch.state(this.manifest.id);
    if (state.halted) throw new AgentHaltedError(this.manifest.id, state.reason);
  }

  /** Requests a GitHub side effect. The broker decides; this method only reports the outcome. */
  protected async act(
    action: BrokerAction,
    runId: string,
    triggeredBy: Trigger,
    opts: { onBehalfOf?: string; approvalId?: string; turn?: Turn } = {},
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
      ...(opts.approvalId !== undefined ? { approvalId: opts.approvalId } : {}),
    };
    return executeTool(opts.turn, action.type, async (span) => {
      // The action is our own output (it becomes public on GitHub); approval ids are not recorded.
      span.payload('gen_ai.tool.call.arguments', action);
      const res = await this.env.BROKER.fetch('https://broker.internal/v1/act', {
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
      const res = await this.env.BROKER.fetch('https://broker.internal/v1/approvals', {
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
