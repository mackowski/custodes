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
