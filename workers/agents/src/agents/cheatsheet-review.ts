/**
 * cheatsheet-review (ADR 0017): a multi-model review of one pull request, started when the
 * operator adds the trigger label. The webhook is only a hint; the run re-reads the pull request
 * and its timeline through the broker and goes ahead only if the label is still there and the
 * configured actor added it. Each label event is reviewed once. The review is posted through the
 * broker as one `pr.review.inline` (never APPROVE), then the label is removed. A low-quality pull
 * request also produces an e-mail recommending to close it; nothing is closed or unassigned.
 */
import { errorType, invokeAgent, type Turn } from '@custodes/core';
import { AgentHaltedError, CustodesAgent } from '@custodes/core/agent';
import {
  AnthropicChat,
  AnthropicGateway,
  OpenRouterGateway,
  WorkersAiChat,
  type ChatModel,
  type ReviewModel,
} from '@custodes/llm';
import type { AgentManifest, BrokerResponse } from '@custodes/schema';
import type { AgentsEnv } from '../env.js';
import { instanceOf, UnknownInstanceError, unknownInstance } from '../instances.js';
import { partialReviewMail, lowQualityMail, type Mail } from './cheatsheet-review/email.js';
import { parsePatch } from './cheatsheet-review/diff.js';
import {
  processFacts,
  relatedSheets,
  type IssueFacts,
  type Snapshot,
} from './cheatsheet-review/input.js';
import { fetchLink } from './cheatsheet-review/links.js';
import { reviewPipeline } from './cheatsheet-review/pipeline.js';
import { limiter } from './cheatsheet-review/runner.js';
import { checkSuggestions, reviewBody, reviewEvent } from './cheatsheet-review/render.js';
import { fencedLines, isSheet, type ScopedFile } from './cheatsheet-review/scope.js';
import { disclosure, linkedIssueNumbers } from './pr-gate/rules.js';
import { describeError } from './triage/errors.js';
import { BrokerGitHubReader, issueLabels, type PublicPull } from './triage/github.js';

export const CHEATSHEET_REVIEW_MANIFEST: AgentManifest = {
  id: 'cheatsheet-review',
  version: '0.1.0',
  description:
    'Multi-model review of a cheat sheet pull request when the operator adds the trigger label: posts one review with inline suggestions, e-mails a close recommendation for low-quality PRs.',
  mode: 'hotl',
  repos: ['mackowski/custodes-sandbox'],
};

/** At most this many model calls at once: AI Gateway's rate limit is shared by every agent. */
const MAX_CONCURRENT_CALLS = 4;
/** Changed cheat sheets read in full; a larger PR is still reviewed from its diff. */
const MAX_FULL_FILES = 5;

interface CheatsheetReviewState {
  lastRunAt: string | null;
  lastErrors: string[];
}

interface ReviewRow {
  pull: number;
  label_event: number;
  head_sha: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  change_class: string | null;
  verdict: string | null;
  event: string | null;
  models: string | null;
  review_url: string | null;
}

export type ReviewOutcome =
  | { ok: true; status: 'posted' | 'mailed_only'; detail: string }
  | { ok: false; status: string; detail: string };

export class CheatsheetReviewAgent extends CustodesAgent<AgentsEnv, CheatsheetReviewState> {
  readonly manifest = CHEATSHEET_REVIEW_MANIFEST;
  override initialState: CheatsheetReviewState = { lastRunAt: null, lastErrors: [] };

  /** Injected in tests. */
  protected fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  protected sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  private get repo(): string {
    return instanceOf(this.name).repo;
  }

  private get trigger(): { label: string; actor: string } | undefined {
    return instanceOf(this.name).reviewTrigger;
  }

  private ensureSchema(): void {
    this.sql`CREATE TABLE IF NOT EXISTS reviews (
      pull INTEGER NOT NULL,
      label_event INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      change_class TEXT,
      verdict TEXT,
      event TEXT,
      models TEXT,
      review_url TEXT,
      PRIMARY KEY (pull, label_event)
    )`;
    // Ids and outcomes only, never content; 180 days.
    const cutoff = new Date(Date.now() - 180 * 86_400_000).toISOString();
    this.sql`DELETE FROM reviews WHERE started_at < ${cutoff}`;
  }

  /** The label was added (webhook). Schedules a run; one pending run per pull request. */
  async notify(pull: number): Promise<{ id: string; at: string }> {
    const s = await this.schedule(1, 'review', { pull }, { idempotent: true });
    return { id: s.id, at: new Date(Date.now() + 1_000).toISOString() };
  }

