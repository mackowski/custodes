import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import type { AgentsEnv } from '../src/env.js';
import {
  allowedAgentPath,
  INSTANCE_REPOS,
  instanceOf,
  OWASP_INSTANCE,
  SANDBOX_INSTANCE,
  UnknownInstanceError,
} from '../src/instances.js';
import { exemption } from '../src/agents/pr-gate/rules.js';
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
    expect(instanceOf(OWASP_INSTANCE)).toEqual({ repo: 'OWASP/CheatSheetSeries', sandbox: false });
    expect(instanceOf(SANDBOX_INSTANCE)).toEqual({
      repo: 'mackowski/custodes-sandbox',
      sandbox: true,
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

  it('keeps cheatsheet-review on the sandbox until its evals pass (ADR 0017)', () => {
    expect(policy.agents['cheatsheet-review'].repos).toEqual(['mackowski/custodes-sandbox']);
    expect(policy.reads['cheatsheet-review'].repos).toEqual(['mackowski/custodes-sandbox']);
  });

  it('keeps the hello agent off the sandbox', () => {
    expect(policy.agents.hello.repos).toEqual(['OWASP/CheatSheetSeries']);
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
    expect(allowedAgentPath('/agents/hello-agent/default/run')).toBe(true);
    expect(allowedAgentPath('/agents/hello-agent/owasp-cheatsheetseries')).toBe(false);
    expect(allowedAgentPath('/agents/triage-agent/__proto__')).toBe(false);
    expect(allowedAgentPath('/agents/triage-agent/%E0%A4%A')).toBe(false);
    expect(allowedAgentPath('/agents/triage-agent/custodes%2Dsandbox')).toBe(true);
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
});
