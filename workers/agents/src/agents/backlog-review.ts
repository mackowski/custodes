import { errorType } from '@custodes/core';
import { CustodesAgent } from '@custodes/core/agent';
import {
  AnthropicGateway,
  OpenRouterMessages,
  withFallback,
  runAgentTree,
  type ChildHook,
  type HostPort,
  type ReadFn,
} from '@custodes/llm';
import {
  BacklogVerdict,
  BrokerReadResponse,
  type BrokerReadRequest,
  type Trigger,
} from '@custodes/schema';
import { BACKLOG_REVIEW_MANIFEST } from '../manifests.js';
import type { AgentsEnv } from '../env.js';
import { instanceOf, noSuchAction, UnknownInstanceError, unknownInstance } from '../instances.js';
import { backlogAgents, POLICY } from './backlog-review/bundle.js';
import { raisesToHuman } from './backlog-review/raise.js';
import { selectIssues } from './backlog-review/selector.js';

export { raisesToHuman };
import { VerdictStore } from './backlog-review/store.js';
import { BrokerGitHubReader, type PublicIssue } from './triage/github.js';

export { BACKLOG_REVIEW_MANIFEST };

/**
 * #132 v1 is shadow: every routed action goes to the D1 digest, nothing reaches GitHub. Leaving
 * shadow is a reviewed code change (decisions on #132, 2026-11-26); a test pins it.
 * Before leaving shadow, the fallback model (FALLBACK_MODEL) must pass the same eval suite as the
 * primary, injection cases included (security review of the fallback, #168 M1).
 * shortcut: rows keep the issue's `updated_at` from before any action. Once live, the agent's own
 * comment or label bumps it and the issue is reviewed again next hour: v2 must store the
 * post-action `updated_at` or ignore its own events (lean review of #168, 10).
 */
export const SHADOW = true;

/**
 * When Anthropic fails (transport, API, credit balance), the same request goes to this model
 * through OpenRouter (operator decision on #132, 2026-11-26). Same list price as Sonnet 5.5.
 */
export const FALLBACK_MODEL = 'openai/gpt-6.2-sol';

/** `delegate` calls per orchestrator response: below the runtime's MAX_CALLS_PER_ROUND (8). */
export const DELEGATE_BATCH = 4;

/** Lists every open item: earlier than any issue on GitHub, but not the epoch (see openIssues). */
export const LIST_FROM = '2000-01-01T00:00:00Z';

/** Pages of 100 open issues and PRs listed per run; OWASP has about 40 open items in all. */
const MAX_LIST_PAGES = 5;

export interface BacklogRunResult {
  ok: boolean;
  detail: string;
  selected?: number;
  rootRunId?: string;
}

/**
 * backlog-review (#132 v1) on the agent runtime (ADR 0023). One instance per repository
 * (instances.ts); any other instance name is refused, so its run store, daily budget and HOTL cap
 * are the repository's only ones (security review of #166, L1). Runs from its hourly cron or on
 * demand through the Access-protected gateway.
 */
export class BacklogReviewAgent extends CustodesAgent<AgentsEnv> {
  readonly manifest = BACKLOG_REVIEW_MANIFEST;
  private busy = false;
  /** Tests replace the model transport (deterministic, no network); production uses `fetch`. */
  private modelFetch: typeof fetch | undefined;

  /** The repository of this instance; throws for an instance name that is not listed. */
  private get repo(): string {
    const { repo } = instanceOf(this.name);
    if (!this.manifest.repos.includes(repo)) throw new UnknownInstanceError(this.name);
    return repo;
  }

  private get store(): VerdictStore {
    const db = this.env.BACKLOG;
    if (db === undefined) throw new Error('BACKLOG is not bound');
    return new VerdictStore(db);
  }

