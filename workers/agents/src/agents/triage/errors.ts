/** Error text for digests and logs: class, HTTP status and provider error type only, never content. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'error';
  const e = err as Error & { status?: unknown; errorType?: unknown; reason?: unknown };
  const parts = [err.name];
  if (typeof e.status === 'number') parts.push(String(e.status));
  if (typeof e.errorType === 'string') parts.push(e.errorType);
  if (typeof e.reason === 'string') parts.push(e.reason);
  return parts.join(' ');
}

/**
 * Failures that are about one issue's content (model output unparseable, refused or cut off).
 * Everything else (gateway, GitHub, network, configuration) is infrastructure. One definition:
 * triage's counting and the specialists' job weights both depend on it.
 */
export function isInputSpecific(err: unknown): boolean {
  return err instanceof Error && ['StructuredOutputError', 'ModelOutputError'].includes(err.name);
}

/**
 * An HTTP error that answers this request and not the state of the path: a 4xx other than a
 * timeout or a rate limit (a guardrail block, a provider 400 on this text). A 429, a 5xx or a
 * timeout says nothing about the input: under load they hit whichever request comes next.
 */
export function isRequestRefused(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return (
    typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
}
