import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Who may decide approvals and mint approval tokens is fixed by bindings (ADR 0017 amendment):
 * only the gateway binds the broker's `BrokerAdmin` entrypoint, and only the broker itself binds
 * its `Keyring` and its audit database. A one-line wrangler change could undo that, so it is
 * pinned here for every Worker in the repository.
 */
interface Bindings {
  services?: { binding: string; service: string; entrypoint?: string }[];
  durable_objects?: { bindings: { name: string; class_name: string; script_name?: string }[] };
  d1_databases?: { binding: string; database_id: string }[];
  env?: Record<string, unknown>;
}

const WORKERS = new URL('../../../workers/', import.meta.url);

/** wrangler.jsonc without comments or trailing commas; anything else makes JSON.parse throw. */
function readWrangler(worker: string): Bindings {
  const text = readFileSync(new URL(`${worker}/wrangler.jsonc`, WORKERS), 'utf8');
  const json = text
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(json) as Bindings;
}

const BROKER = 'custodes-github-broker';
const workers = readdirSync(WORKERS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const others = workers.filter((w) => w !== 'github-broker');
const auditDb = readWrangler('github-broker').d1_databases?.find((d) => d.binding === 'AUDIT');

describe('bindings that carry approval authority', () => {
  it('reads every Worker, with no per-environment overrides that this test would not see', () => {
    expect(workers).toEqual(expect.arrayContaining(['agents', 'gateway', 'github-broker']));
    for (const w of workers) expect(readWrangler(w).env, w).toBeUndefined();
    expect(auditDb?.database_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('give the gateway, and only the gateway, the broker admin entrypoint', () => {
    const gateway = readWrangler('gateway').services?.find((s) => s.service === BROKER);
    expect(gateway?.entrypoint).toBe('BrokerAdmin');
    for (const w of others.filter((x) => x !== 'gateway'))
      for (const s of readWrangler(w).services?.filter((x) => x.service === BROKER) ?? [])
        expect(s.entrypoint, w).toBeUndefined();
  });

  it('let no other Worker reach the Keyring or the audit database', () => {
    for (const w of others) {
      const b = readWrangler(w);
      expect(
        (b.durable_objects?.bindings ?? []).filter(
          (d) => d.class_name === 'Keyring' || d.script_name === BROKER,
        ),
        w,
      ).toEqual([]);
      expect(
        (b.d1_databases ?? []).filter((d) => d.database_id === auditDb?.database_id),
        w,
      ).toEqual([]);
    }
  });
});
