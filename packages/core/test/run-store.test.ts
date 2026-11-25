import { describe, expect, it } from 'vitest';
import {
  EVENT_RETENTION_MS,
  MODEL_TEXT_CAP,
  redact,
  RunStore,
  runGuard,
  storeLedger,
} from '../src/runtime/run-store.js';
import { memorySql } from './helpers/sqlite.js';

const T0 = new Date('2026-11-25T10:00:00.000Z');

function store(now = () => T0) {
  let n = 0;
  return new RunStore(memorySql(), now, () => `run-${String(++n)}`);
}

describe('RunStore runs (ADR 0023)', () => {
  it('makes its own ids and starts runs as running', () => {
    const s = store();
    const id = s.start('backlog-review');
    expect(id).toBe('run-1');
    expect(s.get(id)).toMatchObject({
      agentId: 'backlog-review',
      status: 'running',
      killed: false,
    });
  });

  it('allows depth 1 only: a child cannot have children', () => {
    const s = store();
    const parent = s.start('a');
    const child = s.start('a', parent);
    expect(() => s.start('a', child)).toThrow(/cannot delegate/);
    expect(() => s.start('other-agent', parent)).toThrow(/unknown parent/);
    expect(() => s.start('a', 'made-up')).toThrow(/unknown parent/);
  });

  it('refuses a child of a finished or killed parent', () => {
    const s = store();
    const p1 = s.start('a');
    s.finish(p1, 'done');
    expect(() => s.start('a', p1)).toThrow(/not running/);
    const p2 = s.start('a');
    s.kill(p2);
    expect(() => s.start('a', p2)).toThrow(/not running/);
  });

  it('kills the whole tree, and a child sees its parent killed', () => {
    const s = store();
    const parent = s.start('a');
    const c1 = s.start('a', parent);
    const c2 = s.start('a', parent);
    const other = s.start('a');
    expect(s.kill(parent)).toBe(3);
    expect([parent, c1, c2].map((r) => s.isKilled(r))).toEqual([true, true, true]);
    expect(s.isKilled(other)).toBe(false);
    expect(s.get(c1)?.status).toBe('killed');
    expect(s.kill(parent)).toBe(0);
  });

  it('a kill of one child leaves its parent and siblings running', () => {
    const s = store();
    const parent = s.start('a');
    const c1 = s.start('a', parent);
    const c2 = s.start('a', parent);
    s.kill(c1);
    expect([s.isKilled(parent), s.isKilled(c1), s.isKilled(c2)]).toEqual([false, true, false]);
  });

  it('treats an unknown run as killed (fail closed)', () => {
    expect(store().isKilled('nope')).toBe(true);
  });

  it('sums spend across the tree for the daily budget, within the window only', () => {
    let now = new Date(T0.getTime() - 25 * 3_600_000);
    const s = store(() => now);
    const old = s.start('a');
    s.addSpend(old, 5);
    now = T0;
    const parent = s.start('a');
    const child = s.start('a', parent);
    s.addSpend(parent, 0.5);
    s.addSpend(child, 0.25);
    const ledger = storeLedger(s, 'a', child, () => now);
    return ledger.spentToday().then((v) => {
      expect(v).toBeCloseTo(0.75);
      expect(() => {
        s.addSpend(parent, -1);
      }).toThrow();
      expect(() => {
        s.addSpend(parent, Number.NaN);
      }).toThrow();
    });
  });
});

