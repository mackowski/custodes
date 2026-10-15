import { z } from 'zod';
import { AgentHaltedError, CustodesAgent } from '@custodes/core/agent';
import { JevClient, MODELS, type JevTransport } from '@custodes/llm';
import type { AgentManifest } from '@custodes/schema';
import type { AgentsEnv } from '../env.js';
import { closeComment } from './pr-gate/comment.js';
import { decide, type Decision } from './pr-gate/decide.js';
import { MINOR_QUESTIONS } from './pr-gate/minor.js';
import { CLOSE_FAILED, nextStep, REOPENED, settled } from './pr-gate/rules.js';
import { renderSummary, type SummaryOutcome, type SummaryRow } from './pr-gate/summary.js';
import { describeError } from './triage/errors.js';
import { BrokerGitHubReader, GitHubReadError, type PublicPull } from './triage/github.js';

export const PR_GATE_MANIFEST: AgentManifest = {
  id: 'pr-gate',
  version: '0.1.0',
  description:
    'Checks open community PRs against CONTRIBUTING.md (approved and assigned issue, minor fix, AI disclosure) and closes those that break it with a signed comment. Daily e-mail summary.',
  mode: 'hotl',
  repos: ['OWASP/CheatSheetSeries'],
};

export const PR_GATE_INSTANCE = 'owasp-cheatsheetseries';

/** Closes per UTC day and per poll; the broker also caps the agent at 5 per hour. */
export const MAX_CLOSES_PER_DAY = 10;
export const MAX_CLOSES_PER_RUN = 5;
/** PRs evaluated per poll (each costs up to six reads and one Jev call). */
export const MAX_EVALUATIONS_PER_RUN = 30;

type StoredOutcome = 'skip' | SummaryOutcome;

interface PrGateState {
  lastPollAt: string | null;
  lastSummaryAt: string | null;
  day: string | null;
  closesToday: number;
  lastErrors: string[];
}

interface DecisionRow {
  pr: number;
  head_sha: string;
  pr_updated_at: string;
  title: string;
  outcome: StoredOutcome;
  detail: string;
  decided_at: string;
  github_url: string | null;
  attestation_id: string | null;
}

/** What is stored per decision: ids, rule names and scores only, never PR text. */
const Detail = z.object({
  why: z.string().max(60),
  rung: z.string().max(10),
  p: z.number().optional(),
  issues: z.array(z.number().int()).max(10).optional(),
});
type Detail = z.infer<typeof Detail>;

function whyOf(row: DecisionRow): string | undefined {
  try {
    const d = Detail.safeParse(JSON.parse(row.detail));
    return d.success ? d.data.why : undefined;
  } catch {
    return undefined;
  }
}

function jevProbability(d: Decision): number | undefined {
  for (const t of d.trace) {
    const p = t.rung === 'jev' ? t.detail?.['p'] : undefined;
    if (typeof p === 'number') return p;
  }
  return undefined;
}

function detailOf(d: Decision): Detail {
  const p = jevProbability(d);
  const base =
    d.outcome === 'close'
      ? { why: d.rule, rung: d.rung, issues: d.issues }
      : d.outcome === 'skip'
        ? { why: d.reason, rung: d.rung }
        : { why: d.reason, rung: 'human' };
  return p === undefined ? base : { ...base, p };
}

export class PrGateAgent extends CustodesAgent<AgentsEnv, PrGateState> {
  readonly manifest = PR_GATE_MANIFEST;
  override initialState: PrGateState = {
    lastPollAt: null,
    lastSummaryAt: null,
    day: null,
    closesToday: 0,
    lastErrors: [],
  };

  private get repo(): string {
    return this.manifest.repos[0] ?? 'OWASP/CheatSheetSeries';
  }

  /** Until the operator flips PR_GATE_ENFORCE to "true" in a reviewed PR, closes are only reported. */
  private get enforcing(): boolean {
    return this.env.PR_GATE_ENFORCE === 'true';
  }

