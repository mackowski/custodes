import { getAgentByName } from 'agents';
import { CustodesAgent } from '@custodes/core/agent';
import { AnthropicGateway, inertText } from '@custodes/llm';
import type { AgentManifest } from '@custodes/schema';
import type { AgentsEnv } from '../env.js';
import { PendingResults, type SpecialistJob } from './specialists/agent.js';
import { ImplementationCheck } from './specialists/implementation.js';
import { ProposalReview } from './specialists/proposal.js';
import { Assessment } from './triage/assess.js';
import { renderDigest, type DigestItem, type SpecialistItem } from './triage/digest.js';
import { renderDigestHtml } from './triage/digest-html.js';
import { describeError } from './triage/errors.js';
import { closedSince, proposalJobs, sweepAcks, withoutClosed } from './triage/route.js';
import { triageRequest } from './triage/model.js';
import { BrokerGitHubReader, type PublicIssue } from './triage/github.js';
import { runTriage, type TriageStore } from './triage/run.js';

export const TRIAGE_MANIFEST: AgentManifest = {
  id: 'triage',
  version: '0.2.0',
  description:
    'Read-only triage report for OWASP Cheat Sheet Series issues: suggests labels, cheat sheet and duplicates, delegates to implementation-check and proposal-review, e-mails daily.',
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
    // Input-specific failures (unparseable or refused output), so one bad issue cannot stall the cursor.
    this.sql`CREATE TABLE IF NOT EXISTS failures (
      issue            INTEGER PRIMARY KEY,
      issue_updated_at TEXT NOT NULL,
      attempts         INTEGER NOT NULL
    )`;
    // Open accepted issues and when ACK_OBTAINED was applied (refreshed every poll).
    this.sql`CREATE TABLE IF NOT EXISTS acks (
      issue  INTEGER PRIMARY KEY,
      ack_at TEXT NOT NULL
    )`;
  }

  private specialist(kind: 'implementation' | 'proposal') {
    return kind === 'implementation'
      ? getAgentByName(this.env.ImplementationCheckAgent, TRIAGE_INSTANCE)
      : getAgentByName(this.env.ProposalReviewAgent, TRIAGE_INSTANCE);
  }

  /**
   * Agent calls agent: hands issue numbers (never issue text) to the specialists, which read the
   * issue themselves under their own broker read policy and queue the work.
   */
  private async delegate(
    kind: 'implementation' | 'proposal',
    jobs: SpecialistJob[],
  ): Promise<number> {
    if (jobs.length === 0) return 0;
    const stub = await this.specialist(kind);
    return (await stub.enqueue(jobs.slice(0, 100))).queued;
  }

  /** Refreshes the accepted-issue table and delegates; failures are reported, never fatal. */
  private async route(
    reader: BrokerGitHubReader,
    assessed: Parameters<typeof proposalJobs>[0],
    now: Date,
  ): Promise<{ errors: string[]; proposals: number; checks: number }> {
    const errors: string[] = [];
    let proposals = 0;
    let checks = 0;
    try {
      const known = new Map(
        this.sql<{ issue: number; ack_at: string }>`SELECT issue, ack_at FROM acks`.map((r) => [
          r.issue,
          r.ack_at,
        ]),
      );
      const sweep = await sweepAcks(this.repo, known, reader, now);
      this.sql`DELETE FROM acks`;
      for (const [issue, at] of sweep.acks)
        this.sql`INSERT INTO acks (issue, ack_at) VALUES (${issue}, ${at})`;
      checks = await this.delegate('implementation', sweep.staleJobs);
    } catch (err) {
      errors.push(`ACK sweep: ${describeError(err)}`);
    }
    try {
      proposals = await this.delegate('proposal', proposalJobs(assessed));
    } catch (err) {
      errors.push(`proposal review hand-off: ${describeError(err)}`);
    }
    return { errors, proposals, checks };
  }

  private async collect<R>(
    kind: 'implementation' | 'proposal',
    schema: { safeParse(v: unknown): { success: true; data: R } | { success: false } },
    errors: string[],
  ): Promise<(SpecialistItem<R> & { checkedAt: string })[]> {
    let pending: PendingResults;
    try {
      pending = PendingResults.parse(await (await this.specialist(kind)).pendingResults());
    } catch (err) {
      errors.push(`${kind} results unavailable: ${describeError(err)}`);
      return [];
    }
    const label = kind === 'implementation' ? 'implementation-check' : 'proposal-review';
    errors.push(...pending.errors.map((e) => `${label}: ${e}`));
    const items: (SpecialistItem<R> & { checkedAt: string })[] = [];
    for (const r of pending.results) {
      // Re-validated on receipt: the digest only renders what passes the schema.
      let json: unknown;
      try {
        json = JSON.parse(r.result);
      } catch {
        json = undefined;
      }
      const parsed = schema.safeParse(json);
      if (parsed.success)
        items.push({ issue: r.issue, result: parsed.data, checkedAt: r.checkedAt });
      else errors.push(`${label}: #${r.issue} result failed validation`);
    }
    return items;
  }

  private store(): TriageStore {
    return {
      isCurrent: (issue, updatedAt) =>
        this.sql<{
          n: number;
        }>`SELECT COUNT(*) AS n FROM assessments WHERE issue = ${issue} AND issue_updated_at = ${updatedAt}`[0]
          ?.n === 1,
      failures: (issue, updatedAt) =>
        this.sql<{
          attempts: number;
        }>`SELECT attempts FROM failures WHERE issue = ${issue} AND issue_updated_at = ${updatedAt}`[0]
          ?.attempts ?? 0,
      recordFailure: (issue, updatedAt) => {
        this
          .sql`INSERT INTO failures (issue, issue_updated_at, attempts) VALUES (${issue}, ${updatedAt}, 1)
          ON CONFLICT(issue) DO UPDATE SET
            attempts = CASE WHEN issue_updated_at = excluded.issue_updated_at THEN attempts + 1 ELSE 1 END,
            issue_updated_at = excluded.issue_updated_at`;
        return (
          this.sql<{
            attempts: number;
          }>`SELECT attempts FROM failures WHERE issue = ${issue}`[0]?.attempts ?? 1
        );
      },
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
    const reader = new BrokerGitHubReader(this.env.BROKER, this.manifest.id, runId);
    try {
      const result = await runTriage(this.repo, since, {
        reader,
        store: this.store(),
        now: () => new Date(),
        complete: async (system, user, issue) => {
          await this.guard(); // re-check between model calls so a halt takes effect mid-run
          const res = await gateway.messages(
            triageRequest(system, user, { agentId: this.manifest.id, runId, issue: String(issue) }),
          );
          return AnthropicGateway.text(res);
        },
      });
      const routed = await this.route(reader, result.assessedIssues, now);
      this.setState({
        ...this.state,
        since: result.nextSince,
        lastPollAt: now.toISOString(),
        lastErrors: [...result.errors, ...routed.errors, ...this.state.lastErrors].slice(0, 20),
        assessedTotal: this.state.assessedTotal + result.assessed,
      });
      console.log(
        JSON.stringify({
          event: 'triage.poll',
          runId,
          assessed: result.assessed,
          skipped: result.skipped,
          errors: result.errors.length + routed.errors.length,
          delegatedProposals: routed.proposals,
          delegatedChecks: routed.checks,
        }),
      );
      return {
        ok: true,
        detail: `assessed ${result.assessed}, skipped ${result.skipped}, errors ${result.errors.length + routed.errors.length}, delegated ${routed.proposals} review(s) and ${routed.checks} check(s)`,
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

  private markDigested(rows: { issue: number }[], stamp: string): void {
    for (const r of rows)
      this.sql`UPDATE assessments SET digested_at = ${stamp} WHERE issue = ${r.issue}`;
  }

  /** Marks specialist results reported, including those about closed issues, so none come back. */
  private async markHandled(
    implementation: { issue: number }[],
    proposals: { issue: number }[],
    stamp: string,
  ): Promise<void> {
    for (const [kind, list] of [
      ['implementation', implementation],
      ['proposal', proposals],
    ] as const) {
      try {
        await (
          await this.specialist(kind)
        ).markReported(
          list.map((i) => i.issue),
          stamp,
        );
      } catch (err) {
        // The results come again in the next digest; better twice than never.
        console.warn(
          JSON.stringify({ event: 'triage.digest.mark_failed', kind, what: describeError(err) }),
        );
      }
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
    const accepted = new Set(
      this.sql<{ issue: number }>`SELECT issue FROM acks`.map((r) => r.issue),
    );
    const items: DigestItem[] = [];
    let omittedAck = 0;
    for (const r of rows) {
      const parsed = Assessment.safeParse(JSON.parse(r.assessment));
      if (!parsed.success) continue;
      // Accepted issues are the maintainers' backlog, not news; flagged ones are still shown.
      const flagged = parsed.data.needsMaintainer || parsed.data.injectionDetected;
      if (accepted.has(r.issue) && !flagged) {
        omittedAck++;
        continue;
      }
      items.push({
        issue: r.issue,
        title: inertText(r.title, 200),
        url: r.url,
        assessment: parsed.data,
      });
    }
    const errors = [...this.state.lastErrors];
    const allImplementation = await this.collect('implementation', ImplementationCheck, errors);
    const allProposals = await this.collect('proposal', ProposalReview, errors);
    const closed = await closedSince(
      new BrokerGitHubReader(this.env.BROKER, this.manifest.id, crypto.randomUUID()),
      this.repo,
      // When we saw each issue open (closedSince subtracts slack for a close during a poll). Not
      // the issue's own updated_at: a dormant accepted issue would push the window back years.
      [
        ...rows.map((r) => r.assessed_at),
        ...allImplementation.map((i) => i.checkedAt),
        ...allProposals.map((p) => p.checkedAt),
      ],
      errors,
    );
    // Closed issues leave the digest, but an injection attempt is still worth knowing about.
    const closedFlagged = [
      ...items.filter((i) => i.assessment.injectionDetected).map((i) => i.issue),
      ...allImplementation.filter((i) => i.result.injectionDetected).map((i) => i.issue),
      ...allProposals.filter((p) => p.result.injectionDetected).map((p) => p.issue),
    ].filter((n, idx, all) => closed.has(n) && all.indexOf(n) === idx);
    if (closedFlagged.length)
      errors.push(
        `closed issues flagged for possible prompt injection: ${closedFlagged.map((n) => `#${n}`).join(', ')}`,
      );
    const openItems = withoutClosed(items, closed);
    const implementationOpen = withoutClosed(allImplementation, closed);
    const proposalsOpen = withoutClosed(allProposals, closed);
    const omittedClosed = openItems.dropped + implementationOpen.dropped + proposalsOpen.dropped;
    const implementation = implementationOpen.kept;
    const proposals = proposalsOpen.kept;
    items.splice(0, items.length, ...openItems.kept);
    if (
      items.length === 0 &&
      implementation.length === 0 &&
      proposals.length === 0 &&
      errors.length === 0
    ) {
      // Everything left was about closed issues: mark it so it is not re-checked every day.
      if (omittedClosed > 0) {
        const stamp = new Date().toISOString();
        this.markDigested(rows, stamp);
        await this.markHandled(allImplementation, allProposals, stamp);
      }
      return { ok: true, detail: `nothing to report (${omittedClosed} closed omitted)` };
    }

    const now = new Date();
    const digestInput = {
      repo: this.repo,
      items,
      implementation,
      proposals,
      omittedAck,
      omittedClosed,
      errors,
      since: this.state.lastDigestAt,
      now,
    };
    const digest = { ...renderDigest(digestInput), html: renderDigestHtml(digestInput) };
    try {
      // Re-check right before the side effect: the closed-issue read above may have taken a while.
      await this.guard();
      await this.env.EMAIL.send({
        from: { name: 'Custodes triage', email: this.env.EMAIL_FROM },
        to: this.env.OPERATOR_EMAIL,
        subject: digest.subject,
        text: digest.text,
        html: digest.html,
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
    this.markDigested(rows, stamp);
    this.setState({ ...this.state, lastDigestAt: stamp, lastErrors: [] });
    await this.markHandled(allImplementation, allProposals, stamp);
    console.log(
      JSON.stringify({
        event: 'triage.digest.sent',
        items: items.length,
        omittedAck,
        implementation: implementation.length,
        proposals: proposals.length,
        omittedClosed,
      }),
    );
    return {
      ok: true,
      detail: `sent ${items.length} item(s), ${implementation.length} check(s), ${proposals.length} review(s)`,
    };
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