describe('RunStore events (ADR 0023, ADR 0016)', () => {
  it('stores per-round events with the parent run id, and lists a tree', () => {
    const s = store();
    const parent = s.start('a');
    const child = s.start('a', parent);
    s.recordEvent({
      runId: parent,
      round: 1,
      tool: 'issue',
      args: { n: 7 },
      resultSize: 120,
      modelText: 'reading',
    });
    s.recordEvent({
      runId: child,
      round: 1,
      tool: null,
      args: null,
      resultSize: 0,
      modelText: '{"ok":true}',
    });
    const events = s.listEvents(parent);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      runId: parent,
      parentRunId: null,
      tool: 'issue',
      args: '{"n":7}',
    });
    expect(events[1]).toMatchObject({ runId: child, parentRunId: parent, tool: null });
    expect(s.listEvents(child)).toHaveLength(1);
    expect(() => {
      s.recordEvent({ runId: 'x', round: 1, tool: null, args: null, resultSize: 0, modelText: '' });
    }).toThrow();
  });

  it('caps model text at 8,000 characters', () => {
    const s = store();
    const id = s.start('a');
    s.recordEvent({
      runId: id,
      round: 1,
      tool: null,
      args: null,
      resultSize: 0,
      modelText: 'x'.repeat(20_000),
    });
    const text = s.listEvents(id)[0]?.modelText ?? '';
    expect(text.length).toBeLessThan(MODEL_TEXT_CAP + 20);
    expect(text.endsWith('[clipped]')).toBe(true);
  });

  it('never stores token-shaped strings (canary)', () => {
    const canaries = [
      'ghp_' + 'A'.repeat(36),
      'github_pat_' + 'B'.repeat(40),
      'sk-ant-api03-' + 'C'.repeat(30),
      'sk-or-v1-' + 'D'.repeat(30),
      'Bearer ' + 'E'.repeat(30),
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12',
    ];
    const s = store();
    const id = s.start('a');
    for (const c of canaries)
      s.recordEvent({
        runId: id,
        round: 1,
        tool: 'issue',
        args: { q: `token ${c}` },
        resultSize: 1,
        modelText: `see ${c} here`,
      });
    const all = JSON.stringify(s.listEvents(id));
    for (const c of canaries) expect(all).not.toContain(c);
    expect(redact('plain text with no token')).toBe('plain text with no token');
  });

  it('prunes events and runs past 14 days, crashed `running` ones too', () => {
    let now = T0;
    const s = store(() => now);
    const done = s.start('a');
    s.recordEvent({
      runId: done,
      round: 1,
      tool: null,
      args: null,
      resultSize: 0,
      modelText: 'old',
    });
    s.finish(done, 'done');
    const crashed = s.start('a');
    now = new Date(T0.getTime() + EVENT_RETENTION_MS + 1);
    const fresh = s.start('a');
    s.prune();
    expect(s.get(done)).toBeNull();
    expect(s.get(crashed)).toBeNull();
    expect(s.listEvents(done)).toEqual([]);
    expect(s.get(fresh)).not.toBeNull();
  });
});

describe('RunStore HOTL slots per run tree (ADR 0023)', () => {
  it("counts on the root run, so children share the tree's slots", () => {
    const s = store();
    const parent = s.start('a');
    const c1 = s.start('a', parent);
    const c2 = s.start('a', parent);
    expect(s.takeHotlSlot(c1, 2)).toBe(true);
    expect(s.takeHotlSlot(parent, 2)).toBe(true);
    expect(s.takeHotlSlot(c2, 2)).toBe(false);
    const other = s.start('a');
    expect(s.takeHotlSlot(other, 2)).toBe(true);
  });

  it('gives an unknown run no slot', () => {
    expect(store().takeHotlSlot('made-up', 10)).toBe(false);
  });
});

describe('runGuard', () => {
  it('throws when the run or its parent is killed, or the broker says halted', async () => {
    const s = store();
    const parent = s.start('a');
    const child = s.start('a', parent);
    let halted = false;
    const broker = () => (halted ? Promise.reject(new Error('halted')) : Promise.resolve());
    const guard = runGuard(s, child, broker);
    await expect(guard()).resolves.toBeUndefined();
    halted = true;
    await expect(guard()).rejects.toThrow('halted');
    halted = false;
    expect(s.kill(parent)).toBe(2);
    await expect(guard()).rejects.toThrow('run killed');
  });
});
