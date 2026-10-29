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

describe('executeAction pr.close', () => {
  const action = { type: 'pr.close' as const, repo: 'o/r', pull: 7, body: 'reason' };

  it('posts the decorated comment first, then closes the pull request, and never merges', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? '', body: JSON.parse(init.body as string) });
      return Promise.resolve(
        Response.json({ html_url: 'https://github.com/o/r/pull/7#c', state: 'closed' }),
      );
    });
    const api = new GitHubRest(id, fetchMock as unknown as typeof fetch);
    const r = await executeAction(api, action, (b) => `${b}\n--trailer`);
    expect(r.githubUrl).toBe('https://github.com/o/r/pull/7#c');
    expect(calls).toEqual([
      {
        url: 'https://api.github.com/repos/o/r/issues/7/comments',
        method: 'POST',
        body: { body: 'reason\n--trailer' },
      },
      {
        url: 'https://api.github.com/repos/o/r/pulls/7',
        method: 'PATCH',
        body: { state: 'closed' },
      },
    ]);
  });

  it('does not close the pull request when the comment fails', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('forbidden', { status: 403 })));
    const api = new GitHubRest(id, fetchMock);
    await expect(executeAction(api, action, (b) => b)).rejects.toThrow(/GitHub 403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('/issues/7/comments');
  });
});

describe('executeAction pr.review.inline', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  it('posts one review pinned to the commit, trailers on the body only, multi-line ranges mapped', async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        Response.json({ html_url: 'https://github.com/o/r/pull/7#pullrequestreview-1' }),
      ),
    );
    const api = new GitHubRest(id, fetchMock as unknown as typeof fetch);
    const r = await executeAction(
      api,
      {
        type: 'pr.review.inline',
        repo: 'o/r',
        pull: 7,
        commitId: sha,
        event: 'REQUEST_CHANGES',
        body: 'summary',
        comments: [
          { path: 'cheatsheets/A.md', line: 12, side: 'RIGHT', body: 'one' },
          { path: 'cheatsheets/A.md', line: 20, startLine: 18, side: 'RIGHT', body: 'range' },
        ],
      },
      (b) => `${b}\n--trailer`,
    );
    expect(r.githubUrl).toContain('pullrequestreview');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/o/r/pulls/7/reviews');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      commit_id: sha,
      event: 'REQUEST_CHANGES',
      body: 'summary\n--trailer',
      comments: [
        { path: 'cheatsheets/A.md', line: 12, side: 'RIGHT', body: 'one' },
        {
          path: 'cheatsheets/A.md',
          line: 20,
          side: 'RIGHT',
          body: 'range',
          start_line: 18,
          start_side: 'RIGHT',
        },
      ],
    });
  });

  it('does not leak comment bodies into errors', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('Unprocessable', { status: 422 })));
    const api = new GitHubRest(id, fetchMock);
    const p = api.createInlinePullReview('o/r', 7, {
      commitId: sha,
      event: 'COMMENT',
      body: 'SECRET-BODY',
      comments: [{ path: 'a.md', line: 1, side: 'RIGHT', body: 'SECRET-COMMENT' }],
    });
    await expect(p).rejects.toThrow(/GitHub 422/);
    await expect(p).rejects.not.toThrow(/SECRET/);
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

  it('builds numbered and file resources from validated fields only', async () => {
    const { buildReadPath } = await import('../src/read.js');
    expect(buildReadPath({ repo: 'o/r', resource: 'issue', query: {}, number: 7 })).toBe(
      '/repos/o/r/issues/7',
    );
    expect(
      buildReadPath({
        repo: 'o/r',
        resource: 'timeline',
        query: { page: 2, state: 'all' },
        number: 7,
      }),
    ).toBe('/repos/o/r/issues/7/timeline?per_page=100&page=2');
    expect(buildReadPath({ repo: 'o/r', resource: 'comments', query: {}, number: 7 })).toBe(
      '/repos/o/r/issues/7/comments?per_page=100&page=1',
    );
    expect(buildReadPath({ repo: 'o/r', resource: 'pull', query: {}, number: 9 })).toBe(
      '/repos/o/r/pulls/9',
    );
    expect(
      buildReadPath({
        repo: 'o/r',
        resource: 'pull_file_at_ref',
        query: {},
        path: 'cheatsheets_draft/A_Cheat_Sheet.md',
        ref: '0123456789abcdef0123456789abcdef01234567',
      }),
    ).toBe(
      '/repos/o/r/contents/cheatsheets_draft/A_Cheat_Sheet.md?ref=0123456789abcdef0123456789abcdef01234567',
    );
    expect(buildReadPath({ repo: 'o/r', resource: 'pull_files', query: {}, number: 9 })).toBe(
      '/repos/o/r/pulls/9/files?per_page=100&page=1',
    );
    expect(
      buildReadPath({ repo: 'o/r', resource: 'cheatsheet', query: {}, file: 'A_Cheat_Sheet.md' }),
    ).toBe('/repos/o/r/contents/cheatsheets/A_Cheat_Sheet.md');
    expect(() => buildReadPath({ repo: 'o/r', resource: 'issue', query: {} })).toThrow();
  });

  it('passes a single label filter on issue listings', async () => {
    const { buildReadPath } = await import('../src/read.js');
    expect(
      buildReadPath({
        repo: 'o/r',
        resource: 'issues',
        query: { state: 'open', labels: 'ACK_OBTAINED' },
      }),
    ).toBe('/repos/o/r/issues?state=open&labels=ACK_OBTAINED');
  });
});

describe('buildReadPath pulls', () => {
  it('lists pull requests with defaults', async () => {
    const { buildReadPath } = await import('../src/read.js');
    expect(buildReadPath({ repo: 'o/r', resource: 'pulls', query: {} })).toBe(
      '/repos/o/r/pulls?state=open&per_page=100&page=1',
    );
  });

  it('honours state, sort, direction and paging but drops since and labels', async () => {
    const { buildReadPath } = await import('../src/read.js');
    expect(
      buildReadPath({
        repo: 'o/r',
        resource: 'pulls',
        query: {
          state: 'all',
          sort: 'updated',
          direction: 'asc',
          per_page: 30,
          page: 2,
          since: '2026-09-01T00:00:00Z',
          labels: 'ACK_OBTAINED',
        },
      }),
    ).toBe('/repos/o/r/pulls?state=all&sort=updated&direction=asc&per_page=30&page=2');
  });

  it('maps the issues sort "comments" to the pulls sort "popularity"', async () => {
    const { buildReadPath } = await import('../src/read.js');
    expect(buildReadPath({ repo: 'o/r', resource: 'pulls', query: { sort: 'comments' } })).toBe(
      '/repos/o/r/pulls?state=open&sort=popularity&per_page=100&page=1',
    );
  });
});
