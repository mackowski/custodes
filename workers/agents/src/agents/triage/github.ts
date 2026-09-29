import { z } from 'zod';
import { BrokerReadResponse, type BrokerReadRequest, type ReadQuery } from '@custodes/schema';

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
    readonly status: number | undefined,
    readonly resource: string,
    readonly rateLimited: boolean,
    code: string,
  ) {
    super(
      `read ${resource} failed: ${code}${status ? ` (GitHub ${status})` : ''}${rateLimited ? ' (rate limited)' : ''}`,
    );
    this.name = 'GitHubReadError';
  }
}

/** The broker service binding (only `fetch` is used). */
export interface BrokerFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/**
 * Reads public repository data through the broker's GET-only `/v1/read` endpoint. The agent holds
 * no GitHub credential; the broker uses a read-only token and builds every URL itself.
 */
export class BrokerGitHubReader {
  constructor(
    private readonly broker: BrokerFetcher,
    private readonly agentId: string,
    private readonly runId: string,
  ) {}

  private async read<T extends z.ZodType>(
    repo: string,
    resource: BrokerReadRequest['resource'],
    query: ReadQuery,
    schema: T,
  ): Promise<z.infer<T>> {
    const req: BrokerReadRequest = {
      agentId: this.agentId,
      runId: this.runId,
      repo,
      resource,
      query,
    };
    const res = await this.broker.fetch('https://broker.internal/v1/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    const parsed = BrokerReadResponse.parse(await res.json());
    if (!parsed.ok)
      throw new GitHubReadError(parsed.status, resource, parsed.rateLimited ?? false, parsed.code);
    return schema.parse(parsed.data);
  }

  /** Open issues (not PRs) updated since `since`, oldest update first, so a capped run resumes cleanly. */
  async listUpdatedIssues(repo: string, since: string, limit: number): Promise<PublicIssue[]> {
    const q: ReadQuery = { state: 'open', sort: 'updated', direction: 'asc', since, per_page: 100 };
    const issues = await this.read(repo, 'issues', q, z.array(PublicIssue));
    return issues.filter((i) => i.pull_request === undefined).slice(0, limit);
  }

  /** Recently created open issues, as candidates for duplicate detection. */
  async listRecentIssueTitles(
    repo: string,
    count: number,
  ): Promise<{ number: number; title: string }[]> {
    const q: ReadQuery = { state: 'open', sort: 'created', direction: 'desc', per_page: count };
    const issues = await this.read(repo, 'issues', q, z.array(PublicIssue));
    return issues
      .filter((i) => i.pull_request === undefined)
      .map((i) => ({ number: i.number, title: i.title }));
  }

  async listLabels(repo: string): Promise<string[]> {
    const labels = await this.read(
      repo,
      'labels',
      { per_page: 100 },
      z.array(z.looseObject({ name: z.string() })),
    );
    return labels.map((l) => l.name);
  }

  /** File names of the cheat sheets, e.g. `Cross_Site_Scripting_Prevention_Cheat_Sheet.md`. */
  async listCheatSheets(repo: string): Promise<string[]> {
    const entries = await this.read(
      repo,
      'cheatsheets',
      {},
      z.array(z.looseObject({ name: z.string(), type: z.string() })),
    );
    return entries.filter((e) => e.type === 'file' && e.name.endsWith('.md')).map((e) => e.name);
  }
}

export function issueLabels(issue: PublicIssue): string[] {
  return issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
}
