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
  workers_dev?: boolean;
  preview_urls?: boolean;
  routes?: unknown[];
  vars?: Record<string, string>;
  send_email?: { name: string; allowed_destination_addresses?: string[] }[];
  queues?: { consumers?: { queue: string }[]; producers?: { queue: string }[] };
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
/** The shared agents Worker: it runs no agent and has no broker binding; the gateway lists its registry. */
const SHARED = 'custodes-agents';
/**
 * Broker entrypoint → the one Worker (wrangler `name`) allowed to bind it (ADR 0018). Mirrors
 * CALLER_ENTRYPOINTS in workers/github-broker/src/callers.ts; a test below keeps them in step.
 */
const owner: Record<string, string> = {
  PrGateBroker: 'custodes-pr-gate',
  CheatsheetReviewBroker: 'custodes-cheatsheet-review',
  TriageBroker: 'custodes-triage',
  TriageApplyBroker: 'custodes-triage-apply',
};
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
    // Names are what the binding checks below compare; two directories with one name would pass.
    const names = workers.map((w) => readWrangler(w).name);
    expect(new Set(names).size, names.join(',')).toBe(names.length);
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
    const brokerSrc = readFileSync(new URL('github-broker/src/index.ts', WORKERS), 'utf8');
    const exported = [...brokerSrc.matchAll(/export class (\w+) extends WorkerEntrypoint/g)].map(
      (m) => m[1],
    );
    expect(exported.sort()).toEqual([...Object.keys(owner), 'BrokerAdmin'].sort());
    for (const w of others) {
      const b = readWrangler(w);
      const toBroker = b.services?.filter((x) => x.service === BROKER) ?? [];
      // One broker binding per Worker: a second one would be a second identity.
      expect(toBroker.length, w).toBeLessThanOrEqual(1);
      for (const s of toBroker) {
        if (s.entrypoint === 'BrokerAdmin') continue;
        // No Worker binds the unsigned default entrypoint any more: every agent runs in its own
        // Worker with its own signed one, and the default refuses every agent id anyway.
        expect(s.entrypoint, `${w} binds the broker's unsigned default entrypoint`).toBeDefined();
        expect(owner[s.entrypoint ?? ''], `${w} binds ${s.entrypoint}`).toBe(b.name);
      }
    }
  });

  it('give a Worker with a Keyholder only a signed broker entrypoint (its key probe needs one)', () => {
    for (const w of workers) {
      const b = readWrangler(w);
      if (!(b.durable_objects?.bindings ?? []).some((d) => d.class_name === 'Keyholder')) continue;
      const toBroker = b.services?.filter((x) => x.service === BROKER) ?? [];
      expect(toBroker.length, w).toBe(1);
      expect(owner[toBroker[0]?.entrypoint ?? ''], `${w} must bind its own signed entrypoint`).toBe(
        b.name,
      );
    }
  });

  it('let no Worker reach an agent Worker directly (they share no binding)', () => {
    // The shared Worker counts too: binding it would reach the unmigrated agents without Access.
    const agentWorkers = new Set([...Object.values(owner), SHARED]);
    for (const w of workers) {
      const b = readWrangler(w);
      for (const s of b.services ?? []) {
        // The gateway (behind Access) may reach the shared Worker over HTTP, and a per-agent Worker
        // over HTTP or through its KeyAdmin entrypoint (public keys and Rotate only, ADR 0018).
        const fromGateway = b.name === 'custodes-gateway';
        // ADR 0019: triage hands proposals to triage-apply through its RPC entrypoint only.
        const triageToApply =
          b.name === 'custodes-triage' &&
          s.service === 'custodes-triage-apply' &&
          s.entrypoint === 'TriageApplyIntake';
        const allowed =
          s.service === b.name ||
          triageToApply ||
          (fromGateway && s.service === SHARED && s.entrypoint === undefined) ||
          (fromGateway &&
            Object.values(owner).includes(s.service) &&
            (s.entrypoint === undefined || s.entrypoint === 'KeyAdmin'));
        expect(agentWorkers.has(s.service) && !allowed, `${w} binds ${s.service}`).toBe(false);
      }
      for (const d of b.durable_objects?.bindings ?? [])
        expect(
          d.script_name !== undefined && agentWorkers.has(d.script_name),
          `${w} binds a Durable Object of ${d.script_name ?? ''}`,
        ).toBe(false);
    }
  });

  it('let only custodes-triage bind the triage-apply intake (ADR 0019)', () => {
    for (const w of workers)
      for (const s of readWrangler(w).services ?? [])
        if (s.service === 'custodes-triage-apply' && s.entrypoint === 'TriageApplyIntake')
          expect(readWrangler(w).name, w).toBe('custodes-triage');
    const triage = readWrangler('triage').services?.find((s) => s.binding === 'TRIAGE_APPLY');
    expect(triage).toEqual({
      binding: 'TRIAGE_APPLY',
      service: 'custodes-triage-apply',
      entrypoint: 'TriageApplyIntake',
    });
    // The shared Worker must not get a write path before triage moves out of it.
    expect(
      readWrangler('agents').services?.some((s) => s.service === 'custodes-triage-apply') ?? false,
    ).toBe(false);
  });

  it('keep agent Workers off the internet: no workers.dev, previews or routes (ADR 0018)', () => {
    const agentWorkers = new Set([...Object.values(owner), SHARED]);
    for (const w of workers) {
      const b = readWrangler(w);
      if (!agentWorkers.has(b.name ?? '')) continue;
      expect(b.workers_dev, `${w} workers_dev`).toBe(false);
      expect(b.preview_urls, `${w} preview_urls`).toBe(false);
      expect(b.routes ?? [], `${w} routes`).toEqual([]);
      expect((b as { route?: unknown }).route, `${w} route`).toBeUndefined();
    }
  });

  it('let CALLER_NAME only name the Worker itself, and only where a Keyholder signs', () => {
    for (const w of workers) {
      const b = readWrangler(w);
      const caller = b.vars?.['CALLER_NAME'];
      const keyholder = (b.durable_objects?.bindings ?? []).some(
        (d) => d.class_name === 'Keyholder',
      );
      expect(caller === undefined, `${w}: CALLER_NAME and Keyholder go together`).toBe(!keyholder);
      if (caller !== undefined) expect(caller, w).toBe(b.name);
    }
  });

  it("let agent Workers e-mail only the operators (the gateway's approvers)", () => {
    // The shared Worker used to hold the reference list; it binds no e-mail since it runs no agent.
    const allowed = (readWrangler('gateway').vars?.['APPROVER_EMAILS'] ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a !== '');
    expect(allowed.length).toBeGreaterThan(0);
    expect(readWrangler('agents').send_email, 'custodes-agents runs no agent').toBeUndefined();
    let bound = 0;
    for (const w of workers)
      for (const e of readWrangler(w).send_email ?? []) {
        bound += 1;
        expect(e.allowed_destination_addresses, `${w} ${e.name}`).toEqual(allowed);
      }
    expect(bound).toBeGreaterThan(0);
  });

  it('keep custodes-agents empty: no binding, var, queue, cron or agent class (ADR 0018)', () => {
    // It runs no agent and must not get one back quietly (review of #122, L1).
    const shared = readWrangler('agents') as Bindings & Record<string, unknown>;
    for (const key of [
      'services',
      'ai',
      'kv_namespaces',
      'd1_databases',
      'r2_buckets',
      'durable_objects',
      'queues',
      'send_email',
      'vars',
      'secrets_store_secrets',
      'workflows',
    ])
      expect(shared[key], `custodes-agents has ${key}`).toBeUndefined();
    expect((shared['triggers'] as { crons?: unknown[] } | undefined)?.crons).toEqual([]);
    const exportsLive = Object.entries(
      (shared['exports'] ?? {}) as Record<string, { state?: string }>,
    ).filter(([, e]) => e.state === undefined);
    expect(exportsLive, 'a live Durable Object class in custodes-agents').toEqual([]);
    const index = readFileSync(new URL('agents/src/index.ts', WORKERS), 'utf8');
    expect(index, 'custodes-agents exports a class').not.toMatch(/^export (\{|class)/m);
  });

  it('give every queue one consumer Worker', () => {
    const consumers = workers.flatMap((w) =>
      (readWrangler(w).queues?.consumers ?? []).map((c) => c.queue),
    );
    expect(new Set(consumers).size, consumers.join(',')).toBe(consumers.length);
  });
});
