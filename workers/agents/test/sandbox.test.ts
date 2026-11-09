import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { testKillSwitch } from './helpers/halt-state.js';
import type { AgentsEnv } from '../src/env.js';
import {
  AGENT_CLASSES,
  allowedAgentPath,
  INSTANCE_REPOS,
  instanceOf,
  OWASP_INSTANCE,
  SANDBOX_INSTANCE,
  UnknownInstanceError,
} from '../src/instances.js';
import { exemption } from '../src/agents/pr-gate/rules.js';
import { CHEATSHEET_REVIEW_MANIFEST } from '../src/agents/cheatsheet-review.js';
import { PR_GATE_MANIFEST } from '../src/agents/pr-gate.js';
import { TRIAGE_MANIFEST } from '../src/agents/triage.js';
import type { PublicPull } from '../src/agents/triage/github.js';
import policy from '../../github-broker/policy/policy.json';

const testEnv = env as AgentsEnv;
const ctx = {} as ExecutionContext;
const call = (path: string, method = 'GET') =>
  worker.fetch(new Request(`https://x${path}`, { method }), testEnv, ctx);

describe('instances', () => {
  it('maps instance names to repositories and nothing else', () => {
    expect(instanceOf(OWASP_INSTANCE)).toEqual({
      repo: 'OWASP/CheatSheetSeries',
      sandbox: false,
      reviewTrigger: { label: 'custodes_cheatsheet_review', actor: 'mackowski' },
    });
    expect(instanceOf(SANDBOX_INSTANCE)).toEqual({
      repo: 'mackowski/custodes-sandbox',
      sandbox: true,
      reviewTrigger: { label: 'custodes_cheatsheet_review', actor: 'mackowski' },
    });
    for (const bad of ['default', 'test', '__proto__', 'constructor', 'toString', ''])
      expect(() => instanceOf(bad)).toThrow(UnknownInstanceError);
  });

  it('every instance repository is in each agent manifest and in the broker policy', () => {
    for (const repo of INSTANCE_REPOS) {
      expect(TRIAGE_MANIFEST.repos).toContain(repo);
      expect(PR_GATE_MANIFEST.repos).toContain(repo);
      expect(policy.agents['pr-gate'].repos).toContain(repo);
      for (const [id, r] of Object.entries(policy.reads))
        if (id !== 'cheatsheet-review') expect(r.repos).toContain(repo);
    }
  });

  it('runs cheatsheet-review on the sandbox and OWASP, approving every OWASP post (ADR 0017)', () => {
    const both = ['mackowski/custodes-sandbox', 'OWASP/CheatSheetSeries'];
    expect(CHEATSHEET_REVIEW_MANIFEST.repos).toEqual(both);
    expect(policy.agents['cheatsheet-review'].repos).toEqual(both);
    expect(policy.reads['cheatsheet-review'].repos).toEqual(both);
    expect(policy.agents['cheatsheet-review'].requiresApprovalOn).toEqual({
      'OWASP/CheatSheetSeries': ['pr.review.inline'],
    });
  });
});

describe('pr-gate maintainer exemption in the sandbox', () => {
  const pr = (over: Partial<PublicPull>): PublicPull => ({
    number: 1,
    title: 't',
    html_url: 'https://github.com/mackowski/custodes-sandbox/pull/1',
    state: 'open',
    user: { login: 'mackowski', type: 'User' },
    author_association: 'OWNER',
    labels: [],
    created_at: '2026-10-15T00:00:00Z',
    updated_at: '2026-10-15T00:00:00Z',
    head: { sha: 'a' },
    ...over,
  });

  it('gates the owner when asked, but bots and dependabot stay exempt', () => {
    expect(exemption(pr({}))).toBe('maintainer');
    expect(exemption(pr({}), { gateMaintainers: true })).toBeNull();
    expect(
      exemption(pr({ user: { login: 'dependabot[bot]', type: 'Bot' } }), { gateMaintainers: true }),
    ).toBe('dependabot');
    expect(exemption(pr({ draft: true }), { gateMaintainers: true })).toBe('draft');
  });
});