  /** A read through the broker for one run: data, or the broker's code (never error text). */
  private readFn(): ReadFn {
    return async (runId, req) => {
      const body: BrokerReadRequest = { agentId: this.manifest.id, runId, ...req };
      try {
        const res = await this.broker.fetch('https://broker.internal/v1/read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const parsed = BrokerReadResponse.safeParse(await res.json());
        if (!parsed.success) return { ok: false, reason: 'invalid broker response' };
        return parsed.data.ok
          ? { ok: true, data: parsed.data.data }
          : { ok: false, reason: parsed.data.code };
      } catch {
        return { ok: false, reason: 'broker unreachable' };
      }
    };
  }

  /** Every open issue of the repository (pull requests dropped by the reader). */
  private async openIssues(runId: string): Promise<PublicIssue[]> {
    const reader = new BrokerGitHubReader(this.broker, this.manifest.id, runId);
    const out: PublicIssue[] = [];
    // Not the epoch: GitHub answers `since=1970-01-01T00:00:00Z` with an empty list (seen on the
    // first OWASP run, 2026-11-26), while any later date returns every open item.
    let since = LIST_FROM;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const { issues, resumeAt } = await reader.listUpdatedIssues(this.repo, since);
      for (const i of issues) if (!out.some((o) => o.number === i.number)) out.push(i);
      if (resumeAt === null) return out;
      since = resumeAt;
    }
    return out;
  }