  /** Alarm callback. */
  async review(payload: { pull: number }): Promise<void> {
    const r = await this.runReview(payload.pull);
    console.log(
      JSON.stringify({
        event: 'cheatsheet-review.run',
        instance: this.name,
        pull: payload.pull,
        ...r,
      }),
    );
  }

  private clients(): Record<ReviewModel['transport'], ChatModel> {
    const accountId = this.env.AI_GATEWAY_ACCOUNT_ID;
    const gatewayId = this.env.AI_GATEWAY_ID;
    const gatewayToken = this.env.AI_GATEWAY_TOKEN;
    return {
      anthropic: new AnthropicChat(new AnthropicGateway({ accountId, gatewayId, gatewayToken })),
      openrouter: new OpenRouterGateway({ accountId, gatewayId, gatewayToken }),
      'workers-ai': new WorkersAiChat({
        ai: {
          run: (model, inputs, options) =>
            this.env.AI.run(model as never, inputs as never, options),
        },
        gatewayId,
      }),
    };
  }

  async runReview(pull: number): Promise<ReviewOutcome> {
    const trigger = this.trigger;
    if (!trigger)
      return { ok: false, status: 'no_trigger', detail: 'instance has no review trigger' };
    const repo = this.repo;
    const runId = crypto.randomUUID();
    const turn = this.turn(repo, pull, runId);
    try {
      await this.guard();
    } catch (err) {
      return { ok: false, status: 'halted', detail: describeError(err) };
    }
    this.ensureSchema();
    this.setState({ ...this.state, lastRunAt: new Date().toISOString() });
    try {
      return await invokeAgent(turn, (span) =>
        this.reviewTurn(repo, pull, trigger, runId, turn, span),
      );
    } catch (err) {
      const detail = describeError(err);
      this.setState({
        ...this.state,
        lastErrors: [`#${pull}: ${detail}`, ...this.state.lastErrors].slice(0, 20),
      });
      return { ok: false, status: err instanceof AgentHaltedError ? 'halted' : 'error', detail };
    }
  }

