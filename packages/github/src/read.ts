import type { BrokerReadRequest } from '@custodes/schema';
import type { GitHubIdentity } from './identity.js';

/** Builds the GitHub API path for an allow-listed read. Pure; the only place paths are formed. */
export function buildReadPath(req: Pick<BrokerReadRequest, 'repo' | 'resource' | 'query'>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) if (v !== undefined) q.set(k, String(v));
  const qs = q.toString();
  switch (req.resource) {
    case 'issues':
      return `/repos/${req.repo}/issues${qs ? `?${qs}` : ''}`;
    case 'labels':
      return `/repos/${req.repo}/labels?per_page=${req.query.per_page ?? 100}`;
    case 'cheatsheets':
      return `/repos/${req.repo}/contents/cheatsheets`;
  }
}

export type ReadResult =
  { ok: true; data: unknown } | { ok: false; status: number; rateLimited: boolean };

/** GET-only GitHub client used by the broker for agent reads. There is no write method. */
export class GitHubReadClient {
  constructor(
    private readonly identity: GitHubIdentity,
    // Wrapped, not bare: calling the global fetch as a method throws "Illegal invocation" in Workers.
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async get(path: string): Promise<ReadResult> {
    const res = await this.fetchImpl(`https://api.github.com${path}`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${await this.identity.token()}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': `custodes/${this.identity.agentId}`,
      },
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        rateLimited: res.headers.get('x-ratelimit-remaining') === '0',
      };
    }
    return { ok: true, data: await res.json() };
  }
}
