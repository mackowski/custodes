import type { Ed25519Jwk } from './attestation.js';
import { importPrivateKey } from './attestation.js';
import { signRequest, type SignedPart } from './request-signature.js';

/**
 * The key logic behind each agent Worker's `Keyholder` Durable Object (ADR 0018). Each agent Worker has one instance (named
 * `default`) and is the only one that binds it, so no other Worker can sign as this one. The
 * private key is generated here, stored only in this object's storage, and never returned by any
 * method: callers get signatures and public keys, nothing else.
 *
 * Rotation keeps the agent working: `rotate()` creates a `next` key whose public half the operator
 * pins next to the active one; `activateNext()` (after the pin is merged) switches to it and deletes
 * the old private key. Only a lost key stops the agent, until a new one is pinned.
 */

interface StoredKey {
  kid: string;
  x: string;
  /** Private scalar (JWK `d`). Never leaves this object. */
  d: string;
  createdAt: string;
}

interface KeyState {
  active?: StoredKey;
  next?: StoredKey;
}

export interface PublicKeyInfo {
  kid: string;
  x: string;
  state: 'active' | 'next';
  createdAt: string;
}

/** The storage this class needs; a Map-backed fake satisfies it in tests. */
export interface KeyStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

const STATE_KEY = 'keys';

/** `custodes-pr-gate` → `pr-gate-20261109-a1b2c3d4`: the kid format agent-keys.json expects. */
export function newKid(callerName: string, now: Date): string {
  const name = callerName.replace(/^custodes-/, '');
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${name}-${day}-${crypto.randomUUID().slice(0, 8)}`;
}

async function generate(callerName: string, now: Date): Promise<StoredKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as Ed25519Jwk;
  if (!jwk.d) throw new Error('key generation returned no private scalar');
  return { kid: newKid(callerName, now), x: jwk.x, d: jwk.d, createdAt: now.toISOString() };
}

const publicOf = (k: StoredKey, state: PublicKeyInfo['state']): PublicKeyInfo => ({
  kid: k.kid,
  x: k.x,
  state,
  createdAt: k.createdAt,
});

/** The key logic, separate from the Durable Object so it can be tested with a fake storage. */
export class KeyStore {
  constructor(
    private readonly storage: KeyStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async state(): Promise<KeyState> {
    return (await this.storage.get<KeyState>(STATE_KEY)) ?? {};
  }

  /** Signature headers for one broker request, with the active key (created on first use). */
  async signRequest(callerName: string, part: SignedPart): Promise<Record<string, string>> {
    const state = await this.state();
    let active = state.active;
    if (!active) {
      active = await generate(callerName, this.now());
      await this.storage.put(STATE_KEY, { ...state, active });
    }
    const priv = await importPrivateKey({ kty: 'OKP', crv: 'Ed25519', x: active.x, d: active.d });
    return signRequest(priv, active.kid, part, this.now().getTime());
  }

  /** Public halves only, for pinning and for the operator's key page. */
  async publicKeys(): Promise<PublicKeyInfo[]> {
    const { active, next } = await this.state();
    return [
      ...(active ? [publicOf(active, 'active')] : []),
      ...(next ? [publicOf(next, 'next')] : []),
    ];
  }

  /** Creates the next key (or returns the pending one). The active key keeps signing. */
  async rotate(callerName: string): Promise<PublicKeyInfo> {
    const state = await this.state();
    if (state.next) return publicOf(state.next, 'next');
    const next = await generate(callerName, this.now());
    await this.storage.put(STATE_KEY, { ...state, next });
    return publicOf(next, 'next');
  }

  /** Switches to the next key and deletes the old private key. Call once the next key is pinned. */
  async activateNext(): Promise<PublicKeyInfo> {
    const { next } = await this.state();
    if (!next) throw new Error('no next key to activate');
    await this.storage.put(STATE_KEY, { active: next });
    return publicOf(next, 'active');
  }
}