describe('on-demand routes', () => {
  it('refuse on-demand runs on the real repository', async () => {
    for (const path of [
      `/agents/pr-gate-agent/${OWASP_INSTANCE}/run`,
      `/agents/pr-gate-agent/${OWASP_INSTANCE}/summary`,
      `/agents/triage-agent/${OWASP_INSTANCE}/run`,
      `/agents/triage-agent/${OWASP_INSTANCE}/digest`,
    ]) {
      const res = await call(path, 'POST');
      expect(res.status, path).toBe(403);
    }
  });

  it('answer 404 for an instance that is not listed, for every agent class', async () => {
    expect((await call('/agents/pr-gate-agent/somewhere-else')).status).toBe(404);
    expect((await call('/agents/triage-agent/somewhere-else/run', 'POST')).status).toBe(404);
    expect((await call('/agents/proposal-review-agent/anything')).status).toBe(404);
    expect((await call('/agents/hello-agent/other')).status).toBe(404);
  });

  it('decides instance paths before any Durable Object is created', () => {
    expect(allowedAgentPath('/registry')).toBe(true);
    expect(allowedAgentPath(`/agents/triage-agent/${OWASP_INSTANCE}`)).toBe(true);
    expect(allowedAgentPath(`/agents/pr-gate-agent/${SANDBOX_INSTANCE}/run`)).toBe(true);
    // The removed hello agent is no longer routable (#103).
    expect(allowedAgentPath('/agents/hello-agent/default/run')).toBe(false);
    expect(allowedAgentPath('/agents/triage-agent/__proto__')).toBe(false);
    expect(allowedAgentPath('/agents/triage-agent/%E0%A4%A')).toBe(false);
    expect(allowedAgentPath('/agents/triage-agent/custodes%2Dsandbox')).toBe(true);
    // Only agent classes: never a Worker's Keyholder or any other Durable Object (ADR 0018).
    expect(allowedAgentPath(`/agents/keyholder/${OWASP_INSTANCE}`)).toBe(false);
    expect(allowedAgentPath('/agents/keyholder/default')).toBe(false);
    expect(allowedAgentPath(`/agents/not-an-agent/${OWASP_INSTANCE}`)).toBe(false);
    // Empty segments are dropped by the SDK router, so they must not skip the check.
    expect(allowedAgentPath('/agents//keyholder/default')).toBe(false);
    expect(allowedAgentPath('/agents/keyholder//default')).toBe(false);
    expect(allowedAgentPath('/agents//pr-gate-agent/evil')).toBe(false);
    expect(allowedAgentPath(`/agents//pr-gate-agent/${SANDBOX_INSTANCE}`)).toBe(true);
  });

  it('makes every agent class this Worker exports routable, and nothing else', async () => {
    const exported = Object.keys(await import('../src/index.js')).filter((k) =>
      k.endsWith('Agent'),
    );
    const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    expect(new Set(exported.map(kebab))).toEqual(AGENT_CLASSES);
  });

  it('preview the sandbox summary without sending it', async () => {
    const res = await call(`/agents/pr-gate-agent/${SANDBOX_INSTANCE}/report`);
    expect(res.status).toBe(200);
    const mail = await res.json<{ subject: string; text: string; html: string }>();
    expect(mail.subject).toContain('mackowski/custodes-sandbox');
  });

  it('runs pr-gate on the sandbox on demand (the stub broker refuses the read)', async () => {
    const res = await call(`/agents/pr-gate-agent/${SANDBOX_INSTANCE}/run`, 'POST');
    expect(res.status).toBe(200);
    const out = await res.json<{ ok: boolean; detail: string }>();
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/^list pulls failed/);
  });

  it('respects the kill switch read through the (stub) broker, end to end', async () => {
    // Was hello.test.ts: the Worker reads its halt flag from the broker's /v1/state (#103, T1).
    await testKillSwitch().halt('pr-gate', 'test', 'tester');
    try {
      const res = await call(`/agents/pr-gate-agent/${SANDBOX_INSTANCE}/run`, 'POST');
      const out = await res.json<{ ok: boolean; detail: string }>();
      expect(out.ok).toBe(false);
      expect(out.detail).not.toMatch(/^list pulls failed/); // stopped before any read
    } finally {
      await testKillSwitch().resume('pr-gate');
    }
  });

  it('lists the registry without the removed hello agent', async () => {
    const res = await call('/registry');
    const ids = (await res.json<{ id: string }[]>()).map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'triage',
        'implementation-check',
        'proposal-review',
        'pr-gate',
        'cheatsheet-review',
      ]),
    );
    expect(ids).not.toContain('hello');
  });
});

describe('Keyholder surface (ADR 0018, threat I1)', () => {
  it('exposes exactly the documented methods over RPC, none of which returns key material', async () => {
    const { Keyholder } = await import('@custodes/core/keyholder');
    const { DurableObject } = await import('cloudflare:workers');
    // Nothing between it and the runtime base class could add reachable members.
    expect(Object.getPrototypeOf(Keyholder.prototype)).toBe(DurableObject.prototype);
    // A plain method's descriptor has `value`; a getter's (reachable over RPC) does not.
    for (const name of Object.getOwnPropertyNames(Keyholder.prototype))
      expect(
        'value' in (Object.getOwnPropertyDescriptor(Keyholder.prototype, name) ?? {}),
        name,
      ).toBe(true);
    expect(Object.getOwnPropertyNames(Keyholder.prototype).sort()).toEqual(
      ['constructor', 'signRequest', 'publicKeys', 'rotate', 'activateNextIfAccepted'].sort(),
    );
  });
});

describe('KeyAdmin surface (ADR 0018)', () => {
  it('offers the gateway public keys and Rotate only', async () => {
    const { KeyAdmin } = await import('@custodes/core/keyholder');
    const { WorkerEntrypoint } = await import('cloudflare:workers');
    expect(Object.getPrototypeOf(KeyAdmin.prototype)).toBe(WorkerEntrypoint.prototype);
    // Every own property of the prototype is reachable over RPC, getters included.
    for (const name of Object.getOwnPropertyNames(KeyAdmin.prototype)) {
      const d = Object.getOwnPropertyDescriptor(KeyAdmin.prototype, name) ?? {};
      expect('value' in d, `${name} must not be a getter`).toBe(true);
    }
    expect(Object.getOwnPropertyNames(KeyAdmin.prototype).sort()).toEqual(
      ['constructor', 'publicKeys', 'rotate'].sort(),
    );
  });
});
