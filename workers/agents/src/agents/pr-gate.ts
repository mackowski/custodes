import { z } from 'zod';
import { errorType, invokeAgent, type Turn } from '@custodes/core';
import { AgentHaltedError, CustodesAgent } from '@custodes/core/agent';
import {
  ClefClient,
  JevClient,
  MODELS,
  type JevQuestion,
  type JevState,
  type JevTransport,
} from '@custodes/llm';
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
import { APPROVAL_QUESTIONS } from './pr-gate/approval.js';
import { MINOR_QUESTIONS } from './pr-gate/minor.js';
import { agree, shadowed, type Comparison } from './pr-gate/shadow.js';
import {
  ACK_LABEL,
  CLOSE_FAILED,
  nextSlot,
  nextStep,
  REOPENED,
  settled,
  wakeAt,
} from './pr-gate/rules.js';
import {
  renderSummary,
  type ShadowCounts,
  type SummaryOutcome,
  type SummaryRow,
} from './pr-gate/summary.js';
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
/** PRs evaluated per poll (each costs up to a dozen reads and two Jev calls). */
export const MAX_EVALUATIONS_PER_RUN = 30;
/** And per UTC day: wake-ups can run a poll every 5 minutes, so the per-poll cap alone is no bound. */
export const MAX_EVALUATIONS_PER_DAY = 300;
/** And per PR per UTC day, so a few PRs edited over and over cannot use up the daily budget. */
export const MAX_EVALUATIONS_PER_PR_PER_DAY = 4;
/** A poll flag older than this belongs to a poll that hung; the next poll may start. */
export const POLL_LOCK_MS = 15 * 60_000;
/** Time Clef may take in one poll, in total; it is not asked again once this is spent. */
export const CLEF_BUDGET_PER_POLL_MS = 60_000;
/** Jev vs Clef rows are kept this long (ADR 0015): enough to decide on an agreement mode. */
export const COMPARISON_RETENTION_DAYS = 180;

/** The operator's answer to one question about one PR (ADR 0015). */
export const VerdictRequest = z
  .object({
    pr: z.number().int().positive().max(1_000_000),
    question: z.enum(['minor', 'approval']),
    answer: z.enum(['yes', 'no']),
  })
  .strict();

export interface ComparisonRow {
  id: number;
  pr: number;
  head_sha: string;
  state_sha256: string;
  question: string;
  jev_model: string | null;
  jev_p: number | null;
  jev_choice: string | null;
  jev_ms: number;
  jev_tokens: number | null;
  jev_error: string | null;
  clef_model: string | null;
  clef_p: number | null;
  clef_choice: string | null;
  clef_ms: number;
  clef_tokens: number | null;
  clef_error: string | null;
  outcome: string | null;
  human_verdict: string | null;
  decided_at: string;
}

type StoredOutcome = 'skip' | SummaryOutcome;

