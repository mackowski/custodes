import { DurableObject } from 'cloudflare:workers';
import { KeyStore, type PublicKeyInfo } from './key-store.js';
import type { SignedPart } from './request-signature.js';

export type { PublicKeyInfo } from './key-store.js';

/**
 * Holds one agent Worker's signing key (ADR 0018); see `KeyStore` for the rules. Each agent Worker
 * exports this class, binds it as `KEYHOLDER` and is the only Worker that does, so no other Worker
 * can sign as it. No method returns the private key.
 */
/** The Durable Object each agent Worker exports and binds as `KEYHOLDER`. */
export class Keyholder extends DurableObject {
  private readonly keys = new KeyStore(this.ctx.storage);

  signRequest(callerName: string, part: SignedPart): Promise<Record<string, string>> {
    return this.keys.signRequest(callerName, part);
  }

  publicKeys(): Promise<PublicKeyInfo[]> {
    return this.keys.publicKeys();
  }

  rotate(callerName: string): Promise<PublicKeyInfo> {
    return this.keys.rotate(callerName);
  }

  activateNext(): Promise<PublicKeyInfo> {
    return this.keys.activateNext();
  }
}
