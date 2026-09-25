import { KillSwitchState } from '@custodes/schema';

/** The subset of KVNamespace we need; lets the kill switch be unit-tested without workerd. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const GLOBAL_HALT_KEY = 'halt:*';
export const haltKey = (agentId: string): string => `halt:${agentId}`;

/**
 * Human-on-the-loop control: a flag every agent checks before any side effect and the broker
 * checks again before executing. Halting `*` stops the whole fleet.
 */
export class KillSwitch {
  constructor(private readonly kv: KvLike) {}

  async state(agentId: string): Promise<KillSwitchState> {
    const global = await this.read(GLOBAL_HALT_KEY);
    if (global.halted) return global;
    return this.read(haltKey(agentId));
  }

  async isHalted(agentId: string): Promise<boolean> {
    return (await this.state(agentId)).halted;
  }

  async halt(agentId: string, reason: string, by: string, now = new Date()): Promise<void> {
    const state: KillSwitchState = { halted: true, reason, by, at: now.toISOString() };
    await this.kv.put(agentId === '*' ? GLOBAL_HALT_KEY : haltKey(agentId), JSON.stringify(state));
  }

  async resume(agentId: string): Promise<void> {
    await this.kv.delete(agentId === '*' ? GLOBAL_HALT_KEY : haltKey(agentId));
  }

  private async read(key: string): Promise<KillSwitchState> {
    const raw = await this.kv.get(key);
    if (raw === null) return { halted: false };
    const parsed = KillSwitchState.safeParse(JSON.parse(raw));
    // A corrupt flag fails closed: treat as halted.
    return parsed.success ? parsed.data : { halted: true, reason: 'corrupt kill-switch state' };
  }
}
