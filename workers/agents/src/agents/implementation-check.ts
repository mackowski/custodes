import type { AgentManifest } from '@custodes/schema';
import { SpecialistAgent, type SpecialistJob } from './specialists/agent.js';
import { checkImplementation } from './specialists/implementation.js';
import type { SpecialistDeps } from './specialists/run.js';

export const IMPLEMENTATION_CHECK_MANIFEST: AgentManifest = {
  id: 'implementation-check',
  version: '0.1.0',
  description:
    'Read-only: for issues accepted (ACK_OBTAINED) over a week ago, checks whether the cheat sheets already implement them and quotes the evidence. Called by triage.',
  mode: 'readonly',
  repos: ['OWASP/CheatSheetSeries'],
};

/** A result is reused for this long while the issue is unchanged. */
const RECHECK_AFTER_MS = 30 * 86_400_000;

export class ImplementationCheckAgent extends SpecialistAgent {
  readonly manifest = IMPLEMENTATION_CHECK_MANIFEST;

  protected run(repo: string, issue: number, deps: SpecialistDeps): Promise<unknown> {
    return checkImplementation(repo, issue, deps);
  }

  protected isFresh(
    stored: { issueUpdatedAt: string; checkedAt: string },
    job: SpecialistJob,
    now: Date,
  ): boolean {
    return (
      stored.issueUpdatedAt === job.issueUpdatedAt &&
      now.getTime() - Date.parse(stored.checkedAt) < RECHECK_AFTER_MS
    );
  }
}
