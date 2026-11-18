import { getAgentByName } from 'agents';
import { CustodesAgent } from '@custodes/core/agent';
import { AnthropicGateway, inertText } from '@custodes/llm';
import { ApprovalToken } from '@custodes/schema';
import type { AgentsEnv } from '../env.js';
import {
  instanceOf,
  noSuchAction,
  OWASP_INSTANCE,
  UnknownInstanceError,
  unknownInstance,
} from '../instances.js';
import { PendingResults, type SpecialistJob } from './specialists/agent.js';
import { ProposalReview } from './specialists/proposal.js';
import { Assessment } from './triage/assess.js';
import { ProposeResult } from './triage-apply/bundle.js';
import { assignWhyText } from './triage/digest.js';
import {
  type ApplyLink,
  renderDigest,
  type DigestItem,
  type SpecialistItem,
} from './triage/digest.js';
import { renderDigestHtml } from './triage/digest-html.js';
import { describeError } from './triage/errors.js';
import { digestContexts, IssueContext, issueContext } from './triage/excerpt.js';
import {
  closedIn,
  currentSince,
  pendingProposalJobs,
  reconcileProposals,
  withoutClosed,
  withoutTaken,
} from './triage/route.js';
import { triageRequest } from './triage/model.js';
import { BrokerGitHubReader, type PublicIssue } from './triage/github.js';
import { runTriage, type TriageStore } from './triage/run.js';

/** One-click links per digest; the rest are listed as "without a link" (ADR 0019). */
const MAX_APPLY_LINKS = 20;

export { TRIAGE_MANIFEST } from '../manifests.js';
import { TRIAGE_MANIFEST } from '../manifests.js';

