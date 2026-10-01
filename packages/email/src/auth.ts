export interface AuthResults {
  dkim: 'pass' | 'fail' | 'none';
  spf: 'pass' | 'fail' | 'none';
  dmarc: 'pass' | 'fail' | 'none';
}

/** Parses an RFC 8601 `Authentication-Results` header as Cloudflare Email Routing sets it. */
export function parseAuthenticationResults(header: string | null | undefined): AuthResults {
  const out: AuthResults = { dkim: 'none', spf: 'none', dmarc: 'none' };
  if (!header) return out;
  for (const key of ['dkim', 'spf', 'dmarc'] as const) {
    const m = new RegExp(
      `\\b${key}=(pass|fail|none|softfail|neutral|temperror|permerror)`,
      'i',
    ).exec(header);
    const v = m?.[1]?.toLowerCase();
    if (v) out[key] = v === 'pass' ? 'pass' : v === 'none' ? 'none' : 'fail';
  }
  return out;
}

export function extractAddress(from: string): string {
  // indexOf, not a regex: the From header is attacker-controlled.
  const open = from.indexOf('<');
  const close = open < 0 ? -1 : from.indexOf('>', open + 1);
  const inner = close > open + 1 ? from.slice(open + 1, close) : from;
  return inner.trim().toLowerCase();
}

/**
 * Inbound mail can drive approvals, so we require: sender on the allow-list AND DMARC pass
 * (or DKIM pass when DMARC is absent). Everything else is dropped and logged.
 */
export function isTrustedSender(
  from: string,
  authHeader: string | null | undefined,
  allowlist: readonly string[],
): { trusted: boolean; reason: string } {
  const addr = extractAddress(from);
  if (!allowlist.map((a) => a.toLowerCase()).includes(addr)) {
    return { trusted: false, reason: 'sender not allow-listed' };
  }
  const auth = parseAuthenticationResults(authHeader);
  if (auth.dmarc === 'pass') return { trusted: true, reason: 'dmarc pass' };
  if (auth.dmarc === 'none' && auth.dkim === 'pass') return { trusted: true, reason: 'dkim pass' };
  return {
    trusted: false,
    reason: `authentication failed (dkim=${auth.dkim} spf=${auth.spf} dmarc=${auth.dmarc})`,
  };
}
