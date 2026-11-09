import {
  type CallerSignature,
  isWeakEd25519PublicKey,
  type PinnedAgentKey,
} from '@custodes/schema';
import { fromBase64Url, sha256Hex, toBase64Url } from './canonical.js';

/**
 * Agent-signed broker requests (ADR 0018). The agent's Worker signs every call to the broker with
 * a key only that Worker holds; the broker verifies it against the public keys pinned in
 * `agent-keys.json` for the calling entrypoint. The signature covers the audience, the method, the
 * path, a timestamp, a nonce and the SHA-256 of the exact body, so a signed body cannot be replayed,
 * sent to another endpoint, or altered.
 */
export const BROKER_AUDIENCE = 'custodes-github-broker';
export const SIGNATURE_VERSION = 'custodes-request-v1';
/** How far a request's timestamp may be from the broker's clock, either way. */
export const SIGNATURE_WINDOW_MS = 5 * 60_000;

export const SIGNATURE_HEADERS = {
  keyId: 'x-custodes-key-id',
  signature: 'x-custodes-signature',
  timestamp: 'x-custodes-timestamp',
  nonce: 'x-custodes-nonce',
} as const;

const ALG = { name: 'Ed25519' } as const;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{13}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export interface SignedPart {
  method: string;
  /** URL path only, e.g. `/v1/act`. The host is not signed: it is internal to the binding. */
  path: string;
  /** The exact request body as sent. */
  body: string;
}

/** The bytes both sides sign and verify. One field per line; none of them can contain `\n`. */
export async function signingInput(
  part: SignedPart,
  timestamp: string,
  nonce: string,
): Promise<string> {
  return signingInputFromHash(part.method, part.path, timestamp, nonce, await sha256Hex(part.body));
}

/** The same bytes, from a stored body hash: what `/verify` uses for an audit record. */
export function signingInputFromHash(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodySha256: string,
): string {
  return [
    SIGNATURE_VERSION,
    BROKER_AUDIENCE,
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    bodySha256,
  ].join('\n');
}

/** Headers for one signed request. `now` and `nonce` are injectable for tests. */
export async function signRequest(
  privateKey: CryptoKey,
  keyId: string,
  part: SignedPart,
  now: number = Date.now(),
  nonce: string = crypto.randomUUID(),
): Promise<Record<string, string>> {
  const timestamp = String(now);
  const data = new TextEncoder().encode(await signingInput(part, timestamp, nonce));
  const sig = new Uint8Array(await crypto.subtle.sign(ALG, privateKey, data));
  return {
    [SIGNATURE_HEADERS.keyId]: keyId,
    [SIGNATURE_HEADERS.signature]: toBase64Url(sig),
    [SIGNATURE_HEADERS.timestamp]: timestamp,
    [SIGNATURE_HEADERS.nonce]: nonce,
  };
}

export type SignatureCheck =
  | {
      ok: true;
      keyId: string;
      nonce: string;
      signature: string;
      timestamp: string;
      bodySha256: string;
    }
  | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'unknown_key' | 'bad_signature' };

/**
 * Verifies a request against the keys pinned for its caller. Does not check the nonce for reuse:
 * that needs storage, so the broker does it after this returns ok.
 */
export async function verifyRequestSignature(
  pinned: readonly PinnedAgentKey[],
  headers: Headers,
  part: SignedPart,
  now: number = Date.now(),
): Promise<SignatureCheck> {
  const keyId = headers.get(SIGNATURE_HEADERS.keyId);
  const signature = headers.get(SIGNATURE_HEADERS.signature);
  const timestamp = headers.get(SIGNATURE_HEADERS.timestamp);
  const nonce = headers.get(SIGNATURE_HEADERS.nonce);
  if (keyId === null || signature === null || timestamp === null || nonce === null)
    return { ok: false, reason: 'missing' };
  if (!TIMESTAMP.test(timestamp) || !NONCE.test(nonce) || !SIGNATURE.test(signature))
    return { ok: false, reason: 'malformed' };
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_WINDOW_MS)
    return { ok: false, reason: 'stale' };
  const key = pinned.find((k) => k.kid === keyId);
  // The schema refuses weak keys already; checked again so a key built in code cannot slip by.
  if (!key || isWeakEd25519PublicKey(key.x)) return { ok: false, reason: 'unknown_key' };
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: key.x },
    ALG,
    false,
    ['verify'],
  );
  const bodySha256 = await sha256Hex(part.body);
  const data = new TextEncoder().encode(
    signingInputFromHash(part.method, part.path, timestamp, nonce, bodySha256),
  );
  const valid = await crypto.subtle.verify(ALG, publicKey, fromBase64Url(signature), data);
  return valid
    ? { ok: true, keyId, nonce, signature, timestamp, bodySha256 }
    : { ok: false, reason: 'bad_signature' };
}

/**
 * Checks an agent signature stored in an audit record (no time window: the record is history).
 * Proves the agent Worker signed a request with `bodySha256` at that time and path; the caller of
 * this function must also check that `bodySha256` matches the record's request.
 */
export async function verifyRecordedCallerSignature(
  pinned: readonly PinnedAgentKey[],
  sig: CallerSignature,
): Promise<boolean> {
  const key = pinned.find((k) => k.kid === sig.kid);
  if (!key || isWeakEd25519PublicKey(key.x)) return false;
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: key.x },
    ALG,
    false,
    ['verify'],
  );
  const data = new TextEncoder().encode(
    signingInputFromHash(sig.method, sig.path, sig.timestamp, sig.nonce, sig.bodySha256),
  );
  return crypto.subtle.verify(ALG, publicKey, fromBase64Url(sig.signature), data);
}