  private ensureSchema(): void {
    this.sql`CREATE TABLE IF NOT EXISTS decisions (
      pr             INTEGER PRIMARY KEY,
      head_sha       TEXT NOT NULL,
      pr_updated_at  TEXT NOT NULL,
      title          TEXT NOT NULL,
      outcome        TEXT NOT NULL,
      detail         TEXT NOT NULL,
      decided_at     TEXT NOT NULL,
      github_url     TEXT,
      attestation_id TEXT,
      reported_at    TEXT
    )`;
  }

  private jev(): JevClient {
    // Direct only when explicitly chosen (ADR 0011 fallback): a stray key must not bypass the
    // gateway's logging and spend limits.
    const direct = this.env.JEV_TRANSPORT === 'direct' ? this.env.OPENROUTER_API_KEY : undefined;
    if (this.env.JEV_TRANSPORT === 'direct' && !direct)
      throw new Error('JEV_TRANSPORT is direct but OPENROUTER_API_KEY is not set');
    const transport: JevTransport = direct
      ? { kind: 'direct', apiKey: direct }
      : {
          kind: 'gateway',
          accountId: this.env.AI_GATEWAY_ACCOUNT_ID,
          gatewayId: this.env.AI_GATEWAY_ID,
          gatewayToken: this.env.AI_GATEWAY_TOKEN,
          ...(this.env.JEV_GATEWAY_PATH ? { path: this.env.JEV_GATEWAY_PATH } : {}),
        };
    return new JevClient({ transport });
  }

