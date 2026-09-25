import { fromBase64Url, timingSafeEqual, toBase64Url } from './canonical.js';

/**
 * Approval tokens are what a human sends back (email reply address, link, CLI) to approve one
 * specific approval request. They are HMAC-bound to the approval id, expire, and must be
 * single-use: callers persist consumed ids (see ApprovalStore in workers/agents).
 *
 * Format: base64url(approvalId).exp.base64url(hmac)
 */
const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function mintApprovalToken(
  approvalId: string,
  secret: string,
  ttlSeconds: number,
  now = new Date(),
): Promise<string> {
  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const payload = `${toBase64Url(enc.encode(approvalId))}.${exp}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)),
  );
  return `${payload}.${toBase64Url(sig)}`;
}

export type ApprovalTokenResult =
  | { ok: true; approvalId: string; exp: number }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad_signature' };

export async function verifyApprovalToken(
  token: string,
  secret: string,
  now = new Date(),
): Promise<ApprovalTokenResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [idPart, expPart, sigPart] = parts as [string, string, string];
  const exp = Number(expPart);
  if (!Number.isInteger(exp)) return { ok: false, reason: 'malformed' };
  const payload = `${idPart}.${expPart}`;
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)),
  );
  let given: Uint8Array<ArrayBuffer>;
  try {
    given = fromBase64Url(sigPart);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_signature' };
  if (Math.floor(now.getTime() / 1000) > exp) return { ok: false, reason: 'expired' };
  return { ok: true, approvalId: new TextDecoder().decode(fromBase64Url(idPart)), exp };
}
