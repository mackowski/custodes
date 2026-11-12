import { canonicalJson } from './canonical.js';
import type { SignedPart } from './request-signature.js';

/** What agents use to reach the broker: only `fetch`, like a service binding. */
export interface BrokerFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** The part of a `Keyholder` stub the client needs (no method returns key material). */
export interface RequestSigner {
  signRequest(part: SignedPart): Promise<Record<string, string>>;
}

/**
 * A broker binding that signs every request with the Worker's own key (ADR 0018). The body is sent
 * as canonical JSON: the broker requires it for `/v1/act`, so the audit record lets `/verify`
 * recompute exactly what was signed. Bodies that are not JSON are refused rather than sent unsigned.
 */
export function signingBroker(broker: BrokerFetcher, signer: RequestSigner): BrokerFetcher {
  return {
    async fetch(input: string, init: RequestInit = {}): Promise<Response> {
      if (typeof init.body !== 'string') throw new Error('signed broker calls need a JSON body');
      const body = canonicalJson(JSON.parse(init.body) as unknown);
      const method = (init.method ?? 'GET').toUpperCase();
      const path = new URL(input).pathname;
      const signature = await signer.signRequest({ method, path, body });
      const headers = new Headers(init.headers);
      for (const [k, v] of Object.entries(signature)) headers.set(k, v);
      return broker.fetch(input, { ...init, method, headers, body });
    },
  };
}