interface PrGateState {
  lastPollAt: string | null;
  lastSummaryAt: string | null;
  day: string | null;
  closesToday: number;
  /** Optional: state saved before the daily evaluation budget existed has no such field. */
  evaluationsToday?: number;
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

/** The last Jev score: the one that decided (approval comes after the minor-fix question). */
function jevProbability(d: Decision): number | undefined {
  for (const t of [...d.trace].reverse()) {
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
    evaluationsToday: 0,
    lastErrors: [],
  };

  /** When the running poll started. In memory on purpose: a poll does not survive eviction. */
  private pollingSince: number | null = null;

  /** Jev vs Clef answers for the PR being decided; written by store() with its outcome. */
  private pendingComparisons: Comparison[] = [];

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
    this.sql`CREATE TABLE IF NOT EXISTS evaluations (
      pr  INTEGER PRIMARY KEY,
      day TEXT NOT NULL,
      n   INTEGER NOT NULL
    )`;
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
    // Jev vs Clef (ADR 0015): numbers and ids only. `outcome` is what pr-gate did (Jev decides).
    this.sql`CREATE TABLE IF NOT EXISTS model_comparisons (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pr            INTEGER NOT NULL,
      head_sha      TEXT NOT NULL,
      state_sha256  TEXT NOT NULL,
      question      TEXT NOT NULL,
      jev_model     TEXT,
      jev_p         REAL,
      jev_choice    TEXT,
      jev_ms        INTEGER NOT NULL,
      jev_tokens    INTEGER,
      jev_error     TEXT,
      clef_model    TEXT,
      clef_p        REAL,
      clef_choice   TEXT,
      clef_ms       INTEGER NOT NULL,
      clef_tokens   INTEGER,
      clef_error    TEXT,
      outcome       TEXT,
      human_verdict TEXT,
      decided_at    TEXT NOT NULL
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

  /** The shadow model, always through the AI Gateway (ADR 0015). Absent if it cannot be built. */
  private clef(): ClefClient | undefined {
    try {
      return new ClefClient({
        ai: { run: (model, inputs, options) => this.env.AI.run(model, inputs, options) },
        gatewayId: this.env.AI_GATEWAY_ID,
      });
    } catch (err) {
      console.warn(
        JSON.stringify({ event: 'pr-gate.clef.unavailable', error: describeError(err) }),
      );
      return undefined;
    }
  }

  /**
   * Scheduled with the triage poll, and woken by `wake` after webhooks and after polls that skipped
   * a PR still in its grace period. `manual` (sandbox only, ADR 0012) skips the grace period so a
   * scenario PR is judged as soon as the operator asks.
   */
  async poll(opts: { manual?: boolean } = {}): Promise<{ ok: boolean; detail: string }> {
    // A Durable Object interleaves calls at every await: two polls would decide the same PR, post
    // two close comments and both pass the close caps. One at a time; the other comes back later.
    const started = Date.now();
    if (this.pollingSince !== null && started - this.pollingSince < POLL_LOCK_MS) {
      try {
        await this.guard();
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : 'halted' };
      }
      const at = await this.scheduleWake(nextSlot(new Date(started)));
      return { ok: false, detail: `poll in progress; again at ${at.at}` };
    }
    this.pollingSince = started;
    try {
      return await this.pollOnce(opts);
    } finally {
      // A newer poll may have taken over a stale flag; only the owner clears it.
      if (this.pollingSince === started) this.pollingSince = null;
    }
  }

  private async pollOnce(opts: { manual?: boolean }): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.guard();
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'halted' };
    }
    this.ensureSchema();
    const runId = crypto.randomUUID();
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (this.state.day !== day) {
      this.setState({ ...this.state, day, closesToday: 0, evaluationsToday: 0 });
      this.sql`DELETE FROM evaluations WHERE day <> ${day}`;
    }
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
    const clef = this.clef();
    // A hanging Clef must not stretch the poll towards POLL_LOCK_MS: it gets a time budget per poll
    // and is dropped for the rest of the poll after its first error.
    let clefBudgetMs = CLEF_BUDGET_PER_POLL_MS;
    // The same questions to Clef, never deciding (ADR 0015); answers wait in pendingComparisons.
    const shadow = <Q extends Record<string, JevQuestion>>(
      questions: Q,
      state: JevState,
      turn: Turn,
    ) =>
      clef && clefBudgetMs > 0
        ? () =>
            clef.decide(
              {
                model: MODELS.decisionShadow,
                state,
                questions,
                metadata: { agentId: this.manifest.id, runId },
              },
              turn,
            )
        : undefined;
    const record = (c: Comparison) => {
      // Any error (timeout, 429 from the gateway): no more Clef this poll, so the shadow cannot
      // use up the gateway's rate limit that triage's Claude calls share.
      clefBudgetMs = c.clef.error !== undefined ? 0 : clefBudgetMs - c.clef.ms;
      this.pendingComparisons.push(c);
    };
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

    const skipGrace = opts.manual === true && this.sandbox;
    let nextWake: Date | undefined;
    let overBudget = false;
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
        // A "would close" is only worth deciding again while a close is still possible today.
        this.enforcing && this.state.closesToday < MAX_CLOSES_PER_DAY,
      );
      this.pendingComparisons = [];
      if (step === 'reopened') {
        // A maintainer reopened a PR we closed: their call. Report once, never act on it again.
        this.store(pr, 'flag', { why: REOPENED, rung: 'human' }, now);
        this.sql`UPDATE model_comparisons SET human_verdict = 'reopened'
          WHERE pr = ${pr.number} AND human_verdict IS NULL`;
        continue;
      }
      if (step === 'leave') continue;
      if (!skipGrace && !settled(pr, now)) {
        // Edited during its grace period: come back when it is over, not at the next cron. An
        // unparsable time never settles, so it must not keep scheduling wake-ups either.
        if (Number.isFinite(Date.parse(pr.updated_at))) {
          const at = wakeAt(pr.updated_at, now);
          if (!nextWake || at < nextWake) nextWake = at;
        }
        continue;
      }
      // Budgets come last, so reopened PRs are still reported once they are spent.
      if ((this.state.evaluationsToday ?? 0) >= MAX_EVALUATIONS_PER_DAY) {
        overBudget = true;
        continue;
      }
      const evaluationsOfPr = this.countEvaluation(pr.number, day, skipGrace);
      if (evaluationsOfPr === null) continue;
      if (evaluationsOfPr === MAX_EVALUATIONS_PER_PR_PER_DAY)
        errors.push(
          `#${pr.number}: evaluated ${MAX_EVALUATIONS_PER_PR_PER_DAY} times today; next try tomorrow`,
        );
      evaluated++;
      this.setState({ ...this.state, evaluationsToday: (this.state.evaluationsToday ?? 0) + 1 });
      const turn = this.turn(this.repo, pr.number, runId);
      const turnReader = reader.inTurn(turn);
      const flow = await invokeAgent(turn, async (span): Promise<'next' | 'stop'> => {
        let decision: Decision;
        try {
          await this.guard();
          decision = await decide(
            this.repo,
            pr,
            {
              getIssue: async (n) => {
                try {
                  return await turnReader.getIssue(this.repo, n);
                } catch (err) {
                  // A number in the body that is no issue here (deleted, transferred, a typo).
                  if (err instanceof GitHubReadError && err.status === 404) return null;
                  throw err;
                }
              },
              listFiles: () => turnReader.listPullFileDetails(this.repo, pr.number),
              listComments: async (n) => {
                try {
                  return await turnReader.listComments(this.repo, n);
                } catch (err) {
                  if (err instanceof GitHubReadError && err.status === 404) return null;
                  throw err;
                }
              },
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
                return shadowed(
                  'minor',
                  state,
                  () =>
                    jev.decide(
                      {
                        model: MODELS.decision,
                        state,
                        questions: MINOR_QUESTIONS,
                        metadata: { agentId: this.manifest.id, runId },
                      },
                      turn,
                    ),
                  shadow(MINOR_QUESTIONS, state, turn),
                  record,
                );
              },
              jevApproval: async (state) => {
                await this.guard();
                return shadowed(
                  'approval',
                  state,
                  () =>
                    jev.decide(
                      {
                        model: MODELS.decision,
                        state,
                        questions: APPROVAL_QUESTIONS,
                        metadata: { agentId: this.manifest.id, runId },
                      },
                      turn,
                    ),
                  shadow(APPROVAL_QUESTIONS, state, turn),
                  record,
                );
              },
            },
            { gateMaintainers: this.sandbox },
          );
        } catch (err) {
          if (err instanceof AgentHaltedError) return 'stop';
          const what = describeError(err);
          span.set('error.type', errorType(err));
          span.set('custodes.outcome', 'error');
          this.store(pr, 'error', { why: what.slice(0, 60), rung: 'rule' }, now);
          errors.push(`#${pr.number}: ${what}`);
          return 'next';
        }
        const detail = detailOf(decision);
        span.set('custodes.outcome', decision.outcome);
        span.set('custodes.rung', detail.rung);
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
          const outcome = await this.close(pr, decision, runId, now, turn);
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
            if (outcome.code === 'halted') return 'stop';
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
        return 'next';
      });
      if (flow === 'stop') break;
    }
    if (overBudget) errors.push(`daily budget of ${MAX_EVALUATIONS_PER_DAY} evaluations reached`);
    this.setState({ ...this.state, lastPollAt: now.toISOString() });
    if (nextWake) await this.scheduleWake(nextWake);
    if (errors.length) this.recordErrors(errors);
    return {
      ok: true,
      detail: `${listed.pulls.length} open, ${evaluated} evaluated, ${closedThisRun} close attempt(s)`,
    };
  }

  /**
   * A pull request was opened or reopened (webhook, ADR 0006). Only schedules a poll for when its
   * grace period is over; the poll reads every PR through the broker and trusts nothing from the
   * event. `updatedAt` is the event's hint and is clamped by wakeAt.
   */
  async notify(updatedAt: string): Promise<{ id: string; at: string }> {
    return this.scheduleWake(wakeAt(updatedAt, new Date()));
  }

  /** Alarm callback for notify and for PRs a poll skipped during their grace period. */
  async wake(): Promise<void> {
    const r = await this.poll();
    console.log(
      JSON.stringify({ event: 'pr-gate.wake', instance: this.name, ok: r.ok, detail: r.detail }),
    );
  }

  /**
   * Counts one evaluation of `pr` today and returns the new count, or null when the PR has had its
   * share today. Operator runs in the sandbox (`manual`) are counted but never refused.
   */
  private countEvaluation(pr: number, day: string, manual: boolean): number | null {
    const n =
      this.sql<{ n: number }>`SELECT n FROM evaluations WHERE pr = ${pr} AND day = ${day}`[0]?.n ??
      0;
    if (!manual && n >= MAX_EVALUATIONS_PER_PR_PER_DAY) return null;
    this.sql`INSERT INTO evaluations (pr, day, n) VALUES (${pr}, ${day}, 1)
      ON CONFLICT(pr) DO UPDATE SET n = CASE WHEN day = excluded.day THEN n + 1 ELSE 1 END,
        day = excluded.day`;
    return n + 1;
  }

  /** One wake-up per slot: the slot is the payload, which is what idempotent schedules match on. */
  private async scheduleWake(at: Date): Promise<{ id: string; at: string }> {
    const slot = at.toISOString();
    const s = await this.schedule(at, 'wake', { slot }, { idempotent: true });
    return { id: s.id, at: slot };
  }

  private async close(
    pr: PublicPull,
    d: Extract<Decision, { outcome: 'close' }>,
    runId: string,
    now: Date,
    turn: Turn,
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
        { turn },
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
    // Shadow bookkeeping runs after act(): it must never interrupt the poll.
    try {
      this.storeComparisons(pr, outcome, now);
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: 'pr-gate.shadow.store_failed',
          pr: pr.number,
          error: describeError(err),
        }),
      );
    }
    this.pendingComparisons = [];
  }

  private storeComparisons(pr: PublicPull, outcome: StoredOutcome, now: Date): void {
    for (const c of this.pendingComparisons) {
      this.sql`INSERT INTO model_comparisons (pr, head_sha, state_sha256, question,
          jev_model, jev_p, jev_choice, jev_ms, jev_tokens, jev_error,
          clef_model, clef_p, clef_choice, clef_ms, clef_tokens, clef_error, outcome, decided_at)
        VALUES (${pr.number}, ${pr.head.sha}, ${c.stateSha256}, ${c.question},
          ${c.jev.model ?? null}, ${c.jev.p ?? null}, ${c.jev.choice ?? null}, ${c.jev.ms},
          ${c.jev.tokens ?? null}, ${c.jev.error ?? null},
          ${c.clef.model ?? null}, ${c.clef.p ?? null}, ${c.clef.choice ?? null}, ${c.clef.ms},
          ${c.clef.tokens ?? null}, ${c.clef.error ?? null}, ${outcome}, ${now.toISOString()})`;
      console.log(
        JSON.stringify({
          event: 'pr-gate.shadow',
          pr: pr.number,
          question: c.question,
          jevP: c.jev.p ?? null,
          clefP: c.clef.p ?? null,
          clefError: c.clef.error ?? null,
        }),
      );
    }
  }

  /** Marks events up to lastId as reported and forgets reported ones older than 30 days. */
  private markReported(stamp: string, lastId: number): void {
    this
      .sql`UPDATE events SET reported_at = ${stamp} WHERE reported_at IS NULL AND id <= ${lastId}`;
    const cutoff = new Date(Date.parse(stamp) - 30 * 86_400_000).toISOString();
    this.sql`DELETE FROM events WHERE reported_at IS NOT NULL AND reported_at < ${cutoff}`;
    const keep = new Date(Date.parse(stamp) - COMPARISON_RETENTION_DAYS * 86_400_000).toISOString();
    this.sql`DELETE FROM model_comparisons WHERE decided_at < ${keep}`;
  }

  /**
   * Fills human_verdict from what happened to the PRs since (ADR 0015): merged, or closed unmerged
   * by someone (maybe the author). Our own closes stay open: only a reopen or the operator says
   * whether they were right.
   */
  private async settleVerdicts(): Promise<void> {
    this.ensureSchema();
    const pending = this.sql<{ pr: number }>`SELECT DISTINCT pr FROM model_comparisons
      WHERE human_verdict IS NULL`;
    if (pending.length === 0) return;
    const wanted = new Set(pending.map((r) => r.pr));
    const reader = new BrokerGitHubReader(this.env.BROKER, this.manifest.id, crypto.randomUUID());
    for (const pr of await reader.listRecentlyClosedPulls(this.repo)) {
      if (!wanted.has(pr.number)) continue;
      const ours =
        this.sql<{ outcome: string }>`SELECT outcome FROM decisions WHERE pr = ${pr.number}`[0]
          ?.outcome === 'close';
      // GitHub's list does not say who closed: the author may have. A weak signal, named so.
      const verdict = pr.merged_at ? 'merged' : ours ? null : 'closed_unmerged';
      if (verdict)
        this.sql`UPDATE model_comparisons SET human_verdict = ${verdict}
          WHERE pr = ${pr.number} AND human_verdict IS NULL`;
    }
  }

  /** Jev vs Clef since `since` (all rows when null), for the summary line. */
  private shadowCounts(since: string | null): ShadowCounts | undefined {
    const rows = this.sql<ComparisonRow>`SELECT * FROM model_comparisons
      WHERE decided_at > ${since ?? ''} ORDER BY id`;
    if (rows.length === 0) return undefined;
    const disagree = new Set<number>();
    let agreeing = 0;
    let clefErrors = 0;
    for (const r of rows) {
      if (r.clef_error !== null) clefErrors++;
      const a = agree(r);
      if (a === true) agreeing++;
      if (a === false) disagree.add(r.pr);
    }
    return { agree: agreeing, disagree: [...disagree], clefErrors };
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
      // Skips are only counted, except Jev's: a diff or a maintainer comment that got a PR past
      // the gate must be visible to the operator, with its score.
      const minor =
        r.outcome === 'skip' &&
        d.success &&
        (d.data.why === 'minor_fix' || d.data.why === 'maintainer_approved');
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
    const shadow = this.shadowCounts(this.state.lastSummaryAt);
    const mail = renderSummary({
      repo: this.repo,
      rows,
      skipped,
      enforcing: this.enforcing,
      verifyUrl: `https://${this.env.EMAIL_DOMAIN}/verify`,
      errors,
      now,
      ...(shadow ? { shadow } : {}),
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
    try {
      await this.settleVerdicts();
    } catch (err) {
      // Only the comparison data waits a day; the summary itself goes out.
      console.warn(JSON.stringify({ event: 'pr-gate.verdicts.failed', error: describeError(err) }));
    }
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
    // Jev vs Clef rows (ADR 0015): ids and numbers only, newest first, optionally since a time.
    if (request.method === 'GET' && url.pathname.endsWith('/comparisons')) {
      const since = url.searchParams.get('since');
      if (since !== null && !Number.isFinite(Date.parse(since)))
        return Response.json({ error: 'since must be an ISO time' }, { status: 400 });
      this.ensureSchema();
      const from = since === null ? '' : new Date(since).toISOString();
      return Response.json(
        this.sql<ComparisonRow>`SELECT * FROM model_comparisons WHERE decided_at >= ${from}
          ORDER BY id DESC LIMIT 5000`,
      );
    }
    // The operator's answer to one question about one PR: the ground truth for the comparison.
    if (request.method === 'POST' && url.pathname.endsWith('/verdict')) {
      // The gateway refuses service tokens too; this holds if that route ever changes.
      if (request.headers.get('x-custodes-actor-via') !== 'access-user')
        return Response.json({ error: 'verdicts are recorded by people only' }, { status: 403 });
      const body = VerdictRequest.safeParse(await request.json().catch(() => null));
      if (!body.success) return Response.json({ error: 'bad verdict' }, { status: 400 });
      this.ensureSchema();
      const { pr, question, answer } = body.data;
      this.sql`UPDATE model_comparisons SET human_verdict = ${answer}
        WHERE pr = ${pr} AND question = ${question}`;
      const n =
        this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM model_comparisons
        WHERE pr = ${pr} AND question = ${question}`[0]?.n ?? 0;
      const by = request.headers.get('x-custodes-actor')?.slice(0, 200) ?? null;
      console.log(JSON.stringify({ event: 'pr-gate.verdict', pr, question, answer, rows: n, by }));
      return Response.json({ pr, question, answer, rows: n });
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
