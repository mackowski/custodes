import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * What a finished agent cutover leaves behind (ADR 0018, docs/runbooks/agent-cutover.md), derived
 * from scripts/agent-moves.json, so the next agent's follow-up cannot forget one of them (security
 * review of #111: `isolated` and the deploy guard were hand-kept lists).
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
const policy = JSON.parse(read('workers/github-broker/policy/policy.json')) as {
  agents: Record<string, { isolated?: boolean }>;
  reads: Record<string, { isolated?: boolean }>;
};
const done = moves.filter((m) =>
  m.classes.every((c) => shared.exports?.[c]?.state === 'transferred'),
);

describe('agent moves (scripts/agent-moves.json)', () => {
  it('lists each class and each agent id once, and a Worker directory that exists', () => {
    const classes = moves.flatMap((m) => m.classes);
    const ids = moves.flatMap((m) => m.agentIds);
    expect(new Set(classes).size).toBe(classes.length);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of moves) expect(jsonc(`${m.dir}/wrangler.jsonc`).name, m.name).toBe(m.target);
  });

  it('has at least one finished move to check (triage, 2026-11-12)', () => {
    expect(done.map((m) => m.name)).toContain('triage');
  });

  it.each(done.map((m) => [m.name, m] as const))(
    'after the cutover of %s: its ids are isolated, the shared Worker keeps no binding, the target owns the classes',
    (_name, m) => {
      for (const id of m.agentIds) {
        const flags = [policy.agents[id]?.isolated, policy.reads[id]?.isolated].filter(
          (f) => f !== undefined,
        );
        expect(flags.length, `${id} has a policy entry`).toBeGreaterThan(0);
        // Without it the unsigned default entrypoint would still serve the agent's id.
        expect(flags.every(Boolean), `${id} is isolated`).toBe(true);
      }
      const target = jsonc(`${m.dir}/wrangler.jsonc`);
      for (const c of m.classes) {
        expect(
          shared.durable_objects?.bindings?.some((b) => b.class_name === c),
          c,
        ).toBe(false);
        expect(shared.exports?.[c]?.transferred_to, c).toBe(m.target);
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

  it('does not isolate an agent whose cutover has not happened', () => {
    // The reverse: `isolated` before the move would lock the agent out of the shared Worker.
    for (const m of moves.filter((x) => !done.includes(x)))
      for (const id of m.agentIds)
        expect(policy.agents[id]?.isolated ?? policy.reads[id]?.isolated ?? false, id).toBe(false);
  });
});
