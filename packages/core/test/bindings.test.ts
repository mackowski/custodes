import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Who may decide approvals and mint approval tokens is fixed by service bindings (ADR 0017
 * amendment): only the gateway binds the broker's `BrokerAdmin` entrypoint, and only the broker
 * itself binds its `Keyring`. A one-line wrangler change could undo that, so it is pinned here.
 */
interface Wrangler {
  services?: { binding: string; service: string; entrypoint?: string }[];
  durable_objects?: { bindings: { name: string; class_name: string; script_name?: string }[] };
}

/** wrangler.jsonc without comments or trailing commas. Enough for these files (no `//` in strings). */
function readWrangler(worker: string): Wrangler {
  const text = readFileSync(
    new URL(`../../../workers/${worker}/wrangler.jsonc`, import.meta.url),
    'utf8',
  );
  const json = text
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(json) as Wrangler;
}

const BROKER = 'custodes-github-broker';

describe('service bindings to the broker', () => {
  it('give the gateway, and only the gateway, the admin entrypoint', () => {
    const gateway = readWrangler('gateway').services?.find((s) => s.service === BROKER);
    expect(gateway?.entrypoint).toBe('BrokerAdmin');
    const agents = readWrangler('agents').services?.filter((s) => s.service === BROKER) ?? [];
    expect(agents).toHaveLength(1);
    expect(agents[0]?.entrypoint).toBeUndefined();
  });

  it('let no other Worker reach the Keyring that signs and mints approval tokens', () => {
    for (const worker of ['agents', 'gateway']) {
      const dos = readWrangler(worker).durable_objects?.bindings ?? [];
      expect(
        dos.filter((d) => d.class_name === 'Keyring' || d.script_name === BROKER),
        worker,
      ).toEqual([]);
    }
  });
});
