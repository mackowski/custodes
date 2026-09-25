import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AdminActor } from '@custodes/schema';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Validates the Cloudflare Access JWT that Access injects (`Cf-Access-Jwt-Assertion`) or that a
 * CLI sends (`cf-access-token`). Defence in depth: even though Access already sits in front of
 * the route, we verify the token ourselves so a misconfigured route cannot expose the admin API.
 */
export async function verifyAccessJwt(
  req: Request,
  team: string,
  aud: string,
): Promise<AdminActor | null> {
  const token = req.headers.get('cf-access-jwt-assertion') ?? req.headers.get('cf-access-token');
  if (!token) return null;
  const issuer = `https://${team}.cloudflareaccess.com`;
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksCache.set(issuer, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: aud });
    return actorFrom(payload);
  } catch {
    return null;
  }
}

function actorFrom(p: JWTPayload & { email?: string; common_name?: string }): AdminActor | null {
  if (typeof p.email === 'string') return { subject: p.email, via: 'access-user' };
  if (typeof p.common_name === 'string')
    return { subject: `service:${p.common_name}`, via: 'access-service-token' };
  return null;
}
