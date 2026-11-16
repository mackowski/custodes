import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  accessTokenOf,
  clearAccessKeyCache,
  isApprover,
  toBase64Url,
  verifyAccessToken,
} from '../src/index.js';

const TEAM = 'custodes';
const AUD = 'aud-123';
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const ALG = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
} as const;

let pair: CryptoKeyPair;
let other: CryptoKeyPair;
let jwks: { keys: JsonWebKey[] };

const b64 = (o: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
async function mint(
  claims: Record<string, unknown>,
  over: { kid?: string; alg?: string; key?: CryptoKey } = {},
): Promise<string> {
  const head = b64({ alg: over.alg ?? 'RS256', kid: over.kid ?? 'k1', typ: 'JWT' });
  const body = b64({ iss: ISS, aud: [AUD], exp: NOW / 1000 + 600, iat: NOW / 1000, ...claims });
  const sig = await crypto.subtle.sign(
    ALG,
    over.key ?? pair.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${toBase64Url(new Uint8Array(sig))}`;
}

let fetches: string[] = [];
const opts = () => ({
  now: () => NOW,
  fetchImpl: (url: string) => {
    fetches.push(url);
    return Promise.resolve(Response.json(jwks));
  },
});

beforeAll(async () => {
  pair = (await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  other = (await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  jwks = { keys: [{ ...pub, kid: 'k1', alg: 'RS256' } as JsonWebKey] };
});
beforeEach(() => {
  clearAccessKeyCache();
  fetches = [];
});

describe('Access JWT (#104: verified by the gateway and again by the broker)', () => {
  it('returns the person or the service token behind a valid token', async () => {
    expect(
      await verifyAccessToken(await mint({ email: 'op@example.com' }), TEAM, AUD, opts()),
    ).toEqual({ subject: 'op@example.com', via: 'access-user' });
    expect(
      await verifyAccessToken(await mint({ common_name: 'abc.access' }), TEAM, AUD, opts()),
    ).toEqual({ subject: 'service:abc.access', via: 'access-service-token' });
    expect(fetches).toEqual([`${ISS}/cdn-cgi/access/certs`]); // cached after the first fetch
  });

  it('refuses a wrong audience, issuer, expired or not-yet-valid token', async () => {
    const o = opts();
    for (const claims of [
      { email: 'op@example.com', aud: ['someone-else'] },
      { email: 'op@example.com', iss: 'https://evil.cloudflareaccess.com' },
      { email: 'op@example.com', exp: NOW / 1000 - 120 },
      { email: 'op@example.com', nbf: NOW / 1000 + 120 },
      { email: 'op@example.com', exp: 'never' },
      { aud: [AUD] }, // no identity
    ])
      expect(
        await verifyAccessToken(await mint(claims), TEAM, AUD, o),
        JSON.stringify(claims),
      ).toBe(null);
  });

  it('refuses a token signed by another key, another algorithm, an unknown kid or garbage', async () => {
    const o = opts();
    expect(
      await verifyAccessToken(
        await mint({ email: 'op@example.com' }, { key: other.privateKey }),
        TEAM,
        AUD,
        o,
      ),
    ).toBe(null);
    expect(
      await verifyAccessToken(
        await mint({ email: 'op@example.com' }, { alg: 'HS256' }),
        TEAM,
        AUD,
        o,
      ),
    ).toBe(null);
    const none = `${b64({ alg: 'none', kid: 'k1' })}.${b64({ email: 'op@example.com', iss: ISS, aud: AUD, exp: NOW / 1000 + 60 })}.`;
    expect(await verifyAccessToken(none, TEAM, AUD, o)).toBe(null);
    expect(
      await verifyAccessToken(await mint({ email: 'op@example.com' }, { kid: 'k9' }), TEAM, AUD, o),
    ).toBe(null);
    for (const bad of ['', 'a.b', 'a.b.c', '%%%.%%%.%%%'])
      expect(await verifyAccessToken(bad, TEAM, AUD, o)).toBe(null);
  });

  it('never fetches keys for a team name that is not a plain DNS label', async () => {
    const o = opts();
    const t = await mint({ email: 'op@example.com' });
    for (const team of ['evil.example/x', 'a@b', '', 'UPPER'])
      expect(await verifyAccessToken(t, team, AUD, o)).toBe(null);
    expect(fetches).toEqual([]);
  });

  it('reads the token from either header, and decides approvers from people only', () => {
    expect(
      accessTokenOf(new Request('https://x', { headers: { 'cf-access-jwt-assertion': 'a' } })),
    ).toBe('a');
    expect(accessTokenOf(new Request('https://x', { headers: { 'cf-access-token': 'b' } }))).toBe(
      'b',
    );
    expect(accessTokenOf(new Request('https://x'))).toBe(null);
    const list = 'Op@Example.com, second@example.com';
    expect(isApprover({ subject: 'op@example.com', via: 'access-user' }, list)).toBe(true);
    expect(isApprover({ subject: 'op@example.com', via: 'access-service-token' }, list)).toBe(
      false,
    );
    expect(isApprover({ subject: 'mallory@example.com', via: 'access-user' }, list)).toBe(false);
  });
});
