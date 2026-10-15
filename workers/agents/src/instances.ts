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

/** The hello smoke-test agent is not bound to a repository and keeps its single `default` instance. */
const UNBOUND: Readonly<Record<string, readonly string[]>> = { 'hello-agent': ['default'] };

/**
 * True when an `/agents/<class>/<instance>/...` path names an instance that may exist. Other paths
 * (not agent routes, or malformed) are left to the SDK router, which answers 404 for them.
 */
export function allowedAgentPath(pathname: string): boolean {
  const m = /^\/agents\/([^/]+)\/([^/]+)/.exec(pathname);
  if (!m) return true;
  const [, cls = '', rawInstance = ''] = m;
  let instance: string;
  try {
    instance = decodeURIComponent(rawInstance);
  } catch {
    return false;
  }
  const unbound = Object.hasOwn(UNBOUND, cls) ? UNBOUND[cls] : undefined;
  if (unbound) return unbound.includes(instance);
  return Object.hasOwn(INSTANCES, instance);
}
