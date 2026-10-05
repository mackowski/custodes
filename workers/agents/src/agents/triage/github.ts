import { z } from 'zod';
import { BrokerReadResponse, type BrokerReadRequest, type ReadQuery } from '@custodes/schema';

/** Timeline events we use: label changes and cross-references from pull requests. */
export const TimelineEvent = z.looseObject({
  event: z.string(),
  created_at: z.string().optional(),
  label: z.looseObject({ name: z.string() }).optional(),
  source: z
    .looseObject({
      issue: z
        .looseObject({
          number: z.number().int().positive(),
          state: z.string().optional(),
          pull_request: z.looseObject({ merged_at: z.string().nullable().optional() }).optional(),
          repository: z.looseObject({ full_name: z.string() }).optional(),
        })
        .optional(),
    })
    .optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

export const IssueComment = z.looseObject({
  user: z.looseObject({ login: z.string() }).nullable(),
  body: z.string().nullable().optional(),
  created_at: z.string(),
});
export type IssueComment = z.infer<typeof IssueComment>;

const ContentFile = z.looseObject({
  type: z.literal('file'),
  encoding: z.literal('base64'),
  content: z.string(),
});

/** Only the fields triage uses. Everything here is untrusted third-party content. */
export const PublicIssue = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.url(),
  state: z.string().optional(),
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
    target: Pick<BrokerReadRequest, 'number' | 'file'> = {},
  ): Promise<z.infer<T>> {
    const req: BrokerReadRequest = {
      agentId: this.agentId,
      runId: this.runId,
      repo,
      resource,
      query,
      ...target,
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

  /** Open issues carrying `label`, oldest first. Pull requests are dropped. */
  async listOpenIssuesWithLabel(repo: string, label: string): Promise<PublicIssue[]> {
    const out: PublicIssue[] = [];
    for (let page = 1; page <= 3; page++) {
      const q: ReadQuery = {
        state: 'open',
        labels: label,
        sort: 'created',
        direction: 'asc',
        per_page: 100,
        page,
      };
      const batch = await this.read(repo, 'issues', q, z.array(PublicIssue));
      out.push(...batch.filter((i) => i.pull_request === undefined));
      if (batch.length < 100) break;
    }
    return out;
  }

  /**
   * Issues closed (or updated while closed) since `since`, newest first, up to 300; `truncated` if
   * there are more. Newest first, so a cut loses the oldest closes, not the ones that matter.
   */
  async listClosedIssueNumbersSince(
    repo: string,
    since: string,
  ): Promise<{ closed: Set<number>; truncated: boolean }> {
    const out = new Set<number>();
    for (let page = 1; page <= 3; page++) {
      const q: ReadQuery = {
        state: 'closed',
        sort: 'updated',
        direction: 'desc',
        since,
        per_page: 100,
        page,
      };
      const batch = await this.read(repo, 'issues', q, z.array(PublicIssue));
      for (const i of batch) if (i.pull_request === undefined) out.add(i.number);
      if (batch.length < 100) return { closed: out, truncated: false };
    }
    return { closed: out, truncated: true };
  }

  async getIssue(repo: string, number: number): Promise<PublicIssue> {
    return this.read(repo, 'issue', {}, PublicIssue, { number });
  }

  /** Up to the first 300 timeline events (label history is near the start). */
  async listTimeline(repo: string, number: number): Promise<TimelineEvent[]> {
    const out: TimelineEvent[] = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await this.read(
        repo,
        'timeline',
        { per_page: 100, page },
        z.array(TimelineEvent),
        { number },
      );
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  /** The first 100 comments. */
  async listComments(repo: string, number: number): Promise<IssueComment[]> {
    return this.read(repo, 'comments', { per_page: 100 }, z.array(IssueComment), { number });
  }

  /** Paths changed by a pull request (first 100). */
  async listPullFiles(repo: string, number: number): Promise<string[]> {
    const files = await this.read(
      repo,
      'pull_files',
      { per_page: 100 },
      z.array(z.looseObject({ filename: z.string() })),
      { number },
    );
    return files.map((f) => f.filename);
  }

  /** The Markdown source of one cheat sheet. */
  async getCheatSheet(repo: string, file: string): Promise<string> {
    const f = await this.read(repo, 'cheatsheet', {}, ContentFile, { file });
    const bin = atob(f.content.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }
}

export function issueLabels(issue: PublicIssue): string[] {
  return issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
}
