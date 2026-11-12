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
  /**
   * cheatsheet-review (ADR 0017) runs when `actor` adds `label` to a pull request. Absent: the
   * agent never runs for this repository. The broker policy must list the repository too.
   */
  reviewTrigger?: { label: string; actor: string };
  /**
   * The GitHub account triage-apply's PAT posts as (ADR 0019): only its comments can be "our
   * question to the author" that starts the 2-day wait.
   */
  applyActor?: string;
}

/** The instance serving `repo`, if any. */
export function instanceForRepo(repo: string): RepoInstance | undefined {
  return Object.values(INSTANCES).find((i) => i.repo === repo);
}

export const OWASP_INSTANCE = 'owasp-cheatsheetseries';
export const SANDBOX_INSTANCE = 'custodes-sandbox';

export const INSTANCES: Readonly<Record<string, RepoInstance>> = {
  [OWASP_INSTANCE]: {
    repo: 'OWASP/CheatSheetSeries',
    sandbox: false,
    reviewTrigger: { label: 'custodes_cheatsheet_review', actor: 'mackowski' },
    applyActor: 'mackowski',
  },
  [SANDBOX_INSTANCE]: {
    repo: 'mackowski/custodes-sandbox',
    sandbox: true,
    reviewTrigger: { label: 'custodes_cheatsheet_review', actor: 'mackowski' },
    applyActor: 'mackowski',
  },
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

/** The agent classes the gateway may route to, as the Agents SDK names them (kebab-case). */
export const AGENT_CLASSES: ReadonlySet<string> = new Set([
  'triage-agent',
  'implementation-check-agent',
  'proposal-review-agent',
  'pr-gate-agent',
  'cheatsheet-review-agent',
]);

/**
 * True when an `/agents/<class>/<instance>/...` path names an instance that may exist. Other paths
 * (not agent routes, or malformed) are left to the SDK router, which answers 404 for them.
 */
export function allowedAgentPath(pathname: string): boolean {
  // Split exactly as the Agents SDK router does (empty segments dropped), so `/agents//x/y` cannot
  // reach a binding this check never looked at.
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'agents') return true;
  // Fewer than class + instance: the SDK router does not route it either.
  if (parts.length < 3) return true;
  const [, cls = '', rawInstance = ''] = parts;
  // The SDK router would reach any Durable Object binding by its kebab-cased name, including a
  // Worker's Keyholder (ADR 0018): only agent classes are routable.
  if (!AGENT_CLASSES.has(cls)) return false;
  let instance: string;
  try {
    instance = decodeURIComponent(rawInstance);
  } catch {
    return false;
  }
  return Object.hasOwn(INSTANCES, instance);
}
