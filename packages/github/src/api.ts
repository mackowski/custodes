import type { BrokerAction } from '@custodes/schema';
import type { GitHubIdentity } from './identity.js';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
  ) {
    super(`GitHub ${status} on ${path}: ${detail}`);
    this.name = 'GitHubApiError';
  }
}

/** Minimal REST client. Only the broker uses it. */
export class GitHubRest {
  constructor(
    private readonly identity: GitHubIdentity,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${await this.identity.token()}`,
        'x-github-api-version': API_VERSION,
        'user-agent': `custodes/${this.identity.agentId}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : null,
    });
    if (!res.ok) {
      // Never include the request body in the error: it may contain untrusted content.
      throw new GitHubApiError(res.status, path, (await res.text()).slice(0, 500));
    }
    return res.json<T>();
  }

  createIssueComment(repo: string, issue: number, body: string) {
    return this.call<{ html_url: string }>('POST', `/repos/${repo}/issues/${issue}/comments`, {
      body,
    });
  }
  addLabels(repo: string, issue: number, labels: string[]) {
    return this.call<unknown[]>('POST', `/repos/${repo}/issues/${issue}/labels`, { labels });
  }
  async removeLabels(repo: string, issue: number, labels: string[]) {
    for (const l of labels) {
      await this.call<unknown>(
        'DELETE',
        `/repos/${repo}/issues/${issue}/labels/${encodeURIComponent(l)}`,
      );
    }
  }
  createPullReview(repo: string, pull: number, event: string, body: string) {
    return this.call<{ html_url: string }>('POST', `/repos/${repo}/pulls/${pull}/reviews`, {
      event,
      body,
    });
  }
}

/** Executes one already-authorised action. `decorate` appends trailers to any text body. */
export async function executeAction(
  api: GitHubRest,
  action: BrokerAction,
  decorate: (body: string) => string,
): Promise<{ githubUrl?: string }> {
  switch (action.type) {
    case 'issue.comment': {
      const r = await api.createIssueComment(action.repo, action.issue, decorate(action.body));
      return { githubUrl: r.html_url };
    }
    case 'pr.comment': {
      const r = await api.createIssueComment(action.repo, action.pull, decorate(action.body));
      return { githubUrl: r.html_url };
    }
    case 'issue.label.add':
      await api.addLabels(action.repo, action.issue, action.labels);
      return {};
    case 'issue.label.remove':
      await api.removeLabels(action.repo, action.issue, action.labels);
      return {};
    case 'pr.review': {
      const r = await api.createPullReview(
        action.repo,
        action.pull,
        action.event,
        decorate(action.body),
      );
      return { githubUrl: r.html_url };
    }
  }
}
