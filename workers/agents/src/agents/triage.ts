import { CustodesAgent } from '@custodes/core/agent';
import { AnthropicGateway, inertText, MODELS } from '@custodes/llm';
import type { AgentManifest } from '@custodes/schema';
import type { AgentsEnv } from '../env.js';
import { Assessment } from './triage/assess.js';
import { renderDigest, type DigestItem } from './triage/digest.js';
import { PublicGitHubReader, type PublicIssue } from './triage/github.js';
import { runTriage, type TriageStore } from './triage/run.js';

export const TRIAGE_MANIFEST: AgentManifest = {
  id: 'triage',
  version: '0.1.0',
  description:
    'Read-only triage report for OWASP Cheat Sheet Series issues: suggests labels, the affected cheat sheet and duplicates, e-mailed daily. Never writes to GitHub.',
  mode: 'readonly',
  repos: ['OWASP/CheatSheetSeries'],
};

/** One instance per repository. */
export const TRIAGE_INSTANCE = 'owasp-cheatsheetseries';

interface TriageState {
  since: string | null;
  lastPollAt: string | null;
  lastDigestAt: string | null;
  lastErrors: string[];
  assessedTotal: number;
}

interface AssessmentRow {
  issue: number;
  title: string;
  url: string;
  issue_updated_at: string;
  assessment: string;
  assessed_at: string;
}

const FIRST_RUN_LOOKBACK_MS = 7 * 86_400_000;

export class TriageAgent extends CustodesAgent<AgentsEnv, TriageState> {
  readonly manifest = TRIAGE_MANIFEST;
  override initialState: TriageState = {
    since: null,
    lastPollAt: null,
    lastDigestAt: null,
    lastErrors: [],
    assessedTotal: 0,
  };

  private get repo(): string {
    return this.manifest.repos[0] ?? 'OWASP/CheatSheetSeries';
  }

  private ensureSchema(): void {
    this.sql`CREATE TABLE IF NOT EXISTS assessments (
      issue            INTEGER PRIMARY KEY,
      title            TEXT NOT NULL,
      url              TEXT NOT NULL,
      issue_updated_at TEXT NOT NULL,
      assessment       TEXT NOT NULL,
      assessed_at      TEXT NOT NULL,
      digested_at      TEXT
    )`;
  }

  private store(): TriageStore {
    return {
      isCurrent: (issue, updatedAt) =>
        this.sql<{
          n: number;
        }>`SELECT COUNT(*) AS n FROM assessments WHERE issue = ${issue} AND issue_updated_at = ${updatedAt}`[0]
          ?.n === 1,
      save: (issue: PublicIssue, assessment, now) => {
        this
          .sql`INSERT INTO assessments (issue, title, url, issue_updated_at, assessment, assessed_at, digested_at)
          VALUES (${issue.number}, ${issue.title}, ${issue.html_url}, ${issue.updated_at}, ${JSON.stringify(assessment)}, ${now.toISOString()}, NULL)
          ON CONFLICT(issue) DO UPDATE SET title = excluded.title, url = excluded.url,
            issue_updated_at = excluded.issue_updated_at, assessment = excluded.assessment,
            assessed_at = excluded.assessed_at, digested_at = NULL`;
      },
    };
  }

