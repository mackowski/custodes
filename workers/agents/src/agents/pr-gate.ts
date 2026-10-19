import { z } from 'zod';
import { AgentHaltedError, CustodesAgent } from '@custodes/core/agent';
import { JevClient, MODELS, type JevTransport } from '@custodes/llm';
import type { AgentManifest } from '@custodes/schema';
import type { AgentsEnv } from '../env.js';
import {
  INSTANCE_REPOS,
  instanceOf,
  OWASP_INSTANCE,
  UnknownInstanceError,
  unknownInstance,
} from '../instances.js';
import { closeComment } from './pr-gate/comment.js';
import { decide, type Decision } from './pr-gate/decide.js';
import { MINOR_QUESTIONS } from './pr-gate/minor.js';
import { ACK_LABEL, CLOSE_FAILED, nextStep, REOPENED, settled } from './pr-gate/rules.js';
import { renderSummary, type SummaryOutcome, type SummaryRow } from './pr-gate/summary.js';
import { describeError } from './triage/errors.js';
import {
  BrokerGitHubReader,
  GitHubReadError,
  type PublicIssue,
  type PublicPull,
} from './triage/github.js';

export const PR_GATE_MANIFEST: AgentManifest = {
  id: 'pr-gate',
  version: '0.1.0',
  description:
    'Checks open community PRs against CONTRIBUTING.md (approved and assigned issue, minor fix, AI disclosure) and closes those that break it with a signed comment. Daily e-mail summary.',
  mode: 'hotl',
  repos: [...INSTANCE_REPOS],
};

export const PR_GATE_INSTANCE = OWASP_INSTANCE;

/** Closes per UTC day and per poll (per instance); the broker also caps 5 per hour per repository. */
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

interface EventRow {
  id: number;
  pr: number;
  title: string;
  outcome: StoredOutcome;
  detail: string;
  decided_at: string;
  github_url: string | null;
  attestation_id: string | null;
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
        : { why: d.reason, rung: 'human', ...(d.issue !== undefined ? { issues: [d.issue] } : {}) };
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

  /** The repository is chosen by the instance name only (see instances.ts). */
  private get repo(): string {
    return instanceOf(this.name).repo;
  }

  private get sandbox(): boolean {
    return instanceOf(this.name).sandbox;
  }

  /** PR_GATE_ENFORCE="false" is a soft stop: decisions are still made, closes only reported. */
  private get enforcing(): boolean {
    return this.env.PR_GATE_ENFORCE === 'true';
  }

