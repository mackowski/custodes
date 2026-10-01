import { z } from 'zod';
import { AgentHaltedError, CustodesAgent } from '@custodes/core/agent';
import { AnthropicGateway } from '@custodes/llm';
import type { AgentsEnv } from '../../env.js';
import { describeError } from '../triage/errors.js';
import { BrokerGitHubReader } from '../triage/github.js';
import { assessRequest, selectRequest } from './model.js';
import type { SpecialistDeps } from './run.js';

/** What triage hands a specialist: an issue number and the version it saw. No issue text. */
export const SpecialistJob = z
  .object({
    issue: z.number().int().positive().max(1_000_000),
    issueUpdatedAt: z.iso.datetime(),
  })
  .strict();
export type SpecialistJob = z.infer<typeof SpecialistJob>;

export const StoredResult = z.object({
  issue: z.number().int().positive().max(1_000_000),
  issueUpdatedAt: z.string().max(40),
  checkedAt: z.string().max(40),
  /** JSON, validated by the specialist before storage and again by triage on receipt. */
  result: z.string().max(100_000),
});
export type StoredResult = z.infer<typeof StoredResult>;

/** Triage parses what a specialist returns with this; RPC peers are still separate components. */
export const PendingResults = z.object({
  results: z.array(StoredResult).max(1000),
  errors: z.array(z.string().max(300)).max(20),
});
export type PendingResults = z.infer<typeof PendingResults>;

export interface SpecialistState {
  day: string | null;
  jobsToday: number;
  lastRunAt: string | null;
  lastErrors: string[];
}

/** Jobs (each one fast and one reasoning call) per UTC day: bounds model spend. */
export const MAX_JOBS_PER_DAY = 10;
/** A job that fails this many times is dropped (triage re-enqueues it when the issue changes). */
export const MAX_ATTEMPTS = 4;
const MAX_ENQUEUE = 100;

interface JobRow {
  issue: number;
  issue_updated_at: string;
  attempts: number;
}

interface ResultRow {
  issue: number;
  issue_updated_at: string;
  result: string;
  checked_at: string;
}

function isInputSpecific(err: unknown): boolean {
  return err instanceof Error && ['StructuredOutputError', 'ModelOutputError'].includes(err.name);
}

/**
 * A read-only agent that triage delegates single issues to. Jobs are queued in SQLite and worked
 * one per alarm, so a slow reasoning call never blocks triage and a crash loses nothing. Results
 * are kept until triage has put them in a digest.
 */
export abstract class SpecialistAgent extends CustodesAgent<AgentsEnv, SpecialistState> {
  override initialState: SpecialistState = {
    day: null,
    jobsToday: 0,
    lastRunAt: null,
    lastErrors: [],
  };

  /** Runs one job. Returns a validated result, or null when the issue no longer needs one. */
  protected abstract run(repo: string, issue: number, deps: SpecialistDeps): Promise<unknown>;

  /** True when a stored result still answers this job, so no model call is needed. */
  protected abstract isFresh(
    stored: { issueUpdatedAt: string; checkedAt: string },
    job: SpecialistJob,
    now: Date,
  ): boolean;

  private get repo(): string {
    return this.manifest.repos[0] ?? 'OWASP/CheatSheetSeries';
  }

  private ensureSchema(): void {
    this.sql`CREATE TABLE IF NOT EXISTS jobs (
      issue            INTEGER PRIMARY KEY,
      issue_updated_at TEXT NOT NULL,
      enqueued_at      TEXT NOT NULL,
      attempts         INTEGER NOT NULL DEFAULT 0
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS results (
      issue            INTEGER PRIMARY KEY,
      issue_updated_at TEXT NOT NULL,
      result           TEXT NOT NULL,
      checked_at       TEXT NOT NULL,
      reported_at      TEXT
    )`;
  }

