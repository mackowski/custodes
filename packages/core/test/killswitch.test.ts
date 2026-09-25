import { describe, expect, it } from 'vitest';
import { KillSwitch, type KvLike } from '../src/killswitch.js';

function memKv(): KvLike {
  const m = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(m.get(k) ?? null),
    put: (k, v) => {
      m.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      m.delete(k);
      return Promise.resolve();
    },
  };
}

describe('KillSwitch', () => {
  it('halts one agent, then the fleet, then resumes', async () => {
    const ks = new KillSwitch(memKv());
    expect(await ks.isHalted('triage')).toBe(false);
    await ks.halt('triage', 'suspicious comments', 'jakub');
    expect(await ks.isHalted('triage')).toBe(true);
    expect(await ks.isHalted('review')).toBe(false);
    await ks.halt('*', 'incident', 'jakub');
    expect(await ks.isHalted('review')).toBe(true);
    await ks.resume('*');
    await ks.resume('triage');
    expect(await ks.isHalted('triage')).toBe(false);
  });
  it('fails closed on corrupt state', async () => {
    const kv = memKv();
    await kv.put('halt:triage', '{"halted":"maybe"}');
    expect(await new KillSwitch(kv).isHalted('triage')).toBe(true);
  });
});