  private ensureSchema(): void {
    const hadEvents =
      this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM sqlite_master
        WHERE type = 'table' AND name = 'events'`[0]?.n === 1;
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
    // Append-only log the summary reads. `decisions` holds only the latest state per PR, so a close
    // followed by a reopen used to overwrite the close before any e-mail reported it (PR #2801).
    this.sql`CREATE TABLE IF NOT EXISTS events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      pr             INTEGER NOT NULL,
      title          TEXT NOT NULL,
      outcome        TEXT NOT NULL,
      detail         TEXT NOT NULL,
      decided_at     TEXT NOT NULL,
      github_url     TEXT,
      attestation_id TEXT,
      reported_at    TEXT
    )`;
    if (!hadEvents)
      this.sql`INSERT INTO events (pr, title, outcome, detail, decided_at, github_url,
          attestation_id, reported_at)
        SELECT pr, title, outcome, detail, decided_at, github_url, attestation_id, NULL
        FROM decisions WHERE reported_at IS NULL`;
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

  /**
   * Scheduled with the triage poll. `manual` (sandbox only, ADR 0012) skips the grace period so a
   * scenario PR is judged as soon as the operator asks.
   */
  async poll(opts: { manual?: boolean } = {}): Promise<{ ok: boolean; detail: string }> {
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
    // Open ACK_OBTAINED issues, read at most once per poll and only if a close needs the check.
    // The promise is cached, so a failed read is not repeated for every PR in this poll.
    let approved: Promise<{ issues: PublicIssue[]; truncated: boolean }> | undefined;
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
      const skipGrace = opts.manual === true && this.sandbox;
      if (step === 'leave' || (!skipGrace && !settled(pr, now))) continue;
      evaluated++;
      let decision: Decision;
      try {
        await this.guard();
        decision = await decide(
          this.repo,
          pr,
          {
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
            approvedIssuesOf: async (login) => {
              approved ??= reader.listOpenIssuesWithLabelChecked(this.repo, ACK_LABEL);
              const list = await approved;
              const me = login.toLowerCase();
              return {
                issues: list.issues
                  .filter((i) => (i.assignees ?? []).some((a) => a.login.toLowerCase() === me))
                  .map((i) => i.number),
                complete: !list.truncated,
              };
            },
            jev: async (state) => {
              await this.guard();
              return jev.decide({
                model: MODELS.decision,
                state,
                questions: MINOR_QUESTIONS,
                metadata: { agentId: this.manifest.id, runId },
              });
            },
          },
          { gateMaintainers: this.sandbox },
        );
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
    // One event per change: a PR re-decided to the same outcome every poll adds nothing new.
    const last = this.sql<{ outcome: string; detail: string }>`SELECT outcome, detail FROM events
      WHERE pr = ${pr.number} ORDER BY id DESC LIMIT 1`[0];
    const same = last?.outcome === outcome && last.detail === JSON.stringify(detail);
    if (!same || acted !== undefined)
      this
        .sql`INSERT INTO events (pr, title, outcome, detail, decided_at, github_url, attestation_id)
        VALUES (${pr.number}, ${title}, ${outcome}, ${JSON.stringify(detail)}, ${now.toISOString()},
          ${acted?.githubUrl ?? null}, ${acted?.attestationId ?? null})`;
  }

  /** Marks events up to lastId as reported and forgets reported ones older than 30 days. */
  private markReported(stamp: string, lastId: number): void {
    this
      .sql`UPDATE events SET reported_at = ${stamp} WHERE reported_at IS NULL AND id <= ${lastId}`;
    const cutoff = new Date(Date.parse(stamp) - 30 * 86_400_000).toISOString();
    this.sql`DELETE FROM events WHERE reported_at IS NOT NULL AND reported_at < ${cutoff}`;
  }

  /** Scheduled daily with the triage digest. Sends nothing when nothing happened. */
  /** The pending summary, rendered but not sent and not marked (used by sendSummary and /report). */
  private buildSummary(now: Date): {
    mail: ReturnType<typeof renderSummary>;
    rows: SummaryRow[];
    skipped: number;
    errors: string[];
    lastId: number;
  } {
    this.ensureSchema();
    const pending = this.sql<EventRow>`SELECT * FROM events WHERE reported_at IS NULL
      ORDER BY id`;
    const lastId = pending.at(-1)?.id ?? 0;
    const rows: SummaryRow[] = [];
    let skipped = 0;
    for (const r of pending) {
      const d = Detail.safeParse(JSON.parse(r.detail));
      // Skips are only counted, except Jev's minor-fix skips: a diff that talked its way past the
      // gate must be visible to the operator, with its score.
      const minor = r.outcome === 'skip' && d.success && d.data.why === 'minor_fix';
      if (r.outcome === 'skip' && !minor) {
        skipped++;
        continue;
      }
      if (!d.success) continue;
      rows.push({
        pr: r.pr,
        title: r.title,
        outcome: minor ? 'minor' : (r.outcome as Exclude<StoredOutcome, 'skip'>),
        why: d.data.why,
        rung: d.data.rung,
        ...(d.data.p !== undefined ? { p: d.data.p } : {}),
        ...(d.data.issues !== undefined ? { issues: d.data.issues } : {}),
        decidedAt: r.decided_at,
        ...(r.github_url ? { githubUrl: r.github_url } : {}),
        ...(r.attestation_id ? { attestationId: r.attestation_id } : {}),
      });
    }
    const errors = [...this.state.lastErrors];
    const mail = renderSummary({
      repo: this.repo,
      rows,
      skipped,
      enforcing: this.enforcing,
      verifyUrl: `https://${this.env.EMAIL_DOMAIN}/verify`,
      errors,
      now,
    });
    return { mail, rows, skipped, errors, lastId };
  }

  async sendSummary(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.guard();
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'halted' };
    }
    const now = new Date();
    const stamp = now.toISOString();
    const { mail, rows, skipped, errors, lastId } = this.buildSummary(now);
    if (rows.length === 0 && errors.length === 0) {
      this.markReported(stamp, lastId);
      return { ok: true, detail: `nothing to report (${skipped} skipped)` };
    }
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
    this.markReported(stamp, lastId);
    this.setState({ ...this.state, lastSummaryAt: stamp, lastErrors: [] });
    return { ok: true, detail: `sent ${rows.length} row(s), ${skipped} skipped` };
  }

  /** Status for operators, reachable only through the Access-protected gateway. */
  override async onRequest(request: Request): Promise<Response> {
    let sandbox: boolean;
    try {
      sandbox = this.sandbox;
    } catch (err) {
      if (err instanceof UnknownInstanceError) return unknownInstance();
      throw err;
    }
    const url = new URL(request.url);
    // On-demand runs (ADR 0012) exist only for sandbox instances; real ones follow the crons.
    if (request.method === 'POST' && /\/(run|summary)$/.test(url.pathname)) {
      if (!sandbox)
        return Response.json({ error: 'on-demand runs are sandbox only' }, { status: 403 });
      return Response.json(
        url.pathname.endsWith('/summary')
          ? await this.sendSummary()
          : await this.poll({ manual: true }),
      );
    }
    // The summary as it would be e-mailed now, without sending or marking anything.
    if (request.method === 'GET' && url.pathname.endsWith('/report')) {
      const { mail } = this.buildSummary(new Date());
      return Response.json(mail);
    }
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
