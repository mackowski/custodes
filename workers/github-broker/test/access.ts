import { env } from 'cloudflare:workers';
import { toBase64Url } from '@custodes/core';
import { accessOptions } from '../src/access-options.js';

/**
 * Test-only Cloudflare Access: a local RSA key the broker trusts through `accessOptions`, and
 * tokens minted with it for the admin writes the broker now verifies itself (#104).
 */
const ALG = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
} as const;
let pair: CryptoKeyPair | undefined;

/** The first approver in the broker's own config. */
export const APPROVER = (env.APPROVER_EMAILS.split(',')[0] ?? '').trim();

async function keyPair(): Promise<CryptoKeyPair> {
  if (pair) return pair;
  pair = (await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const jwks = { keys: [{ ...pub, kid: 'test-key', alg: 'RS256' }] };
  accessOptions.fetchImpl = () => Promise.resolve(Response.json(jwks));
  return pair;
}

const b64 = (o: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));

/** An Access token for `who`: an e-mail (a person) or `{ service }` (a service token). */
export async function accessToken(
  who: string | { service: string } = APPROVER,
  over: Record<string, unknown> = {},
): Promise<string> {
  const { privateKey } = await keyPair();
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
  const identity = typeof who === 'string' ? { email: who } : { common_name: who.service };
  const body = b64({
    iss: `https://${env.ACCESS_TEAM}.cloudflareaccess.com`,
    aud: [env.ACCESS_AUD],
    iat: now,
    exp: now + 600,
    ...identity,
    ...over,
  });
  const sig = await crypto.subtle.sign(
    ALG,
    privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${toBase64Url(new Uint8Array(sig))}`;
}

/** Headers for an admin write as `who` (the approver by default). */
export async function asOperator(
  who: string | { service: string } = APPROVER,
): Promise<Record<string, string>> {
  return {
    'content-type': 'application/json',
    'cf-access-jwt-assertion': await accessToken(who),
  };
}