  /** Scheduled every few hours by the Worker cron trigger. */
  async poll(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.guard();
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'halted' };
    }
    this.ensureSchema();
    const runId = crypto.randomUUID();
    const now = new Date();
    const since = this.state.since ?? new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS).toISOString();
    const gateway = new AnthropicGateway({
      accountId: this.env.AI_GATEWAY_ACCOUNT_ID,
      gatewayId: this.env.AI_GATEWAY_ID,
      gatewayToken: this.env.AI_GATEWAY_TOKEN,
    });
    try {
      const result = await runTriage(this.repo, since, {
        reader: new PublicGitHubReader(),
        store: this.store(),
        now: () => new Date(),
        complete: async (system, user, issue) => {
          await this.guard(); // re-check between model calls so a halt takes effect mid-run
          const res = await gateway.messages({
            model: MODELS.fast,
            system,
            messages: [{ role: 'user', content: user }],
            max_tokens: 700,
            temperature: 0,
            metadata: { agentId: this.manifest.id, runId, issue: String(issue) },
          });
          return AnthropicGateway.text(res);
        },
      });
      this.setState({
        ...this.state,
        since: result.nextSince,
        lastPollAt: now.toISOString(),
        lastErrors: [...result.errors, ...this.state.lastErrors].slice(0, 20),
        assessedTotal: this.state.assessedTotal + result.assessed,
      });
      console.log(
        JSON.stringify({
          event: 'triage.poll',
          runId,
          assessed: result.assessed,
          skipped: result.skipped,
          errors: result.errors.length,
        }),
      );
      return {
        ok: true,
        detail: `assessed ${result.assessed}, skipped ${result.skipped}, errors ${result.errors.length}`,
      };
    } catch (err) {
      const detail =
        err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : 'poll failed';
      this.setState({
        ...this.state,
        lastPollAt: now.toISOString(),
        lastErrors: [detail, ...this.state.lastErrors].slice(0, 20),
      });
      console.warn(JSON.stringify({ event: 'triage.poll.failed', runId, detail }));
      return { ok: false, detail };
    }
  }

  /** Scheduled daily. Sends nothing when there is nothing to report. */
  async sendDigest(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.guard();
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'halted' };
    }
    this.ensureSchema();
    const rows = this
      .sql<AssessmentRow>`SELECT issue, title, url, issue_updated_at, assessment, assessed_at
      FROM assessments WHERE digested_at IS NULL ORDER BY issue`;
    const items: DigestItem[] = [];
    for (const r of rows) {
      const parsed = Assessment.safeParse(JSON.parse(r.assessment));
      if (parsed.success)
        items.push({
          issue: r.issue,
          title: inertText(r.title, 200),
          url: r.url,
          assessment: parsed.data,
        });
    }
    const errors = this.state.lastErrors;
    if (items.length === 0 && errors.length === 0) return { ok: true, detail: 'nothing to report' };

    const now = new Date();
    const digest = renderDigest({
      repo: this.repo,
      items,
      errors,
      since: this.state.lastDigestAt,
      now,
    });
    try {
      await this.env.EMAIL.send({
        from: { name: 'Custodes triage', email: this.env.EMAIL_FROM },
        to: this.env.OPERATOR_EMAIL,
        subject: digest.subject,
        text: digest.text,
      });
    } catch (err) {
      const detail = `digest not sent: ${err instanceof Error ? err.message : 'send failed'}`.slice(
        0,
        200,
      );
      console.warn(JSON.stringify({ event: 'triage.digest.failed', detail }));
      return { ok: false, detail };
    }
    const stamp = now.toISOString();
    for (const item of items)
      this.sql`UPDATE assessments SET digested_at = ${stamp} WHERE issue = ${item.issue}`;
    this.setState({ ...this.state, lastDigestAt: stamp, lastErrors: [] });
    console.log(JSON.stringify({ event: 'triage.digest.sent', items: items.length }));
    return { ok: true, detail: `sent ${items.length} item(s)` };
  }

  /** Status for operators, reachable only through the Access-protected gateway. */
  override async onRequest(): Promise<Response> {
    this.ensureSchema();
    const recent = this
      .sql<AssessmentRow>`SELECT issue, title, issue_updated_at, assessment, assessed_at
      FROM assessments ORDER BY assessed_at DESC LIMIT 20`;
    return Response.json({
      manifest: this.manifest,
      state: this.state,
      killSwitch: await this.killSwitch.state(this.manifest.id),
      recent: recent.map((r) => ({
        issue: r.issue,
        title: inertText(r.title, 200),
        assessedAt: r.assessed_at,
        assessment: JSON.parse(r.assessment) as unknown,
      })),
    });
  }
}
