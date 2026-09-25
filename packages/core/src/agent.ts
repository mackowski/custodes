import { Agent } from 'agents';
import {
  type AgentManifest,
  type BrokerAction,
  BrokerResponse,
  type BrokerRequest,
  type Trigger,
} from '@custodes/schema';
import { KillSwitch } from './killswitch.js';

/** Bindings every Custodes agent Worker must have. Extend per Worker. */
export interface CustodesEnv {
  /** Service binding to workers/github-broker. Agents never talk to GitHub directly. */
  BROKER: Fetcher;
  /** KV namespace holding kill-switch flags. */
  KILL_SWITCH: KVNamespace;
}

export class AgentHaltedError extends Error {
  constructor(agentId: string, reason?: string) {
    super(`agent ${agentId} is halted${reason ? `: ${reason}` : ''}`);
    this.name = 'AgentHaltedError';
  }
}

/**
 * Base class for all Custodes agents. Adds:
 *  - a manifest (identity, version, mode, repos),
 *  - a kill-switch check before any side effect,
 *  - `act()` which routes every GitHub write through the broker.
 */
export abstract class CustodesAgent<
  Env extends CustodesEnv & Cloudflare.Env,
  State = unknown,
> extends Agent<Env, State> {
  abstract readonly manifest: AgentManifest;

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
    opts: { onBehalfOf?: string; approvalId?: string } = {},
  ): Promise<BrokerResponse> {
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
    const res = await this.env.BROKER.fetch('https://broker.internal/v1/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    return BrokerResponse.parse(await res.json());
  }
}
