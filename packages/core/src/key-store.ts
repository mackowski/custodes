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

/** Runs `fn` with no other request interleaved (the DO's `blockConcurrencyWhile`). */
export type Serialize = <T>(fn: () => Promise<T>) => Promise<T>;
const inline: Serialize = (fn) => fn();

/**
 * Asks the broker whether it accepts a request signed with the given headers (a signed
 * `POST /v1/state`); true only on 200.
 */
export type AcceptanceProbe = (
  sign: (part: SignedPart) => Promise<Record<string, string>>,
) => Promise<boolean>;

/** The key logic, separate from the Durable Object so it can be tested with a fake storage. */
export class KeyStore {
  constructor(
    private readonly storage: KeyStorage,
    /** The Worker's caller name (`custodes-pr-gate`): shapes new kids only. */
    private readonly callerName: string,
    private readonly now: () => Date = () => new Date(),
    /** Key generation is read, generate, write: kept atomic so two calls cannot make two keys. */
    private readonly serialize: Serialize = inline,
  ) {}

  private async state(): Promise<KeyState> {
    return (await this.storage.get<KeyState>(STATE_KEY)) ?? {};
  }

  private async sign(key: StoredKey, part: SignedPart): Promise<Record<string, string>> {
    const priv = await importPrivateKey({ kty: 'OKP', crv: 'Ed25519', x: key.x, d: key.d });
    return signRequest(priv, key.kid, part, this.now().getTime());
  }

  /** Signature headers for one broker request, with the active key (created on first use). */
  async signRequest(part: SignedPart): Promise<Record<string, string>> {
    const active =
      (await this.state()).active ??
      (await this.serialize(async () => {
        const state = await this.state();
        if (state.active) return state.active;
        const created = await generate(this.callerName, this.now());
        await this.storage.put(STATE_KEY, { ...state, active: created });
        return created;
      }));
    return this.sign(active, part);
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
  async rotate(): Promise<PublicKeyInfo> {
    return this.serialize(async () => {
      const state = await this.state();
      if (state.next) return publicOf(state.next, 'next');
      const next = await generate(this.callerName, this.now());
      await this.storage.put(STATE_KEY, { ...state, next });
      return publicOf(next, 'next');
    });
  }

  /**
   * Switches to the next key only once the broker accepts it (threat D1): the agent never stops
   * because a key was activated before it was pinned. Then the old private key is deleted from
   * storage (a point-in-time restore of the object could still bring it back: a compromised key is
   * removed from agent-keys.json, not only rotated out). Returns whether it switched.
   */
  async activateNextIfAccepted(probe: AcceptanceProbe): Promise<boolean> {
    const { next } = await this.state();
    if (!next) return false;
    if (!(await probe((part) => this.sign(next, part)))) return false;
    return this.serialize(async () => {
      const state = await this.state();
      if (state.next?.kid !== next.kid) return false;
      await this.storage.put(STATE_KEY, { active: next });
      return true;
    });
  }
}
