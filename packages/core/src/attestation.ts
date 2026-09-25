import { Attestation, type AuditRecord, type PublicKeyEntry } from '@custodes/schema';
import { canonicalJson, fromBase64Url, toBase64Url } from './canonical.js';

export interface Ed25519Jwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  d?: string;
}

const ALG = { name: 'Ed25519' } as const;

/** Generates a new signing key pair for an agent. Run offline; store `privateJwk` in Secrets Store. */
export async function generateAgentKeyPair(): Promise<{
  publicJwk: Ed25519Jwk;
  privateJwk: Ed25519Jwk;
}> {
  const pair = (await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Ed25519Jwk;
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as Ed25519Jwk;
  return {
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x },
    privateJwk: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: privateJwk.x,
      ...(privateJwk.d ? { d: privateJwk.d } : {}),
    },
  };
}

export async function importPrivateKey(jwk: Ed25519Jwk): Promise<CryptoKey> {
  if (!jwk.d) throw new Error('private JWK required');
  return crypto.subtle.importKey('jwk', jwk, ALG, false, ['sign']);
}

export async function importPublicKey(jwk: Ed25519Jwk): Promise<CryptoKey> {
  const { kty, crv, x } = jwk;
  return crypto.subtle.importKey('jwk', { kty, crv, x }, ALG, true, ['verify']);
}

export async function signAuditRecord(
  record: AuditRecord,
  privateKey: CryptoKey,
  keyId: string,
): Promise<Attestation> {
  const data = new TextEncoder().encode(canonicalJson(record));
  const sig = new Uint8Array(await crypto.subtle.sign(ALG, privateKey, data));
  return { record, keyId, signature: toBase64Url(sig) };
}

export async function verifyAttestation(
  attestation: unknown,
  publicKey: CryptoKey,
): Promise<{ valid: boolean; reason?: string; attestation?: Attestation }> {
  const parsed = Attestation.safeParse(attestation);
  if (!parsed.success) return { valid: false, reason: 'malformed attestation' };
  const data = new TextEncoder().encode(canonicalJson(parsed.data.record));
  const ok = await crypto.subtle.verify(ALG, publicKey, fromBase64Url(parsed.data.signature), data);
  return ok ? { valid: true, attestation: parsed.data } : { valid: false, reason: 'bad signature' };
}

export function findKey(keys: PublicKeyEntry[], keyId: string): PublicKeyEntry | undefined {
  return keys.find((k) => k.keyId === keyId);
}
