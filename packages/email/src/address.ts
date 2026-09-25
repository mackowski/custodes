/** Reply-to addresses encode a single-use approval token: approve+<token>@<domain>. */
export function approvalReplyAddress(
  token: string,
  domain: string,
  verb: 'approve' | 'reject' = 'approve',
): string {
  return `${verb}+${token}@${domain}`;
}

export function parseApprovalAddress(
  address: string,
): { verb: 'approve' | 'reject'; token: string } | null {
  const m = /^(approve|reject)\+([A-Za-z0-9_.-]+)@/.exec(
    address.trim().toLowerCase().replace(/^.*</, '').replace(/>.*$/, ''),
  );
  if (!m) return null;
  const [, verb, token] = m;
  if (!token || (verb !== 'approve' && verb !== 'reject')) return null;
  return { verb, token };
}
