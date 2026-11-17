import type { GitHubIdentity } from './identity.js';

/** What both GitHub clients (write and read) share, so a change reaches both. */
export const GITHUB_API = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';

/**
 * The default fetch. Wrapped, not bare: calling the global fetch as a method throws "Illegal
 * invocation" in Workers (the 2026-09-29 outage).
 */
export const unboundFetch: typeof fetch = (input, init) => fetch(input, init);

/** Headers of every GitHub request. Never log them: they carry the agent's token. */
export async function githubHeaders(identity: GitHubIdentity): Promise<Record<string, string>> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${await identity.token()}`,
    'x-github-api-version': GITHUB_API_VERSION,
    'user-agent': `custodes/${identity.agentId}`,
  };
}
