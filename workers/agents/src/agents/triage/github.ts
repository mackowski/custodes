import { z } from 'zod';
import { GitHubRepo } from '@custodes/schema';

const API = 'https://api.github.com';

/** Only the fields triage uses. Everything here is untrusted third-party content. */
export const PublicIssue = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.url(),
  user: z.looseObject({ login: z.string() }).nullable(),
  labels: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])),
  created_at: z.string(),
  updated_at: z.string(),
  comments: z.number().int(),
  pull_request: z.unknown().optional(),
});
export type PublicIssue = z.infer<typeof PublicIssue>;

export class GitHubReadError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly rateLimitRemaining: string | null,
  ) {
    super(`GitHub ${status} on ${path}${rateLimitRemaining === '0' ? ' (rate limited)' : ''}`);
    this.name = 'GitHubReadError';
  }
}

/**
 * Unauthenticated, GET-only access to public repository data. There is deliberately no token
 * and no write method: a read-only agent cannot change anything on GitHub even if it tried.
 */
export class PublicGitHubReader {
  constructor(
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly userAgent = 'custodes-triage',
  ) {}

  private async get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': this.userAgent,
      },
    });
    if (!res.ok)
      throw new GitHubReadError(res.status, path, res.headers.get('x-ratelimit-remaining'));
    return schema.parse(await res.json());
  }

  /** Open issues (not PRs) updated since `since`, oldest update first, so a capped run resumes cleanly. */
  async listUpdatedIssues(repo: string, since: string, limit: number): Promise<PublicIssue[]> {
    const r = GitHubRepo.parse(repo);
    const q = new URLSearchParams({
      state: 'open',
      sort: 'updated',
      direction: 'asc',
      since,
      per_page: '100',
    });
    const issues = await this.get(`/repos/${r}/issues?${q.toString()}`, z.array(PublicIssue));
    return issues.filter((i) => i.pull_request === undefined).slice(0, limit);
  }

  /** Recently created open issues, as candidates for duplicate detection. */
  async listRecentIssueTitles(
    repo: string,
    count: number,
  ): Promise<{ number: number; title: string }[]> {
    const r = GitHubRepo.parse(repo);
    const q = new URLSearchParams({
      state: 'open',
      sort: 'created',
      direction: 'desc',
      per_page: String(count),
    });
    const issues = await this.get(`/repos/${r}/issues?${q.toString()}`, z.array(PublicIssue));
    return issues
      .filter((i) => i.pull_request === undefined)
      .map((i) => ({ number: i.number, title: i.title }));
  }

  async listLabels(repo: string): Promise<string[]> {
    const r = GitHubRepo.parse(repo);
    const labels = await this.get(
      `/repos/${r}/labels?per_page=100`,
      z.array(z.looseObject({ name: z.string() })),
    );
    return labels.map((l) => l.name);
  }

  /** File names of the cheat sheets, e.g. `Cross_Site_Scripting_Prevention_Cheat_Sheet.md`. */
  async listCheatSheets(repo: string): Promise<string[]> {
    const r = GitHubRepo.parse(repo);
    const entries = await this.get(
      `/repos/${r}/contents/cheatsheets`,
      z.array(z.looseObject({ name: z.string(), type: z.string() })),
    );
    return entries.filter((e) => e.type === 'file' && e.name.endsWith('.md')).map((e) => e.name);
  }
}

export function issueLabels(issue: PublicIssue): string[] {
  return issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
}
