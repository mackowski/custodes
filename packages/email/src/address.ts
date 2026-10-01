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
  // Take the part inside the last <...> with indexOf; regexes here were quadratic on hostile input.
  let a = address.trim().toLowerCase();
  const lt = a.lastIndexOf('<');
  if (lt >= 0) a = a.slice(lt + 1);
  const gt = a.indexOf('>');
  if (gt >= 0) a = a.slice(0, gt);
  const m = /^(approve|reject)\+([A-Za-z0-9_.-]+)@/.exec(a);
  if (!m) return null;
  const [, verb, token] = m;
  if (!token || (verb !== 'approve' && verb !== 'reject')) return null;
  return { verb, token };
}