/** One instance per repository. */
export const TRIAGE_INSTANCE = OWASP_INSTANCE;

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

  /** The repository is chosen by the instance name only (see instances.ts). */
  private get repo(): string {
    return instanceOf(this.name).repo;
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
    // GitHub facts and the author's inert text for the digest card (IssueContext), per issue.
    this.sql`CREATE TABLE IF NOT EXISTS issue_context (
      issue   INTEGER PRIMARY KEY,
      context TEXT NOT NULL
    )`;
    // shortcut: needed for the first deploy of triage 0.3 only (accepted issues went to
    // implementation-check until then, #132); remove in the next change to this file.
    this.sql`DROP TABLE IF EXISTS acks`;
  }

  private proposalReview() {
    return getAgentByName(this.env.ProposalReviewAgent, this.name);
  }

  /**
   * Agent calls agent: hands issue numbers (never issue text) to proposal-review, which reads the
   * issue itself under its own broker read policy and queues the work.
   */
  private async delegate(jobs: SpecialistJob[]): Promise<number> {
    // Called even with no jobs: it also wakes the specialist's queue (see enqueue).
    return (await (await this.proposalReview()).enqueue(jobs.slice(0, 100))).queued;
  }

  /** The stored card context of an issue, if any and still valid. */
  private storedContext(issue: number): IssueContext | undefined {
    const raw = this.sql<{
      context: string;
    }>`SELECT context FROM issue_context WHERE issue = ${issue}`[0]?.context;
    if (raw === undefined) return undefined;
    const parsed = IssueContext.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  }

  /** Pending issues for proposal review, minus those accepted or assigned since triage saw them. */
  private async pendingProposalJobs(
    reader: BrokerGitHubReader,
    errors: string[],
  ): Promise<SpecialistJob[]> {
    const rows = this.sql<{
      issue: number;
      issue_updated_at: string;
      assessment: string;
      assessed_at: string;
    }>`SELECT issue, issue_updated_at, assessment, assessed_at FROM assessments
      WHERE digested_at IS NULL`;
    // Fails open: on a read error nothing is filtered and the error is reported.
    const current = await currentSince(
      reader,
      this.repo,
      rows.map((r) => r.assessed_at),
      errors,
    );
    return pendingProposalJobs(
      rows.map((r) => {
        const parsed = Assessment.safeParse(JSON.parse(r.assessment));
        return {
          issue: r.issue,
          issueUpdatedAt: r.issue_updated_at,
          kind: parsed.success ? parsed.data.kind : null,
        };
      }),
      current,
    );
  }

  private async collect(
    errors: string[],
  ): Promise<(SpecialistItem<ProposalReview> & { checkedAt: string; issueUpdatedAt: string })[]> {
    let pending: PendingResults;
    try {
      pending = PendingResults.parse(await (await this.proposalReview()).pendingResults());
    } catch (err) {
      errors.push(`proposal results unavailable: ${describeError(err)}`);
      return [];
    }
    errors.push(...pending.errors.map((e) => `proposal-review: ${e}`));
    const items: (SpecialistItem<ProposalReview> & {
      checkedAt: string;
      issueUpdatedAt: string;
    })[] = [];
    for (const r of pending.results) {
      // Re-validated on receipt: the digest only renders what passes the schema.
      let json: unknown;
      try {
        json = JSON.parse(r.result);
      } catch {
        json = undefined;
      }
      const parsed = ProposalReview.safeParse(json);
      if (parsed.success)
        items.push({
          issue: r.issue,
          result: parsed.data,
          checkedAt: r.checkedAt,
          issueUpdatedAt: r.issueUpdatedAt,
        });
      else errors.push(`proposal-review: #${r.issue} result failed validation`);
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
        // Only the inert excerpt and GitHub facts are kept, never the body.
        this.sql`INSERT INTO issue_context (issue, context)
          VALUES (${issue.number}, ${JSON.stringify(issueContext(issue))})
          ON CONFLICT(issue) DO UPDATE SET context = excluded.context`;
      },
    };
  }

  /**
   * Scheduled every few hours: assesses changed new issues (fast model; isNewIssue). With
   * `prepare` (once a day, shortly before the digest) it also hands the pending issues, in their
   * current version, to proposal-review, so its reviews match what the digest will show and each
   * issue is reviewed at most once a day.
   */
  async poll(opts: { prepare?: boolean } = {}): Promise<{ ok: boolean; detail: string }> {
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
    const reader = new BrokerGitHubReader(this.broker, this.manifest.id, runId);
    try {
      const result = await runTriage(this.repo, since, {
        reader,
        store: this.store(),
        now: () => new Date(),
        complete: async (system, user, issue, turn) => {
          await this.guard(); // re-check between model calls so a halt takes effect mid-run
          const res = await gateway.messages(
            triageRequest(system, user, { agentId: this.manifest.id, runId, issue: String(issue) }),
            turn,
          );
          return AnthropicGateway.text(res);
        },
        turn: (issue) => this.turn(this.repo, issue, runId),
      });
      const routeErrors: string[] = [];
      let proposals = 0;
      if (opts.prepare === true)
        try {
          proposals = await this.delegate(await this.pendingProposalJobs(reader, routeErrors));
        } catch (err) {
          routeErrors.push(`proposal review hand-off: ${describeError(err)}`);
        }
      this.setState({
        ...this.state,
        since: result.nextSince,
        lastPollAt: now.toISOString(),
        lastErrors: [...result.errors, ...routeErrors, ...this.state.lastErrors].slice(0, 20),
        assessedTotal: this.state.assessedTotal + result.assessed,
      });
      console.log(
        JSON.stringify({
          event: 'triage.poll',
          runId,
          prepare: opts.prepare === true,
          assessed: result.assessed,
          skipped: result.skipped,
          notNew: result.notNew,
          errors: result.errors.length + routeErrors.length,
          delegatedProposals: proposals,
        }),
      );
      return {
        ok: true,
        detail: `assessed ${result.assessed}, skipped ${result.skipped}, not new ${result.notNew}, errors ${result.errors.length + routeErrors.length}, delegated ${proposals} review(s)`,
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
    // The author's text is kept only while a digest may still show it: pending issues. An issue
    // that changes again is re-assessed and its text read anew.
    this.sql`DELETE FROM issue_context
      WHERE issue NOT IN (SELECT issue FROM assessments WHERE digested_at IS NULL)`;
  }

  /** Marks proposal reviews reported, including those about closed issues, so none come back. */
  private async markHandled(proposals: { issue: number }[], stamp: string): Promise<void> {
    try {
      await (
        await this.proposalReview()
      ).markReported(
        proposals.map((i) => i.issue),
        stamp,
      );
    } catch (err) {
      // The results come again in the next digest; better twice than never.
      console.warn(
        JSON.stringify({
          event: 'triage.digest.mark_failed',
          kind: 'proposal',
          what: describeError(err),
        }),
      );
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
      if (!parsed.success) continue;
      items.push({
        issue: r.issue,
        title: inertText(r.title, 200),
        url: r.url,
        assessment: parsed.data,
      });
    }
    const errors = [...this.state.lastErrors];
    const allProposals = await this.collect(errors);
    // The issues as they are now, so the digest never repeats advice a maintainer already acted on.
    const state = { complete: true };
    const current = await currentSince(
      new BrokerGitHubReader(this.broker, this.manifest.id, crypto.randomUUID()),
      this.repo,
      // When we saw each issue open (currentSince subtracts slack for a change during a poll). Not
      // the issue's own updated_at: a dormant issue would push the window back years.
      [...rows.map((r) => r.assessed_at), ...allProposals.map((p) => p.checkedAt)],
      errors,
      state,
    );
    const closed = closedIn(current);
    // Closed issues leave the digest, but an injection attempt is still worth knowing about.
    const closedFlagged = [
      ...items.filter((i) => i.assessment.injectionDetected).map((i) => i.issue),
      ...allProposals.filter((p) => p.result.injectionDetected).map((p) => p.issue),
    ].filter((n, idx, all) => closed.has(n) && all.indexOf(n) === idx);
    if (closedFlagged.length)
      errors.push(
        `closed issues flagged for possible prompt injection: ${closedFlagged.map((n) => `#${n}`).join(', ')}`,
      );
    // A closed issue never comes back to triage: its stored author text goes.
    for (const n of closed) this.sql`DELETE FROM issue_context WHERE issue = ${n}`;
    const openItems = withoutClosed(items, closed);
    const proposalsOpen = withoutClosed(allProposals, closed);
    const omittedClosed = openItems.dropped + proposalsOpen.dropped;
    // Accepted or assigned after triage saw them: no longer new (#132's backlog), unless flagged.
    const stillNew = withoutTaken(openItems.kept, current);
    let omittedTaken = stillNew.taken;
    items.splice(0, items.length, ...stillNew.kept);
    const reconciled = reconcileProposals(proposalsOpen.kept, current);
    const proposals = state.complete
      ? reconciled.kept
      : reconciled.kept.map((p) => ({ ...p, result: { ...p.result, changedSinceReview: true } }));
    omittedTaken += reconciled.taken;
    if (items.length === 0 && proposals.length === 0 && errors.length === 0) {
      // Nothing to send, but every pending row was looked at (taken or closed): mark it, so old
      // rows do not keep widening the closed-issue window day after day.
      if (rows.length || allProposals.length) {
        const stamp = new Date().toISOString();
        this.markDigested(rows, stamp);
        await this.markHandled(allProposals, stamp);
      }
      return {
        ok: true,
        detail: `nothing to report (${omittedTaken} taken, ${omittedClosed} closed omitted)`,
      };
    }

    const contexts = digestContexts(
      items,
      proposals,
      (n) => this.storedContext(n),
      current,
      state.complete,
    );
    const now = new Date();
    const apply = await this.applyLinks(proposals);
    const digestInput = {
      repo: this.repo,
      items,
      proposals,
      contexts,
      applyLinks: apply.links,
      withoutLink: apply.withoutLink,
      omittedTaken,
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
    await this.markHandled(allProposals, stamp);
    console.log(
      JSON.stringify({
        event: 'triage.digest.sent',
        items: items.length,
        omittedTaken,
        proposals: proposals.length,
        omittedClosed,
      }),
    );
    return {
      ok: true,
      detail: `sent ${items.length} item(s), ${proposals.length} review(s)`,
    };
  }

  /**
   * One-click approval links for the digest's proposals (ADR 0019): triage-apply checks each one
   * against the issue and asks the broker for one approval. Absent until this Worker binds
   * TRIAGE_APPLY (custodes-triage only); flagged or stale proposals never get a link.
   */
  private async applyLinks(
    proposals: SpecialistItem<ProposalReview>[],
  ): Promise<{ links: Map<number, ApplyLink>; withoutLink: number }> {
    const links = new Map<number, ApplyLink>();
    let withoutLink = 0;
    const svc = this.env.TRIAGE_APPLY;
    const base = this.env.APPROVAL_LINK_BASE;
    if (svc === undefined || !base) return { links, withoutLink };
    for (const p of proposals) {
      const r = p.result;
      // An open discussion has no actions anyway (validateProposalReview); this keeps it so.
      if (r.injectionDetected || r.changedSinceReview || r.discussion === 'open') continue;
      const comment = r.suggestedComment.trim();
      if (!r.assignTo && !r.addLabels.length && !r.removeLabels.length && !comment) continue;
      if (links.size >= MAX_APPLY_LINKS) {
        withoutLink++;
        continue;
      }
      let out: ProposeResult;
      try {
        const raw: unknown = await svc.propose(this.name, {
          repo: this.repo,
          issue: p.issue,
          addLabels: r.addLabels,
          removeLabels: r.removeLabels,
          assignee: r.assignTo,
          comment,
          reason: `proposal review: ${r.verdict}${r.assignWhy ? `; assign: ${assignWhyText(r.assignWhy)}` : ''}`,
        });
        const parsed = ProposeResult.safeParse(raw);
        out = parsed.success
          ? parsed.data
          : { ok: false, reason: 'malformed answer from triage-apply' };
      } catch (err) {
        out = { ok: false, reason: `triage-apply unreachable (${describeError(err)})` };
      }
      // The token goes into a URL: only the broker's own format is accepted.
      if (out.ok && ApprovalToken.safeParse(out.token).success)
        links.set(p.issue, {
          url: `${base}/${out.token}`,
          expiresAt: out.expiresAt,
          actions: out.actions,
        });
      else if (!out.ok && out.reason.includes('too many pending approvals')) withoutLink++;
      else links.set(p.issue, { reason: out.ok ? 'malformed link token' : out.reason });
    }
    return { links, withoutLink };
  }

  /** Status for operators, reachable only through the Access-protected gateway. */
  override async onRequest(request: Request): Promise<Response> {
    let sandbox: boolean;
    try {
      sandbox = instanceOf(this.name).sandbox;
    } catch (err) {
      if (err instanceof UnknownInstanceError) return unknownInstance();
      throw err;
    }
    const url = new URL(request.url);
    // On-demand runs (ADR 0012) exist only for sandbox instances; real ones follow the crons.
    if (request.method === 'POST' && /\/(run|digest)$/.test(url.pathname)) {
      if (!sandbox)
        return Response.json({ error: 'on-demand runs are sandbox only' }, { status: 403 });
      return Response.json(
        url.pathname.endsWith('/digest')
          ? await this.sendDigest()
          : await this.poll({ prepare: true }),
      );
    }
    const refused = noSuchAction(request);
    if (refused) return refused;
    this.ensureSchema();
    const recent = this
      .sql<AssessmentRow>`SELECT issue, title, issue_updated_at, assessment, assessed_at
      FROM assessments ORDER BY assessed_at DESC LIMIT 20`;
    return Response.json({
      manifest: this.manifest,
      state: this.state,
      killSwitch: await this.haltState(),
      recent: recent.map((r) => ({
        issue: r.issue,
        title: inertText(r.title, 200),
        assessedAt: r.assessed_at,
        assessment: JSON.parse(r.assessment) as unknown,
      })),
    });
  }
}
