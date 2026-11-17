/**
 * How an agent is represented on GitHub: one fine-grained PAT per agent, held by the broker in
 * Secrets Store. Code that executes actions only sees this interface, so another kind of identity
 * (a GitHub App installation token, ADR 0003) would be a new implementation of it.
 */
export interface GitHubIdentity {
  readonly agentId: string;
  /** Returns a bearer token valid for at least the next request. Never log it. */
  token(): Promise<string>;
}

/** Minimal shape of a Secrets Store binding (`env.X.get()`). */
export interface SecretBinding {
  get(): Promise<string>;
}

export class PatIdentity implements GitHubIdentity {
  constructor(
    readonly agentId: string,
    private readonly binding: SecretBinding,
  ) {}
  token(): Promise<string> {
    return this.binding.get();
  }
}
