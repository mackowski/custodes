import { SpecialistAgent, type SpecialistJob } from './specialists/agent.js';
import { checkImplementation } from './specialists/implementation.js';
import type { SpecialistDeps } from './specialists/run.js';

export { IMPLEMENTATION_CHECK_MANIFEST } from '../manifests.js';
import { IMPLEMENTATION_CHECK_MANIFEST } from '../manifests.js';

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