  /** Called by triage over RPC. Input is re-validated: an RPC caller is still another component. */
  async enqueue(jobs: unknown): Promise<{ queued: number }> {
    const parsed = z.array(SpecialistJob).max(MAX_ENQUEUE).safeParse(jobs);
    if (!parsed.success) return { queued: 0 };
    this.ensureSchema();
    const now = new Date();
    let queued = 0;
    for (const job of parsed.data) {
      const stored = this.sql<{ issue_updated_at: string; checked_at: string }>`
        SELECT issue_updated_at, checked_at FROM results WHERE issue = ${job.issue}`[0];
      if (
        stored &&
        this.isFresh(
          { issueUpdatedAt: stored.issue_updated_at, checkedAt: stored.checked_at },
          job,
          now,
        )
      )
        continue;
      this.sql`INSERT INTO jobs (issue, issue_updated_at, enqueued_at, attempts)
        VALUES (${job.issue}, ${job.issueUpdatedAt}, ${now.toISOString()}, 0)
        ON CONFLICT(issue) DO UPDATE SET
          attempts = CASE WHEN issue_updated_at = excluded.issue_updated_at THEN attempts ELSE 0 END,
          issue_updated_at = excluded.issue_updated_at`;
      queued++;
    }
    const pending = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM jobs`[0]?.n ?? 0;
    if (pending > 0) await this.schedule(5, 'work', undefined, { idempotent: true });
    return { queued };
  }

  /** Alarm callback: works one job, then schedules the next while the daily budget lasts. */
  async work(): Promise<void> {
    try {
      await this.guard();
    } catch {
      return; // halted: jobs stay queued
    }
    this.ensureSchema();
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const used = this.state.day === day ? this.state.jobsToday : 0;
    if (used >= MAX_JOBS_PER_DAY) return; // the next enqueue after midnight UTC resumes
    const job = this.sql<JobRow>`SELECT issue, issue_updated_at, attempts FROM jobs
      ORDER BY enqueued_at, issue LIMIT 1`[0];
    if (!job) return;
    const runId = crypto.randomUUID();
    this.setState({ ...this.state, day, jobsToday: used + 1, lastRunAt: now.toISOString() });
    let more = true;
    try {
      const result = await this.run(this.repo, job.issue, this.deps(runId));
      if (result === null) this.sql`DELETE FROM results WHERE issue = ${job.issue}`;
      else
        this.sql`INSERT INTO results (issue, issue_updated_at, result, checked_at, reported_at)
          VALUES (${job.issue}, ${job.issue_updated_at}, ${JSON.stringify(result)}, ${now.toISOString()}, NULL)
          ON CONFLICT(issue) DO UPDATE SET issue_updated_at = excluded.issue_updated_at,
            result = excluded.result, checked_at = excluded.checked_at, reported_at = NULL`;
      this.sql`DELETE FROM jobs WHERE issue = ${job.issue}`;
      console.log(
        JSON.stringify({
          event: `${this.manifest.id}.job`,
          runId,
          issue: job.issue,
          ok: true,
          skipped: result === null,
        }),
      );
    } catch (err) {
      if (err instanceof AgentHaltedError) return;
      // Class, status and error type only: never model output or issue text.
      const what = describeError(err);
      const attempts = job.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        this.sql`DELETE FROM jobs WHERE issue = ${job.issue}`;
        this.recordError(`#${job.issue}: gave up after ${attempts} attempts (${what})`);
      } else {
        // To the back of the queue, so one failing issue cannot block the others.
        this.sql`UPDATE jobs SET attempts = ${attempts}, enqueued_at = ${now.toISOString()}
          WHERE issue = ${job.issue}`;
        this.recordError(`#${job.issue}: ${what}`);
      }
      // Infrastructure failures stop the chain; the next enqueue (next triage poll) retries.
      more = isInputSpecific(err);
      console.warn(
        JSON.stringify({
          event: `${this.manifest.id}.job`,
          runId,
          issue: job.issue,
          ok: false,
          what,
        }),
      );
    }
    const left = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM jobs`[0]?.n ?? 0;
    // Idempotent: never two alarm chains working the same queue head.
    if (more && left > 0 && used + 1 < MAX_JOBS_PER_DAY)
      await this.schedule(2, 'work', undefined, { idempotent: true });
  }

  /** Called by triage over RPC when it builds a digest. */
  pendingResults(): PendingResults {
    this.ensureSchema();
    const rows = this.sql<ResultRow>`SELECT issue, issue_updated_at, result, checked_at
      FROM results WHERE reported_at IS NULL ORDER BY issue`;
    return {
      results: rows.map((r) => ({
        issue: r.issue,
        issueUpdatedAt: r.issue_updated_at,
        checkedAt: r.checked_at,
        result: r.result,
      })),
      errors: this.state.lastErrors,
    };
  }

  /** Called by triage over RPC after the digest went out. */
  markReported(issues: unknown, stamp: unknown): void {
    const ok = z.array(z.number().int().positive()).max(1000).safeParse(issues);
    const at = z.iso.datetime().safeParse(stamp);
    if (!ok.success || !at.success) return;
    this.ensureSchema();
    for (const issue of ok.data)
      this.sql`UPDATE results SET reported_at = ${at.data} WHERE issue = ${issue}`;
    this.setState({ ...this.state, lastErrors: [] });
  }

  override async onRequest(): Promise<Response> {
    this.ensureSchema();
    return Response.json({
      manifest: this.manifest,
      state: this.state,
      killSwitch: await this.killSwitch.state(this.manifest.id),
      queued: this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM jobs`[0]?.n ?? 0,
      recent: this.sql<{ issue: number; checked_at: string }>`SELECT issue, checked_at
        FROM results ORDER BY checked_at DESC LIMIT 20`,
    });
  }

  private recordError(e: string): void {
    this.setState({ ...this.state, lastErrors: [e, ...this.state.lastErrors].slice(0, 20) });
  }

  private deps(runId: string): SpecialistDeps {
    const gateway = new AnthropicGateway({
      accountId: this.env.AI_GATEWAY_ACCOUNT_ID,
      gatewayId: this.env.AI_GATEWAY_ID,
      gatewayToken: this.env.AI_GATEWAY_TOKEN,
    });
    const meta = (issue: number) => ({ agentId: this.manifest.id, runId, issue: String(issue) });
    return {
      reader: new BrokerGitHubReader(this.env.BROKER, this.manifest.id, runId),
      select: async (system, user, issue) => {
        await this.guard();
        return AnthropicGateway.text(
          await gateway.messages(selectRequest(system, user, meta(issue))),
        );
      },
      assess: async (system, user, issue) => {
        await this.guard();
        return AnthropicGateway.text(
          await gateway.messages(assessRequest(system, user, meta(issue))),
        );
      },
    };
  }
}
