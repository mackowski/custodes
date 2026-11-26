import { redact } from '@custodes/core';
import type { Outcome } from '@custodes/llm';
import type { BacklogVerdict, ProposalTarget } from '@custodes/schema';
import type { LastVerdict } from './selector.js';

/** Rows older than this are deleted on every run (threat model backlog-review, I1). */
export const VERDICT_RETENTION_MS = 90 * 24 * 3_600_000;
/** Model text kept per verdict: `Proposal.reason` is at most 2,000 characters already. */
const REASON_CAP = 2_000;
/** A comment body or label list in an action, as stored: bounded like the broker's own limits. */
const ACTION_CAP = 70_000;

/** One child's result, as the runtime host reports it through its child hook. */
export type ChildResult = { rootRunId: string; runId: string; target: ProposalTarget } & (
  | { ok: true; output: BacklogVerdict; outcomes: Outcome[] }
  | { ok: false; stop: string; rounds: number }
);

/**
 * backlog-review's digest in D1 (`custodes-backlog`, #132 v1). Only this Worker writes it; the
 * operator reads it through the Cloudflare API. Append-only apart from the 90-day prune.
 */
export class VerdictStore {
  constructor(private readonly db: D1Database) {}

  /**
   * The newest row per issue of `repo`. A stopped child counts too: the issue then waits for a
   * change or 72 hours like a verdict, so one thread too long for the per-child budget cannot come
   * first every hour and take the day's budget (lean review of #168, 3).
   */
  async lastVerdicts(repo: string): Promise<Map<number, LastVerdict>> {
    // SQLite returns the bare columns of the row that holds MAX(at).
    const { results } = await this.db
      .prepare(
        `SELECT issue, issue_updated_at, MAX(at) AS at FROM verdicts
         WHERE repo = ? GROUP BY issue`,
      )
      .bind(repo)
      .all<{ issue: number; issue_updated_at: string; at: string }>();
    return new Map(results.map((r) => [r.issue, { issueUpdatedAt: r.issue_updated_at, at: r.at }]));
  }

  /** Records one child's verdict and its routed actions in one batch (one transaction). */
  async record(
    r: ChildResult,
    ctx: { issueUpdatedAt: string; agentVersion: string; now: Date },
  ): Promise<void> {
    const base = [
      r.target.repo,
      r.target.number,
      ctx.issueUpdatedAt,
      ctx.now.toISOString(),
      r.rootRunId,
      r.runId,
      ctx.agentVersion,
    ];
    if (!r.ok) {
      await this.db
        .prepare(
          `INSERT INTO verdicts (repo, issue, issue_updated_at, at, root_run_id, run_id, agent_version, status, stop)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'stopped', ?)`,
        )
        .bind(...base, r.stop.slice(0, 40))
        .run();
      return;
    }
    const v = r.output;
    // A child's run id is unique: its actions find their verdict by it, inside the same batch.
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO verdicts (repo, issue, issue_updated_at, at, root_run_id, run_id, agent_version,
             status, state, confidence, uncertain_because, needs_human, evidence, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          ...base,
          v.state,
          v.confidence,
          JSON.stringify(v.uncertainBecause),
          v.needsHuman ? 1 : 0,
          JSON.stringify(v.evidence),
          redact(v.reason).slice(0, REASON_CAP),
        ),
      ...r.outcomes.map((o, position) =>
        this.db
          .prepare(
            `INSERT INTO verdict_actions (verdict_id, position, action, route, live, detail)
             VALUES ((SELECT id FROM verdicts WHERE run_id = ?), ?, ?, ?, ?, ?)`,
          )
          .bind(
            r.runId,
            position,
            redact(JSON.stringify(o.brokerAction)).slice(0, ACTION_CAP),
            o.route,
            o.live ?? null,
            o.detail.slice(0, 200),
          ),
      ),
    ]);
  }

  /** Deletes verdicts older than 90 days and their actions. */
  async prune(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - VERDICT_RETENTION_MS).toISOString();
    await this.db.batch([
      this.db
        .prepare(
          'DELETE FROM verdict_actions WHERE verdict_id IN (SELECT id FROM verdicts WHERE at < ?)',
        )
        .bind(cutoff),
      this.db.prepare('DELETE FROM verdicts WHERE at < ?').bind(cutoff),
    ]);
  }
}