  /** Scheduled with the triage poll. */
  async poll(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.guard();
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'halted' };
    }
    this.ensureSchema();
    const runId = crypto.randomUUID();
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (this.state.day !== day) this.setState({ ...this.state, day, closesToday: 0 });
    const reader = new BrokerGitHubReader(this.env.BROKER, this.manifest.id, runId);
    let jev: JevClient;
    try {
      jev = this.jev();
    } catch (err) {
      const detail = `jev misconfigured: ${err instanceof Error ? err.message : 'error'}`;
      this.recordErrors([detail]);
      return { ok: false, detail };
    }
    const errors: string[] = [];
    let listed: Awaited<ReturnType<BrokerGitHubReader['listOpenPulls']>>;
    try {
      listed = await reader.listOpenPulls(this.repo);
    } catch (err) {
      const detail = `list pulls failed: ${describeError(err)}`;
      this.recordErrors([detail]);
      return { ok: false, detail };
    }
    if (listed.truncated)
      errors.push('more than 300 open pull requests; the newest were not checked');

    let evaluated = 0;
    let closedThisRun = 0;
    for (const pr of listed.pulls) {
      if (evaluated >= MAX_EVALUATIONS_PER_RUN) break;
      const row = this.sql<DecisionRow>`SELECT * FROM decisions WHERE pr = ${pr.number}`[0];
      const step = nextStep(
        pr,
        row && {
          outcome: row.outcome,
          why: whyOf(row),
          headSha: row.head_sha,
          prUpdatedAt: row.pr_updated_at,
        },
        this.enforcing,
      );
      if (step === 'reopened') {
        // A maintainer reopened a PR we closed: their call. Report once, never act on it again.
        this.store(pr, 'flag', { why: REOPENED, rung: 'human' }, now);
        continue;
      }
      if (step === 'leave' || !settled(pr, now)) continue;
      evaluated++;
      let decision: Decision;
      try {
        await this.guard();
        decision = await decide(this.repo, pr, {
          getIssue: async (n) => {
            try {
              return await reader.getIssue(this.repo, n);
            } catch (err) {
              // A number in the body that is no issue here (deleted, transferred, a typo).
              if (err instanceof GitHubReadError && err.status === 404) return null;
              throw err;
            }
          },
          listFiles: () => reader.listPullFileDetails(this.repo, pr.number),
          jev: async (state) => {
            await this.guard();
            return jev.decide({
              model: MODELS.decision,
              state,
              questions: MINOR_QUESTIONS,
              metadata: { agentId: this.manifest.id, runId },
            });
          },
        });
      } catch (err) {
        if (err instanceof AgentHaltedError) break;
        const what = describeError(err);
        this.store(pr, 'error', { why: what.slice(0, 60), rung: 'rule' }, now);
        errors.push(`#${pr.number}: ${what}`);
        continue;
      }
      const detail = detailOf(decision);
      if (decision.outcome !== 'close') {
        this.store(pr, decision.outcome, detail, now);
      } else if (
        !this.enforcing ||
        this.state.closesToday >= MAX_CLOSES_PER_DAY ||
        closedThisRun >= MAX_CLOSES_PER_RUN
      ) {
        this.store(pr, 'would_close', detail, now);
      } else {
        closedThisRun++;
        const outcome = await this.close(pr, decision, runId, now);
        if (outcome.ok) {
          this.setState({ ...this.state, closesToday: this.state.closesToday + 1 });
          this.store(pr, 'close', detail, now, outcome);
        } else if (outcome.code === 'github_error') {
          // GitHub may have taken the comment and refused the close. Retrying would post the
          // comment again every poll, so this is final until the author pushes new commits.
          this.store(pr, 'flag', { ...detail, why: CLOSE_FAILED, rung: 'human' }, now);
          errors.push(
            `#${pr.number}: close failed at GitHub; the comment may be posted, check by hand`,
          );
        } else {
          // Refused before execution (rate limit, approval, halted): nothing happened, retry later.
          this.store(pr, 'error', { ...detail, why: `close ${outcome.code}`.slice(0, 60) }, now);
          errors.push(`#${pr.number}: close refused (${outcome.code})`);
          if (outcome.code === 'halted') break;
        }
      }
      console.log(
        JSON.stringify({
          event: 'pr-gate.decision',
          runId,
          pr: pr.number,
          outcome: decision.outcome,
          why: detail.why,
          rung: detail.rung,
          ...(detail.p !== undefined ? { p: detail.p } : {}),
        }),
      );
    }
    this.setState({ ...this.state, lastPollAt: now.toISOString() });
    if (errors.length) this.recordErrors(errors);
    return {
      ok: true,
      detail: `${listed.pulls.length} open, ${evaluated} evaluated, ${closedThisRun} close attempt(s)`,
    };
  }

  private async close(
    pr: PublicPull,
    d: Extract<Decision, { outcome: 'close' }>,
    runId: string,
    now: Date,
  ): Promise<
    { ok: true; githubUrl?: string; attestationId: string } | { ok: false; code: string }
  > {
    const body = closeComment({
      rule: d.rule,
      issues: d.issues,
      ...(d.assignees !== undefined ? { assignees: d.assignees } : {}),
      now,
    });
    try {
      // act() checks the kill switch again; the broker checks policy, kill switch and rate limit.
      const res = await this.act(
        { type: 'pr.close', repo: this.repo, pull: pr.number, body },
        runId,
        { kind: 'schedule', ref: 'pr-gate.poll' },
      );
      if (!res.ok) return { ok: false, code: res.code };
      return {
        ok: true,
        attestationId: res.attestationId,
        ...(res.githubUrl !== undefined ? { githubUrl: res.githubUrl } : {}),
      };
    } catch (err) {
      return { ok: false, code: err instanceof AgentHaltedError ? 'halted' : describeError(err) };
    }
  }

  private store(
    pr: PublicPull,
    outcome: StoredOutcome,
    detail: Detail,
    now: Date,
    acted?: { githubUrl?: string; attestationId: string },
  ): void {
    // Titles are kept (made inert at render time) so the summary needs no extra read.
    const title = pr.title.slice(0, 300);
    this.sql`INSERT INTO decisions (pr, head_sha, pr_updated_at, title, outcome, detail, decided_at,
        github_url, attestation_id, reported_at)
      VALUES (${pr.number}, ${pr.head.sha}, ${pr.updated_at}, ${title}, ${outcome},
        ${JSON.stringify(detail)}, ${now.toISOString()}, ${acted?.githubUrl ?? null},
        ${acted?.attestationId ?? null}, NULL)
      ON CONFLICT(pr) DO UPDATE SET head_sha = excluded.head_sha,
        pr_updated_at = excluded.pr_updated_at, title = excluded.title, outcome = excluded.outcome,
        detail = excluded.detail, decided_at = excluded.decided_at,
        github_url = excluded.github_url, attestation_id = excluded.attestation_id,
        reported_at = NULL`;
  }

  /** Scheduled daily with the triage digest. Sends nothing when nothing happened. */
  async sendSummary(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.guard();
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'halted' };
    }
    this.ensureSchema();
    const pending = this.sql<DecisionRow>`SELECT * FROM decisions WHERE reported_at IS NULL
      ORDER BY pr`;
    const rows: SummaryRow[] = [];
    let skipped = 0;
    for (const r of pending) {
      if (r.outcome === 'skip') {
        skipped++;
        continue;
      }
      const d = Detail.safeParse(JSON.parse(r.detail));
      if (!d.success) continue;
      rows.push({
        pr: r.pr,
        title: r.title,
        outcome: r.outcome,
        why: d.data.why,
        rung: d.data.rung,
        ...(d.data.p !== undefined ? { p: d.data.p } : {}),
        decidedAt: r.decided_at,
        ...(r.github_url ? { githubUrl: r.github_url } : {}),
        ...(r.attestation_id ? { attestationId: r.attestation_id } : {}),
      });
    }
    const errors = [...this.state.lastErrors];
    const now = new Date();
    const stamp = now.toISOString();
    if (rows.length === 0 && errors.length === 0) {
      this.sql`UPDATE decisions SET reported_at = ${stamp} WHERE reported_at IS NULL`;
      return { ok: true, detail: `nothing to report (${skipped} skipped)` };
    }
    const mail = renderSummary({
      repo: this.repo,
      rows,
      skipped,
      enforcing: this.enforcing,
      verifyUrl: `https://${this.env.EMAIL_DOMAIN}/verify`,
      errors,
      now,
    });
    try {
      await this.guard();
      await this.env.EMAIL.send({
        from: { name: 'Custodes pr-gate', email: this.env.EMAIL_FROM },
        to: this.env.OPERATOR_EMAIL,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    } catch (err) {
      const detail = `summary not sent: ${describeError(err)}`.slice(0, 200);
      console.warn(JSON.stringify({ event: 'pr-gate.summary.failed', detail }));
      return { ok: false, detail };
    }
    this.sql`UPDATE decisions SET reported_at = ${stamp} WHERE reported_at IS NULL`;
    this.setState({ ...this.state, lastSummaryAt: stamp, lastErrors: [] });
    return { ok: true, detail: `sent ${rows.length} row(s), ${skipped} skipped` };
  }

  /** Status for operators, reachable only through the Access-protected gateway. */
  override async onRequest(): Promise<Response> {
    this.ensureSchema();
    return Response.json({
      manifest: this.manifest,
      enforcing: this.enforcing,
      state: this.state,
      killSwitch: await this.killSwitch.state(this.manifest.id),
      recent: this.sql<{ pr: number; outcome: string; detail: string; decided_at: string }>`
        SELECT pr, outcome, detail, decided_at FROM decisions ORDER BY decided_at DESC LIMIT 30`,
    });
  }

  private recordErrors(e: string[]): void {
    this.setState({ ...this.state, lastErrors: [...e, ...this.state.lastErrors].slice(0, 20) });
  }
}
