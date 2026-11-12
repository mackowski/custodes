import { CustodesAgent } from '@custodes/core/agent';
import type { AgentManifest } from '@custodes/schema';
import { describeError } from './triage/errors.js';
import { BrokerGitHubReader, type IssueComment } from './triage/github.js';
import { INSTANCES } from '../instances.js';
import type { AgentsEnv } from '../env.js';
import { canonicalJson, sha256Hex } from '@custodes/core';
import {
  buildBundle,
  commentVersions,
  ProposalInput,
  type ProposeResult,
} from './triage-apply/bundle.js';

export const TRIAGE_APPLY_MANIFEST: AgentManifest = {
  id: 'triage-apply',
  version: '0.1.0',
  description:
    'Turns one triage proposal (assignee, labels, comment) into one approval request; the broker applies it only after the operator approves the e-mailed link (ADR 0019). No model.',
  mode: 'hitl',
  repos: ['mackowski/custodes-sandbox'],
};

/** Comment pages read per issue (100 each), as many as the broker reads before running. */
const MAX_COMMENT_PAGES = 10;

/**
 * One instance per repository (instances.ts). Holds no state of its own: every call reads the
 * issue again, so a proposal is always checked against the thread as it is now.
 */
export class TriageApplyAgent extends CustodesAgent<AgentsEnv> {
  readonly manifest = TRIAGE_APPLY_MANIFEST;

  /** The repository this instance works on; refuses anything else. */
  private get repo(): string | null {
    const inst = Object.hasOwn(INSTANCES, this.name) ? INSTANCES[this.name] : undefined;
    return inst && this.manifest.repos.includes(inst.repo) ? inst.repo : null;
  }

  async propose(raw: unknown): Promise<ProposeResult> {
    const parsed = ProposalInput.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'invalid proposal' };
    const input = parsed.data;
    if (this.repo === null || input.repo !== this.repo)
      return { ok: false, reason: 'repository not served by this instance' };
    const runId = crypto.randomUUID();
    try {
      await this.guard();
      const reader = new BrokerGitHubReader(this.broker, this.manifest.id, runId);
      const issue = await reader.getIssue(input.repo, input.issue);
      const comments: IssueComment[] = [];
      for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
        const batch = await reader.listComments(input.repo, input.issue, page);
        comments.push(...batch);
        if (batch.length < 100) break;
      }
      const digest = await sha256Hex(canonicalJson(commentVersions(comments)));
      const built = buildBundle(input, issue, comments, digest);
      if (!built.ok) return built;
      const asked = await this.requestBundleApproval(built.bundle, input.reason, runId, {
        kind: 'schedule',
        ref: 'triage-digest',
      });
      const types = built.bundle.actions.map((a) => a.type);
      console.log(
        JSON.stringify({
          event: 'triage-apply.propose',
          repo: input.repo,
          issue: input.issue,
          runId,
          actions: types,
          dropped: built.dropped.length,
          ok: asked.ok,
          ...(asked.ok ? {} : { status: asked.status }),
        }),
      );
      if (!asked.ok)
        return {
          ok: false,
          reason: `broker refused (${asked.status}${asked.error ? `: ${asked.error}` : ''})`,
          dropped: built.dropped,
        };
      return {
        ok: true,
        token: asked.created.token,
        expiresAt: asked.created.approval.expiresAt,
        actions: types,
        dropped: built.dropped,
      };
    } catch (err) {
      return { ok: false, reason: describeError(err).slice(0, 200) };
    }
  }
}
