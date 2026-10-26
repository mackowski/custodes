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

/**
 * CSRF guard for Access-protected routes. Browsers attach the Access cookie (and Access then adds
 * the JWT) to cross-site requests too, so a page the operator visits could POST here. Browsers send
 * Sec-Fetch-Site; the CLI, service tokens and scripts do not, so they are unaffected.
 */
export function crossSiteWrite(req: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
  const site = req.headers.get('sec-fetch-site');
  return site !== null && site !== 'same-origin' && site !== 'none';
}

/**
 * The Access service token (CI: sandbox scenarios) may read the admin API but never change it:
 * no approvals, no halting or resuming agents, no key rotation. Those stay with a person.
 */
export function adminWriteAllowed(actor: AdminActor, method: string): boolean {
  return actor.via !== 'access-service-token' || ['GET', 'HEAD'].includes(method);
}

/**
 * On `/agents/*` a service token (CI sandbox scenarios) may read, and write only to the on-demand
 * steps (ADR 0012). Anything else, such as a Jev vs Clef verdict (ADR 0015), needs a person.
 */
export function agentWriteAllowed(actor: AdminActor, method: string, path: string): boolean {
  return adminWriteAllowed(actor, method) || /\/(run|digest|summary)$/.test(path);
}
