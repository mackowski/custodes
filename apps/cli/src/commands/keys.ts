import { Command } from 'commander';
import { z } from 'zod';
import { PublicKeyEntry } from '@custodes/schema';
import { ApiClient } from '../client.js';
import { loadConfig } from '../config.js';
import { print, rows } from '../output.js';

export function keysCommand(): Command {
  const cmd = new Command('keys').description(
    'attestation signing keys held by the broker (public halves)',
  );

  cmd
    .command('list')
    .description('list active and retired public keys')
    .action(async (_o, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      const keys = await new ApiClient(cfg).call('GET', '/admin/keys', z.array(PublicKeyEntry));
      print(cfg.json, keys, () =>
        rows(
          ['KEY ID', 'AGENT', 'CREATED', 'RETIRED'],
          keys.map((k) => [k.keyId, k.agentId, k.createdAt, k.retiredAt ?? '']),
        ),
      );
    });

  cmd
    .command('rotate <agent>')
    .description(
      "retire the agent's active key and generate a new one; old attestations stay verifiable",
    )
    .action(async (agent: string, _o, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      print(
        cfg.json,
        await new ApiClient(cfg).call(
          'POST',
          `/admin/keys/${encodeURIComponent(agent)}/rotate`,
          PublicKeyEntry,
        ),
      );
    });

  return cmd;
}
