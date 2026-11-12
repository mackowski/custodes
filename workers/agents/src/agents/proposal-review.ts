import type { AgentManifest } from '@custodes/schema';
import { INSTANCE_REPOS } from '../instances.js';
import { SpecialistAgent, type SpecialistJob } from './specialists/agent.js';
import { ProposalReview, reviewProposal } from './specialists/proposal.js';
import type { SpecialistDeps } from './specialists/run.js';

export const PROPOSAL_REVIEW_MANIFEST: AgentManifest = {
  id: 'proposal-review',
  version: '0.1.0',
  description:
    'Read-only: for community issues not yet accepted, checks whether the proposal is sound, already covered or a real gap, and recommends labels, assignee and a comment. Called by triage.',
  mode: 'readonly',
  repos: [...INSTANCE_REPOS],
};

export class ProposalReviewAgent extends SpecialistAgent {
  readonly manifest = PROPOSAL_REVIEW_MANIFEST;

  protected run(repo: string, issue: number, deps: SpecialistDeps): Promise<unknown> {
    return reviewProposal(repo, issue, deps);
  }

  /** Reviewed again when the author's 2 days end with no reply (ADR 0019). */
  protected override recheckAt(result: unknown): string | null {
    const parsed = ProposalReview.safeParse(result);
    return parsed.success ? parsed.data.recheckAt : null;
  }

  /** Reviewed once per issue version. */
  protected isFresh(stored: { issueUpdatedAt: string }, job: SpecialistJob): boolean {
    return stored.issueUpdatedAt === job.issueUpdatedAt;
  }
}
