import type { AgentManifest } from '@custodes/schema';
import { SpecialistAgent, type SpecialistJob } from './specialists/agent.js';
import { reviewProposal } from './specialists/proposal.js';
import type { SpecialistDeps } from './specialists/run.js';

export const PROPOSAL_REVIEW_MANIFEST: AgentManifest = {
  id: 'proposal-review',
  version: '0.1.0',
  description:
    'Read-only: for community issues not yet accepted, checks whether the proposal is sound, already covered or a real gap, and recommends labels, assignee and a comment. Called by triage.',
  mode: 'readonly',
  repos: ['OWASP/CheatSheetSeries'],
};

export class ProposalReviewAgent extends SpecialistAgent {
  readonly manifest = PROPOSAL_REVIEW_MANIFEST;

  protected run(repo: string, issue: number, deps: SpecialistDeps): Promise<unknown> {
    return reviewProposal(repo, issue, deps);
  }

  /** Reviewed once per issue version. */
  protected isFresh(stored: { issueUpdatedAt: string }, job: SpecialistJob): boolean {
    return stored.issueUpdatedAt === job.issueUpdatedAt;
  }
}
