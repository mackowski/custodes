import { describe, expect, it, vi } from 'vitest';
import { executeAction, GitHubRest } from '../src/api.js';
import type { GitHubIdentity } from '../src/identity.js';

const id: GitHubIdentity = { kind: 'pat', agentId: 'triage', token: () => Promise.resolve('tok') };

describe('GitHubRest', () => {
  it('sends a bearer token and appends trailers to comments', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ html_url: 'https://github.com/x/y/issues/1#c' }), {
          status: 201,
        }),
      ),
    );
    const api = new GitHubRest(id, fetchMock);
    const r = await executeAction(
      api,
      { type: 'issue.comment', repo: 'x/y', issue: 1, body: 'hi' },
      (b) => `${b}\n--trailer`,
    );
    expect(r.githubUrl).toContain('issues/1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/x/y/issues/1/comments');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ body: 'hi\n--trailer' });
  });
  it('does not leak the body into errors', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('forbidden', { status: 403 })));
    const api = new GitHubRest(id, fetchMock);
    await expect(api.createIssueComment('x/y', 1, 'SECRET-BODY')).rejects.toThrow(/GitHub 403/);
    await expect(api.createIssueComment('x/y', 1, 'SECRET-BODY')).rejects.not.toThrow(
      /SECRET-BODY/,
    );
  });
});

describe('GitHubRest default fetch', () => {
  it('calls the global fetch unbound (a bound call throws "Illegal invocation" in Workers)', async () => {
    let receiver: unknown = 'not called';
    vi.stubGlobal('fetch', function (this: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- the receiver is what this test inspects
      receiver = this;
      return Promise.resolve(
        Response.json({ html_url: 'https://github.com/x/y/issues/1#c' }, { status: 201 }),
      );
    });
    try {
      await new GitHubRest(id).createIssueComment('x/y', 1, 'hi');
      expect(receiver).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('buildReadPath', () => {
  it('builds only allow-listed paths from structured input', async () => {
    const { buildReadPath } = await import('../src/read.js');
    expect(
      buildReadPath({ repo: 'OWASP/CheatSheetSeries', resource: 'cheatsheets', query: {} }),
    ).toBe('/repos/OWASP/CheatSheetSeries/contents/cheatsheets');
    expect(buildReadPath({ repo: 'o/r', resource: 'labels', query: {} })).toBe(
      '/repos/o/r/labels?per_page=100',
    );
    expect(
      buildReadPath({
        repo: 'o/r',
        resource: 'issues',
        query: { state: 'open', since: '2026-09-01T00:00:00Z', per_page: 50 },
      }),
    ).toBe('/repos/o/r/issues?state=open&since=2026-09-01T00%3A00%3A00Z&per_page=50');
  });
});
