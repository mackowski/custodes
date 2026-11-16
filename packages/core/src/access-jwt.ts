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
const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const keyCache = new Map<string, { at: number; keys: Map<string, CryptoKey> }>();

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
  let header: { alg?: unknown; kid?: unknown };
  let claims: Record<string, unknown>;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64Url(h))) as typeof header;
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(p))) as Record<string, unknown>;
    signature = fromBase64Url(s);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  const issuer = `https://${team}.cloudflareaccess.com`;
  const now = (opts.now ?? Date.now)();
  const key = await keyFor(issuer, header.kid, now, opts.fetchImpl);
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

/** The team's key for `kid`, from the cache or fetched (again once, for a key not seen yet). */
async function keyFor(
  issuer: string,
  kid: string,
  now: number,
  fetchImpl: AccessJwtOptions['fetchImpl'],
): Promise<CryptoKey | undefined> {
  const cached = keyCache.get(issuer);
  if (cached && now - cached.at < KEYS_TTL_MS && cached.keys.has(kid)) return cached.keys.get(kid);
  const keys = await fetchKeys(issuer, fetchImpl).catch(() => null);
  if (!keys) return cached?.keys.get(kid);
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
}
