import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Who may decide approvals and mint approval tokens is fixed by bindings (ADR 0017 amendment):
 * only the gateway binds the broker's `BrokerAdmin` entrypoint, and only the broker itself binds
 * its `Keyring` and its audit database. A one-line wrangler change could undo that, so it is
 * pinned here for every Worker in the repository.
 */
interface Bindings {
  name?: string;
  services?: { binding: string; service: string; entrypoint?: string }[];
  durable_objects?: { bindings: { name: string; class_name: string; script_name?: string }[] };
  d1_databases?: { binding: string; database_id: string }[];
  kv_namespaces?: { binding: string; id: string }[];
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
const killSwitch = readWrangler('github-broker').kv_namespaces?.find(
  (k) => k.binding === 'KILL_SWITCH',
);

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
        expect(s.entrypoint, w).not.toBe('BrokerAdmin');
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

  it('let only the broker and the gateway bind the kill switch (a KV binding can also write)', () => {
    expect(killSwitch?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(readWrangler('gateway').kv_namespaces?.map((k) => k.id)).toContain(killSwitch?.id);
    for (const w of others.filter((x) => x !== 'gateway')) {
      const kv = readWrangler(w).kv_namespaces ?? [];
      expect(
        kv.filter((k) => k.id === killSwitch?.id || k.binding === 'KILL_SWITCH'),
        w,
      ).toEqual([]);
    }
  });

  it('let each agent Worker bind only its own broker entrypoint (ADR 0018)', () => {
    // Entrypoint → the one Worker (wrangler `name`) allowed to bind it. Mirrors CALLER_ENTRYPOINTS
    // in workers/github-broker/src/callers.ts; the next assertion keeps the two in step.
    const owner: Record<string, string> = {
      PrGateBroker: 'custodes-pr-gate',
      CheatsheetReviewBroker: 'custodes-cheatsheet-review',
      TriageBroker: 'custodes-triage',
    };
    const brokerSrc = readFileSync(new URL('github-broker/src/index.ts', WORKERS), 'utf8');
    const exported = [...brokerSrc.matchAll(/export class (\w+) extends WorkerEntrypoint/g)].map(
      (m) => m[1],
    );
    expect(exported.sort()).toEqual([...Object.keys(owner), 'BrokerAdmin'].sort());
    for (const w of others) {
      const b = readWrangler(w);
      for (const s of b.services?.filter((x) => x.service === BROKER) ?? []) {
        if (s.entrypoint === undefined || s.entrypoint === 'BrokerAdmin') continue;
        expect(owner[s.entrypoint], `${w} binds ${s.entrypoint}`).toBe(b.name);
      }
    }
  });
});