  /**
   * One run: pick the issues that are due (code only), and if any, run the orchestrator over them
   * and record each child's verdict in D1. No model call when nothing is due.
   */
  async review(triggeredBy: Trigger, now = new Date()): Promise<BacklogRunResult> {
    if (this.busy) return { ok: true, detail: 'a run is in progress' };
    this.busy = true;
    const listRunId = crypto.randomUUID();
    try {
      await this.guard();
      const store = this.store;
      await store.prune(now);
      const repo = this.repo;
      const open = await this.openIssues(listRunId);
      const due = selectIssues(open, await store.lastVerdicts(repo), now);
      if (due.length === 0) return { ok: true, detail: 'nothing due', selected: 0 };
      const updatedAt = new Map(open.map((i) => [i.number, i.updated_at]));

      const { root, roles } = backlogAgents(repo);
      const reads = POLICY.reads[this.manifest.id];
      if (!reads) return { ok: false, detail: 'no read policy' };
      const gateway = new AnthropicGateway({
        accountId: this.env.AI_GATEWAY_ACCOUNT_ID,
        gatewayId: this.env.AI_GATEWAY_ID,
        gatewayToken: this.env.AI_GATEWAY_TOKEN,
        ...(this.modelFetch ? { fetchImpl: this.modelFetch } : {}),
      });
      let fallbacks = 0;
      const fallback = new OpenRouterMessages({
        accountId: this.env.AI_GATEWAY_ACCOUNT_ID,
        gatewayId: this.env.AI_GATEWAY_ID,
        gatewayToken: this.env.AI_GATEWAY_TOKEN,
        ...(this.modelFetch ? { fetchImpl: this.modelFetch } : {}),
      });
      const runStore = await this.runStore();
      const port: HostPort = {
        agentId: this.manifest.id,
        policy: POLICY,
        repos: [repo],
        resources: reads.resources,
        store: runStore,
        brokerGuard: () => this.guard(),
        read: this.readFn(),
        fallbackModel: FALLBACK_MODEL,
        send: withFallback(
          (req) => gateway.messages(req),
          // The kill switch again: the primary may have hung until its timeout (review N1).
          async (req) => {
            await this.guard();
            return fallback.messages(req);
          },
          FALLBACK_MODEL,
          (err) => {
            fallbacks++;
            // The error class, HTTP status and provider error type only, never its text.
            console.warn(
              JSON.stringify({
                event: 'backlog-review.model_fallback',
                what: errorType(err),
                model: FALLBACK_MODEL,
              }),
            );
          },
        ),
        act: (action, runId, snapshot) =>
          this.act(action, runId, triggeredBy, snapshot ? { snapshot } : {}),
        requestBundle: async (bundle, rationale, runId) => ({
          ok: (await this.requestBundleApproval(bundle, rationale, runId, triggeredBy)).ok,
        }),
        requestApproval: async (action, rationale, runId, snapshot) => ({
          ok: (await this.requestApproval(action, rationale, runId, triggeredBy, { snapshot })).ok,
        }),
        now: () => now,
      };

      const counts = { verdicts: 0, stopped: 0, unrecorded: 0 };
      const hook: ChildHook<BacklogVerdict> = {
        schema: BacklogVerdict,
        // Code raises: anything short of certain, or a state no rule covers, goes to a human.
        raiseNeedsHuman: raisesToHuman,
        // Each verdict is written as its child finishes, so a run cut short keeps what it paid for.
        onResult: async (r) => {
          // A child stopped before its first model call (kill switch, daily budget) or by an
          // error did no review: no row, so the issue stays due (security review r2 of #168, L1).
          // shortcut: an issue whose child keeps erroring after paid rounds is retried first every
          // hour; the tree's usdPerDay bounds it, and a non-zero `unrecorded` across consecutive
          // `backlog-review.run` logs is the signal (security review r3 of #168, L1).
          if (!r.ok && (r.rounds === 0 || r.stop === 'halted' || r.stop === 'error')) {
            counts.unrecorded++;
            return;
          }
          try {
            await store.record(r, {
              issueUpdatedAt: updatedAt.get(r.target.number) ?? '',
              agentVersion: this.manifest.version,
              now,
            });
            counts[r.ok ? 'verdicts' : 'stopped']++;
          } catch (err) {
            counts.unrecorded++;
            const what = err instanceof Error ? err.name : 'error';
            console.error(
              JSON.stringify({ event: 'backlog-review.record_failed', what, runId: r.runId }),
            );
          }
        },
      };
      // The task is code-built: issue numbers of this repository only, no text from GitHub.
      // The batch size is code-stated too: more than MAX_CALLS_PER_ROUND tool calls in one response
      // stop the whole run (invalid_args), as the first OWASP run did with 20 at once.
      const task = `Today is ${now.toISOString().slice(0, 10)}. Review these open issues of ${repo}: ${due.map((n) => `#${String(n)}`).join(', ')}. Delegate them at most ${String(DELEGATE_BATCH)} per response.`;
      const result = await runAgentTree(port, root, roles, task, {
        shadow: SHADOW,
        child: hook,
        // Only the issues code selected: the 20-per-run cap and triage's stream hold in code.
        allowTarget: (t) => t.repo === repo && t.kind === 'issue' && due.includes(t.number),
      });
      const { rootRunId } = result;
      console.log(
        JSON.stringify({
          event: 'backlog-review.run',
          repo,
          rootRunId,
          status: result.status,
          stop: result.stop ?? null,
          selected: due.length,
          ...counts,
          // Model calls answered by the fallback, which has not passed the golden suite as primary.
          fallbacks,
        }),
      );
      return {
        ok: result.status !== 'stopped',
        detail: result.stop ?? result.status,
        selected: due.length,
        rootRunId,
      };
    } catch (err) {
      // Ids only: the error class, never its text (it can carry GitHub or gateway output).
      const what = err instanceof Error ? err.name : 'error';
      console.error(JSON.stringify({ event: 'backlog-review.failed', what, listRunId }));
      return { ok: false, detail: what };
    } finally {
      this.busy = false;
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    try {
      instanceOf(this.name);
    } catch (err) {
      if (err instanceof UnknownInstanceError) return unknownInstance();
      throw err;
    }
    const runRoute = await this.handleRunRequest(request);
    if (runRoute) return runRoute;
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname.endsWith('/run'))
      return Response.json(await this.review({ kind: 'manual', ref: 'operator' }));
    return noSuchAction(request) ?? Response.json({ agent: this.manifest.id, shadow: SHADOW });
  }
}