  private async reviewTurn(
    repo: string,
    pull: number,
    trigger: { label: string; actor: string },
    runId: string,
    turn: Turn,
    span: { set: (k: string, v: string | number | boolean | undefined) => void },
  ): Promise<ReviewOutcome> {
    const reader = new BrokerGitHubReader(this.env.BROKER, this.manifest.id, runId).inTurn(turn);

    // 1. Re-check the trigger against GitHub, never the webhook.
    const pr = await reader.getPull(repo, pull);
    if (pr.state !== 'open') return { ok: false, status: 'not_open', detail: pr.state };
    if (!pr.labels.some((l) => l.name === trigger.label))
      return { ok: false, status: 'label_gone', detail: 'trigger label not on the pull request' };
    const timeline = await reader.listTimelineAll(repo, pull);
    // The broker serves at most 1000 events, oldest first: the latest label event may be missing.
    if (timeline.length >= 1_000)
      return { ok: false, status: 'timeline_truncated', detail: 'more than 1000 timeline events' };
    const labelled = timeline
      .filter((e) => e.event === 'labeled' && e.label?.name === trigger.label)
      .at(-1);
    if (labelled?.id === undefined)
      return { ok: false, status: 'no_label_event', detail: 'no labeled event in the timeline' };
    if (labelled.actor?.login.toLowerCase() !== trigger.actor.toLowerCase()) {
      span.set('custodes.review.refused', 'actor');
      return {
        ok: false,
        status: 'wrong_actor',
        detail: 'label not added by the configured actor',
      };
    }
    const done = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM reviews
      WHERE pull = ${pull} AND label_event = ${labelled.id}`[0]?.n;
    if (done)
      return { ok: false, status: 'already_reviewed', detail: `label event ${labelled.id}` };
    const headSha = pr.head.sha;
    const started = new Date().toISOString();
    this.sql`INSERT INTO reviews (pull, label_event, head_sha, started_at, status)
      VALUES (${pull}, ${labelled.id}, ${headSha}, ${started}, 'running')`;
    const finish = (status: string, extra: Partial<ReviewRow> = {}) => {
      this.sql`UPDATE reviews SET status = ${status}, finished_at = ${new Date().toISOString()},
        change_class = ${extra.change_class ?? null}, verdict = ${extra.verdict ?? null},
        event = ${extra.event ?? null}, models = ${extra.models ?? null},
        review_url = ${extra.review_url ?? null}
        WHERE pull = ${pull} AND label_event = ${labelled.id ?? 0}`;
    };

    try {
      return await this.reviewClaimed(
        repo,
        pull,
        trigger,
        runId,
        turn,
        span,
        reader,
        pr,
        labelled.id,
        finish,
      );
    } catch (err) {
      // A row left `running` would hide the failure; the status endpoint shows `error`.
      finish('error');
      throw err;
    }
  }

  private async reviewClaimed(
    repo: string,
    pull: number,
    trigger: { label: string; actor: string },
    runId: string,
    turn: Turn,
    span: { set: (k: string, v: string | number | boolean | undefined) => void },
    reader: BrokerGitHubReader,
    pr: PublicPull,
    labelEvent: number,
    finish: (status: string, extra?: Partial<ReviewRow>) => void,
  ): Promise<ReviewOutcome> {
    const headSha = pr.head.sha;
    // 2. The frozen snapshot every reviewer sees.
    const snap = await this.snapshot(reader, repo, pr, headSha);

    // 3. Review.
    const result = await reviewPipeline(snap, {
      clients: this.clients(),
      guard: () => this.guard(),
      limit: limiter(MAX_CONCURRENT_CALLS),
      sleep: this.sleep,
      agentId: this.manifest.id,
      runId,
      turn,
      fetchLink: (url) => fetchLink(url, this.fetchImpl),
    });
    const models = JSON.stringify(result.outcomes);
    span.set('custodes.review.class', result.changeClass);
    span.set('custodes.review.verdict', result.decision?.verdict);
    span.set('custodes.review.injection_seen', result.injectionSeen);

    // 4. Not multi-model enough, or no decision: e-mail what there is, publish nothing.
    if (result.breach !== null || !result.decision) {
      const why = result.breach ?? 'no decision';
      await this.mail(
        partialReviewMail({
          repo,
          pull,
          why,
          outcomes: result.outcomes,
          decision: result.decision,
        }),
      );
      finish('mailed_only', { change_class: result.changeClass, models });
      return { ok: true, status: 'mailed_only', detail: why };
    }
    const d = result.decision;

    // 5. Post one review, then remove the label.
    const hunks = new Map(snap.files.map((f) => [f.file.filename, f.hunks]));
    const checked = checkSuggestions(d.suggestions, hunks, result.allowed);
    const ownPull = pr.user?.login.toLowerCase() === trigger.actor.toLowerCase();
    const confirmed = new Set<'Security' | 'Links & sources'>();
    for (const x of result.reports) {
      if (x.report.verdict !== 'BLOCK') continue;
      if (x.role === 'security-reviewer' || x.role === 'security-second-voice')
        confirmed.add('Security');
      if (x.role === 'link-auditor') confirmed.add('Links & sources');
    }
    const event = reviewEvent(d, ownPull, confirmed);
    const body = reviewBody({
      decision: d,
      outcomes: result.outcomes,
      changeClass: result.changeClass,
      classWhy: result.classWhy,
      facts: processFacts(snap).split('\n').slice(1).join('\n'),
      rejected: checked.rejected,
      linkNotes: result.linkNotes,
      allowed: result.allowed,
    });
    const trig = { kind: 'webhook' as const, ref: `label:${labelEvent}` };
    // The label is the operator's go-ahead: if it was removed, or the author pushed, during the
    // review, publish nothing (a new label event asks again).
    const now = await reader.getPull(repo, pull);
    if (!now.labels.some((l) => l.name === trigger.label)) {
      finish('cancelled', { change_class: result.changeClass, verdict: d.verdict, models });
      return { ok: false, status: 'cancelled', detail: 'trigger label removed during the review' };
    }
    if (now.head.sha !== headSha || now.state !== 'open') {
      finish('stale', { change_class: result.changeClass, verdict: d.verdict, models });
      return { ok: false, status: 'stale', detail: 'pull request changed during the review' };
    }
    const posted: BrokerResponse = await this.act(
      {
        type: 'pr.review.inline',
        repo,
        pull,
        commitId: headSha,
        event,
        body,
        comments: checked.comments.map((c) => ({
          path: c.path,
          line: c.line,
          ...(c.startLine !== undefined ? { startLine: c.startLine } : {}),
          side: c.side,
          body: c.body.slice(0, 3_900),
        })),
      },
      runId,
      trig,
      { turn },
    );
    if (!posted.ok) {
      await this.mail(
        partialReviewMail({
          repo,
          pull,
          why: `the broker refused the review (${posted.code})`,
          outcomes: result.outcomes,
          decision: d,
        }),
      );
      finish('post_failed', {
        change_class: result.changeClass,
        verdict: d.verdict,
        event,
        models,
      });
      return { ok: false, status: 'post_failed', detail: posted.code };
    }
    const reviewUrl = posted.githubUrl;
    finish('posted', {
      change_class: result.changeClass,
      verdict: d.verdict,
      event,
      models,
      review_url: reviewUrl ?? null,
    });
    const removed = await this.act(
      { type: 'issue.label.remove', repo, issue: pull, labels: [trigger.label] },
      runId,
      trig,
      { turn },
    );
    if (!removed.ok)
      console.warn(
        JSON.stringify({
          event: 'cheatsheet-review.label_remove_failed',
          pull,
          code: removed.code,
        }),
      );

    // 6. Low quality: recommend closing, by e-mail only.
    if (d.verdict === 'CLOSE' || d.lowQuality)
      await this.mail(
        lowQualityMail({
          repo,
          pull,
          author: pr.user?.login ?? 'unknown',
          title: pr.title,
          decision: d,
          reviewUrl,
          issues: snap.issues,
        }),
      );
    return {
      ok: true,
      status: 'posted',
      detail: `${d.verdict} ${event} ${checked.comments.length} suggestion(s)`,
    };
  }

  private async snapshot(
    reader: BrokerGitHubReader,
    repo: string,
    pr: Awaited<ReturnType<BrokerGitHubReader['getPull']>>,
    headSha: string,
  ): Promise<Snapshot> {
    const files = await reader.listPullFileDetails(repo, pr.number);
    const unreviewedFiles = Math.max(0, (pr.changed_files ?? files.length) - files.length);
    const contents = new Map<string, string>();
    for (const f of files
      .filter((x) => isSheet(x.filename) && x.status !== 'removed')
      .slice(0, MAX_FULL_FILES))
      contents.set(f.filename, await reader.getFileAtRef(repo, f.filename, headSha));
    const scoped: ScopedFile[] = files.map((file) => ({
      file,
      hunks: parsePatch(file.patch),
      codeLines: fencedLines(contents.get(file.filename) ?? ''),
    }));
    const sheetNames = await reader.listCheatSheets(repo);
    const related = new Map<string, string>();
    for (const name of relatedSheets([...contents.keys()], sheetNames))
      related.set(name, await reader.getCheatSheet(repo, name));
    const author = pr.user?.login ?? '';
    const issues: IssueFacts[] = [];
    for (const n of linkedIssueNumbers(pr.body, repo).slice(0, 3)) {
      try {
        const issue = await reader.getIssue(repo, n);
        if (issue.pull_request !== undefined) continue;
        const assignees = (issue.assignees ?? []).map((a) => a.login);
        issues.push({
          number: n,
          state: issue.state ?? 'unknown',
          labels: issueLabels(issue),
          assignees,
          authorAssigned: assignees.some((a) => a.toLowerCase() === author.toLowerCase()),
        });
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: 'cheatsheet-review.issue_read_failed',
            issue: n,
            error: errorType(err),
          }),
        );
      }
    }
    return {
      repo,
      pull: pr.number,
      headSha,
      author,
      title: pr.title,
      body: pr.body ?? '',
      files: scoped,
      contents,
      disclosure: disclosure(pr.body),
      issues,
      sheetNames,
      related,
      unreviewedFiles,
    };
  }

  private async mail(m: Mail): Promise<void> {
    try {
      await this.guard();
      await this.env.EMAIL.send({
        from: { name: 'Custodes cheatsheet-review', email: this.env.EMAIL_FROM },
        to: this.env.OPERATOR_EMAIL,
        subject: m.subject,
        text: m.text,
        html: m.html,
      });
    } catch (err) {
      console.warn(
        JSON.stringify({ event: 'cheatsheet-review.mail_failed', error: describeError(err) }),
      );
    }
  }

  /** Status for operators through the Access-protected gateway: ids and outcomes only. */
  override async onRequest(_request: Request): Promise<Response> {
    try {
      instanceOf(this.name);
    } catch (err) {
      if (err instanceof UnknownInstanceError) return unknownInstance();
      throw err;
    }
    this.ensureSchema();
    return Response.json({
      manifest: this.manifest,
      trigger: this.trigger ?? null,
      state: this.state,
      killSwitch: await this.killSwitch.state(this.manifest.id),
      reviews: this.sql<ReviewRow>`SELECT * FROM reviews ORDER BY started_at DESC LIMIT 50`,
    });
  }
}
