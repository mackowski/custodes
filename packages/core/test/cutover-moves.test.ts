import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CALLER_AGENTS, CallerName } from '@custodes/schema';

/**
 * What a finished agent cutover leaves behind (ADR 0018, docs/runbooks/agent-cutover.md), derived
 * from scripts/agent-moves.json, so the deploy guard's list cannot drift from it (security review
 * of #111). Every move is done; the tombstones and the policy's `isolated` flags that recorded the
 * moves were dropped on 2026-11-16 (the default broker entrypoint refuses every agent in code).
 */
interface Move {
  target: string;
  dir: string;
  classes: string[];
  agentIds: string[];
}
interface Wrangler {
  name?: string;
  durable_objects?: { bindings?: { class_name: string }[] };
  exports?: Record<string, { state?: string; transferred_to?: string }>;
}

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), 'utf8');
const jsonc = (path: string): Wrangler =>
  JSON.parse(
    read(path)
      .split('\n')
      .map((l) => (/^\s*\/\//.test(l) ? '' : l))
      .join('\n')
      .replace(/,(\s*[}\]])/g, '$1'),
  ) as Wrangler;

const moves = Object.entries(JSON.parse(read('scripts/agent-moves.json')) as Record<string, Move>)
  .filter(([name]) => !name.startsWith('$'))
  .map(([name, m]) => ({ name, ...m }));
const shared = jsonc('workers/agents/wrangler.jsonc');
const liveInShared = (c: string): boolean =>
  (shared.exports !== undefined && c in shared.exports && shared.exports[c]?.state === undefined) ||
  (shared.durable_objects?.bindings?.some((b) => b.class_name === c) ?? false);
const done = moves.filter((m) => m.classes.every((c) => !liveInShared(c)));

describe('agent moves (scripts/agent-moves.json)', () => {
  it('lists each class and each agent id once, and a Worker directory that exists', () => {
    const classes = moves.flatMap((m) => m.classes);
    const ids = moves.flatMap((m) => m.agentIds);
    expect(new Set(classes).size).toBe(classes.length);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of moves) expect(jsonc(`${m.dir}/wrangler.jsonc`).name, m.name).toBe(m.target);
  });

  it('names exactly the agent ids its Worker may serve (CALLER_AGENTS)', () => {
    for (const m of moves) {
      const caller = CallerName.parse(m.target);
      expect([...m.agentIds].sort(), m.name).toEqual([...CALLER_AGENTS[caller]].sort());
    }
  });

  it('has every move finished (all cutovers done by 2026-11-13)', () => {
    expect(done.map((m) => m.name).sort()).toEqual(moves.map((m) => m.name).sort());
  });

  it('leaves custodes-agents with no Durable Object class at all, not even a tombstone', () => {
    expect(shared.exports).toEqual({});
    expect(shared.durable_objects?.bindings ?? []).toEqual([]);
  });

  it.each(done.map((m) => [m.name, m] as const))(
    'after the cutover of %s: the target owns the classes',
    (_name, m) => {
      const target = jsonc(`${m.dir}/wrangler.jsonc`);
      for (const c of m.classes) {
        expect(
          target.durable_objects?.bindings?.some((b) => b.class_name === c),
          c,
        ).toBe(true);
        expect(target.exports?.[c]?.state, `${c} is live in ${m.target}`).toBeUndefined();
      }
    },
  );

  it('prints a deploy-guard line for each finished move, and only those', () => {
    const out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/agent-cutover-config.ts', 'moved'],
      { cwd: new URL('.', ROOT), encoding: 'utf8' },
    );
    expect(out.trim().split('\n').filter(Boolean)).toEqual(
      done.map((m) => `${m.classes.join(',')} ${m.dir} ${m.target}`),
    );
  });
});
