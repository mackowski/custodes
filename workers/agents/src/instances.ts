/**
 * Which repository each agent instance (Durable Object name) works on. The instance name is the
 * only thing that selects a repository, so an agent can never be pointed at a repository that is
 * not listed here, in its manifest and in the broker policy.
 *
 * `sandbox` instances (ADR 0012) are test targets the operator owns: they can be run on demand
 * through the Access-protected gateway, they skip waiting periods, and pr-gate gates maintainers'
 * pull requests there too so the operator can open scenarios themselves. Crons run only the real ones.
 */
export interface RepoInstance {
  repo: string;
  sandbox: boolean;
}

export const OWASP_INSTANCE = 'owasp-cheatsheetseries';
export const SANDBOX_INSTANCE = 'custodes-sandbox';

export const INSTANCES: Readonly<Record<string, RepoInstance>> = {
  [OWASP_INSTANCE]: { repo: 'OWASP/CheatSheetSeries', sandbox: false },
  [SANDBOX_INSTANCE]: { repo: 'mackowski/custodes-sandbox', sandbox: true },
};

export const INSTANCE_REPOS: readonly string[] = Object.values(INSTANCES).map((i) => i.repo);

export class UnknownInstanceError extends Error {
  constructor(name: string) {
    super(`unknown agent instance ${name.slice(0, 60)}`);
    this.name = 'UnknownInstanceError';
  }
}

/** The repository binding for an instance name; throws for anything not listed. */
export function instanceOf(name: string): RepoInstance {
  const i = Object.hasOwn(INSTANCES, name) ? INSTANCES[name] : undefined;
  if (!i) throw new UnknownInstanceError(name);
  return i;
}

/** Response for a request routed to an instance that does not exist (no state is created). */
export function unknownInstance(): Response {
  return Response.json({ error: 'unknown instance' }, { status: 404 });
}
