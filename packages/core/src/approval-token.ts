import { fromBase64Url, timingSafeEqual, toBase64Url } from './canonical.js';

/**
 * Approval tokens go in the link the operator opens to approve one request (ADR 0017 amendment).
 * A token is an HMAC over the approval id, the agent, the hash of the exact action and an expiry,
 * so it approves that one action and nothing else, even for the same agent. The key is generated
 * and kept inside the broker's Keyring and is passed in here as a CryptoKey; nobody else holds it.
 * Single use comes from the approval store (`consume`), not from the token.
 *
 * Format: <approvalId>.<exp>.<base64url(hmac)>
 */
const enc = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a token is bound to. `actionHash` is sha256 of the canonical action (as in `act()`). */
export interface ApprovalBinding {
  approvalId: string;
  agentId: string;
  actionHash: string;
}

function payload(b: ApprovalBinding, exp: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    enc.encode(
      ['custodes-approval-v1', b.approvalId, b.agentId, b.actionHash, String(exp)].join('\n'),
    ),
  );
}

export async function mintApprovalToken(
  binding: ApprovalBinding,
  key: CryptoKey,
  ttlSeconds: number,
  now = new Date(),
): Promise<string> {
  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload(binding, exp)));
  return `${binding.approvalId}.${exp}.${toBase64Url(sig)}`;
}

/** Reads the approval id and expiry without checking anything, to look the approval up. */
export function parseApprovalToken(
  token: string,
): { ok: true; approvalId: string; exp: number } | { ok: false; reason: 'malformed' } {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [approvalId, expPart] = parts as [string, string, string];
  const exp = Number(expPart);
  if (!UUID.test(approvalId) || !/^\d{1,12}$/.test(expPart) || !Number.isInteger(exp))
    return { ok: false, reason: 'malformed' };
  return { ok: true, approvalId, exp };
}

export type ApprovalTokenResult =
  | { ok: true; approvalId: string; exp: number }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad_signature' };

/**
 * Checks a token against the approval it names: `binding` comes from the stored approval, never
 * from the request, so a token minted for another approval or action fails the signature.
 */
export async function verifyApprovalToken(
  token: string,
  binding: ApprovalBinding,
  key: CryptoKey,
  now = new Date(),
): Promise<ApprovalTokenResult> {
  const parsed = parseApprovalToken(token);
  if (!parsed.ok) return parsed;
  if (parsed.approvalId !== binding.approvalId) return { ok: false, reason: 'bad_signature' };
  let given: Uint8Array<ArrayBuffer>;
  try {
    given = fromBase64Url(token.split('.')[2] ?? '');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, payload(binding, parsed.exp)),
  );
  if (!timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_signature' };
  if (Math.floor(now.getTime() / 1000) > parsed.exp) return { ok: false, reason: 'expired' };
  return parsed;
}
