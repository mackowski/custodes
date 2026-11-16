import type { AdminActor } from '@custodes/schema';
import { fromBase64Url } from './canonical.js';

/**
 * Cloudflare Access JWTs, verified with WebCrypto (RS256) against the team's published keys. Used
 * by the gateway (every Access-protected route) and by the broker, which re-checks the operator's
 * own token on every admin write instead of trusting the gateway (#104). No third-party JWT
 * library: one less dependency in the two Workers that hold approval authority (#105).
 */

export interface AccessJwtOptions {
  /** Fetches the team's keys (`/cdn-cgi/access/certs`); injected in tests. */
  fetchImpl?: (url: string) => Promise<Response>;
  /** Milliseconds since the epoch; injected in tests. */
  now?: () => number;
}

/** Clock skew tolerated on `exp` and `nbf`. */
const SKEW_S = 30;
/** How long fetched keys are reused before they are fetched again. */
const KEYS_TTL_MS = 10 * 60_000;
/** At most one fetch per issuer this often, so unknown kids cannot make every request fetch. */
const MIN_REFETCH_MS = 60_000;
/** Cached keys are not used past this age, even when fetching fails (fail closed). */
const KEYS_MAX_AGE_MS = 60 * 60_000;
const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const keyCache = new Map<string, { at: number; keys: Map<string, CryptoKey> }>();
const lastFetch = new Map<string, number>();
const inflight = new Map<string, Promise<Map<string, CryptoKey> | null>>();

/** The token Access injects (`Cf-Access-Jwt-Assertion`) or a CLI sends (`cf-access-token`). */
export function accessTokenOf(req: Request): string | null {
  return req.headers.get('cf-access-jwt-assertion') ?? req.headers.get('cf-access-token');
}

/** Only a person on the approver list decides: not a service token, not any other Access user. */
export function isApprover(actor: AdminActor, approverEmails: string): boolean {
  if (actor.via !== 'access-user') return false;
  const list = approverEmails
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(actor.subject.toLowerCase());
}

/**
 * The verified identity in an Access JWT, or null. Checks the RS256 signature with the team's key
 * named by `kid`, the issuer, the audience, `exp` and `nbf`. Any other algorithm is refused.
 */
export async function verifyAccessToken(
  token: string,
  team: string,
  aud: string,
  opts: AccessJwtOptions = {},
): Promise<AdminActor | null> {
  // The team name builds a URL we fetch: a plain DNS label only.
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(team) || aud === '') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h = '', p = '', s = ''] = parts;
  let rawHeader: unknown;
  let rawClaims: unknown;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    rawHeader = JSON.parse(new TextDecoder().decode(fromBase64Url(h)));
    rawClaims = JSON.parse(new TextDecoder().decode(fromBase64Url(p)));
    signature = fromBase64Url(s);
  } catch {
    return null;
  }
  // `null` or a non-object decodes fine as JSON: refuse it here, not with a TypeError (review L1).
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(rawHeader) || !isObject(rawClaims)) return null;
  const alg = rawHeader['alg'];
  const kid = rawHeader['kid'];
  const claims = rawClaims;
  if (alg !== 'RS256' || typeof kid !== 'string') return null;
  const issuer = `https://${team}.cloudflareaccess.com`;
  const now = (opts.now ?? Date.now)();
  const key = await keyFor(issuer, kid, now, opts.fetchImpl);
  if (!key) return null;
  const ok = await crypto.subtle.verify(ALG, key, signature, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  if (claims['iss'] !== issuer) return null;
  const audience = claims['aud'];
  if (!(audience === aud || (Array.isArray(audience) && audience.includes(aud)))) return null;
  const seconds = now / 1000;
  if (typeof claims['exp'] !== 'number' || claims['exp'] + SKEW_S < seconds) return null;
  if (typeof claims['nbf'] === 'number' && claims['nbf'] - SKEW_S > seconds) return null;
  if (typeof claims['email'] === 'string' && claims['email'] !== '')
    return { subject: claims['email'], via: 'access-user' };
  if (typeof claims['common_name'] === 'string' && claims['common_name'] !== '')
    return { subject: `service:${claims['common_name']}`, via: 'access-service-token' };
  return null;
}

/**
 * The team's key for `kid`. Concurrent callers share one fetch (a request arriving while the keys
 * are being fetched waits for them instead of failing); a new fetch for an unknown kid happens at
 * most once a minute while keys are held, and held keys are not used past KEYS_MAX_AGE_MS.
 */
async function keyFor(
  issuer: string,
  kid: string,
  now: number,
  fetchImpl: AccessJwtOptions['fetchImpl'],
): Promise<CryptoKey | undefined> {
  const cached = keyCache.get(issuer);
  if (cached !== undefined && now - cached.at < KEYS_TTL_MS && cached.keys.has(kid))
    return cached.keys.get(kid);
  const usable = () =>
    cached !== undefined && now - cached.at < KEYS_MAX_AGE_MS ? cached.keys.get(kid) : undefined;
  let pending = inflight.get(issuer);
  if (pending === undefined) {
    // Throttle only while keys are held: with none, every request may try (no lock-out).
    if (cached !== undefined && now - (lastFetch.get(issuer) ?? -Infinity) < MIN_REFETCH_MS)
      return usable();
    lastFetch.set(issuer, now);
    pending = fetchKeys(issuer, fetchImpl)
      .catch(() => null)
      .finally(() => inflight.delete(issuer));
    inflight.set(issuer, pending);
  }
  const keys = await pending;
  if (keys === null) return usable();
  keyCache.set(issuer, { at: now, keys });
  return keys.get(kid);
}

async function fetchKeys(
  issuer: string,
  fetchImpl: AccessJwtOptions['fetchImpl'],
): Promise<Map<string, CryptoKey>> {
  const url = `${issuer}/cdn-cgi/access/certs`;
  const res = await (fetchImpl ?? ((u: string) => fetch(u)))(url);
  if (!res.ok) throw new Error(`access keys: HTTP ${res.status}`);
  // Typed by hand, so it reads the same under Workers and Node types (the CLI typechecks core too).
  const body: unknown = await res.json();
  const keys: unknown =
    typeof body === 'object' && body !== null ? (Reflect.get(body, 'keys') as unknown) : undefined;
  const out = new Map<string, CryptoKey>();
  for (const k of Array.isArray(keys) ? (keys as unknown[]) : []) {
    const jwk = k as JsonWebKey & { kid?: unknown };
    if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.n || !jwk.e) continue;
    out.set(
      jwk.kid,
      await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        ALG,
        false,
        ['verify'],
      ),
    );
  }
  return out;
}

/** Tests only: forget the cached keys. */
export function clearAccessKeyCache(): void {
  keyCache.clear();
  lastFetch.clear();
  inflight.clear();
}
