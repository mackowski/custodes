import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { KeyStore, type PublicKeyInfo } from './key-store.js';
import { CALLER_AGENTS, CallerName } from '@custodes/schema';
import { canonicalJson } from './canonical.js';
import type { SignedPart } from './request-signature.js';

/** What the Keyholder needs from its Worker's env. */
export interface KeyholderEnv {
  CALLER_NAME: string;
  BROKER: Fetcher;
}

export type { PublicKeyInfo } from './key-store.js';

/**
 * Holds one agent Worker's signing key (ADR 0018); see `KeyStore` for the rules. Each agent Worker
 * exports this class, binds it as `KEYHOLDER` and is the only Worker that does, so no other Worker
 * can sign as it. No method returns the private key; the methods are exactly signRequest,
 * publicKeys, rotate and activateNextIfAccepted (pinned by a test).
 */

/** The Durable Object each agent Worker exports and binds as `KEYHOLDER`. */
export class Keyholder extends DurableObject<KeyholderEnv> {
  private readonly keys: KeyStore;

  constructor(ctx: DurableObjectState, env: KeyholderEnv) {
    super(ctx, env);
    // Its own name, from its own Worker's config: no caller can make it mint another Worker's kid.
    const name = CallerName.parse(env.CALLER_NAME);
    this.keys = new KeyStore(ctx.storage, name, undefined, (fn) => ctx.blockConcurrencyWhile(fn));
  }

  signRequest(part: SignedPart): Promise<Record<string, string>> {
    return this.keys.signRequest(part);
  }

  publicKeys(): Promise<PublicKeyInfo[]> {
    return this.keys.publicKeys();
  }

  rotate(): Promise<PublicKeyInfo> {
    return this.keys.rotate();
  }

  /** Called by the agent on each run: switches to the next key once the broker accepts it. */
  activateNextIfAccepted(): Promise<boolean> {
    return this.keys.activateNextIfAccepted(async (sign) => {
      const body = canonicalJson({
        agentId: CALLER_AGENTS[CallerName.parse(this.env.CALLER_NAME)][0],
      });
      const headers = await sign({ method: 'POST', path: '/v1/state', body });
      const res = await this.env.BROKER.fetch('https://broker.internal/v1/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
      return res.status === 200;
    });
  }
}

/** What KeyAdmin needs from its Worker's env. */
export interface KeyAdminEnv extends KeyholderEnv {
  KEYHOLDER: DurableObjectNamespace<Keyholder>;
}

/**
 * The operator's view of a Worker's key (ADR 0018): public keys and Rotate, nothing else. Bound only
 * by the gateway, behind Access, for `/admin/agent-keys` (bindings.test pins that). It never returns
 * key material and cannot activate a key: activation happens only once the broker accepts it.
 */
export class KeyAdmin extends WorkerEntrypoint<KeyAdminEnv> {
  // No getters or helper methods on this class: Workers RPC exposes everything on the prototype,
  // getters included, whatever TypeScript says about `private`. A `keyholder` getter here would hand
  // the gateway the Keyholder stub, and with it signRequest (found in review on #106).
  publicKeys(): Promise<PublicKeyInfo[]> {
    return keyholderOf(this.env).publicKeys();
  }

  rotate(): Promise<PublicKeyInfo> {
    return keyholderOf(this.env).rotate();
  }
}

/** Module-level on purpose: not reachable over RPC (see KeyAdmin). */
function keyholderOf(env: KeyAdminEnv): DurableObjectStub<Keyholder> {
  return env.KEYHOLDER.get(env.KEYHOLDER.idFromName('default'));
}
