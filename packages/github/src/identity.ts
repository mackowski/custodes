/**
 * How an agent is represented on GitHub. Today: one fine-grained PAT per agent, held by the
 * broker in Secrets Store. Tomorrow: a GitHub App installation token per agent. Code that
 * executes actions only sees this interface, so the swap is configuration.
 */
export interface GitHubIdentity {
  readonly kind: 'pat' | 'app';
  readonly agentId: string;
  /** Returns a bearer token valid for at least the next request. Never log it. */
  token(): Promise<string>;
}

/** Minimal shape of a Secrets Store binding (`env.X.get()`). */
export interface SecretBinding {
  get(): Promise<string>;
}

export class PatIdentity implements GitHubIdentity {
  readonly kind = 'pat' as const;
  constructor(
    readonly agentId: string,
    private readonly binding: SecretBinding,
  ) {}
  token(): Promise<string> {
    return this.binding.get();
  }
}

/** Placeholder for the GitHub App path; see docs/architecture/adr/0003-per-agent-pat-with-attestation.md */
export class AppInstallationIdentity implements GitHubIdentity {
  readonly kind = 'app' as const;
  constructor(readonly agentId: string) {}
  token(): Promise<string> {
    return Promise.reject(new Error('GitHub App identity not implemented yet'));
  }
}
