import type { SecretBinding } from '@custodes/github';
import type { Keyring } from './keyring.js';

/**
 * Generated bindings (wrangler types). The broker has no plain-text secrets: PATs are Secrets Store
 * bindings looked up by the name in the policy, and signing keys live inside the Keyring DO.
 */
export type BrokerEnv = Cloudflare.Env;

export function secretBinding(env: BrokerEnv, name: string): SecretBinding {
  const b = (env as unknown as Record<string, unknown>)[name];
  if (!b || typeof (b as SecretBinding).get !== 'function') {
    throw new Error(`missing Secrets Store binding ${name}`);
  }
  return b as SecretBinding;
}

/** The single keyring instance. */
export function keyring(env: BrokerEnv): DurableObjectStub<Keyring> {
  return env.KEYRING.get(env.KEYRING.idFromName('default'));
}
