import { Command } from 'commander';
import { z } from 'zod';
import { verifyRecord } from '@custodes/core';
import { Attestation, PublicKeyEntry } from '@custodes/schema';
import { ApiClient } from '../client.js';
import { loadConfig } from '../config.js';
import { print, rows } from '../output.js';

export function auditCommand(): Command {
  const cmd = new Command('audit').description('signed audit trail of every requested side effect');

  cmd
    .command('list')
    .option('--agent <id>', 'filter by agent')
    .option('--limit <n>', 'max rows', '50')
    .action(async (o: { agent?: string; limit: string }, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      const q = new URLSearchParams({ limit: o.limit, ...(o.agent ? { agent: o.agent } : {}) });
      const list = await new ApiClient(cfg).call(
        'GET',
        `/admin/audit?${q.toString()}`,
        z.array(Attestation),
      );
      print(cfg.json, list, () =>
        rows(
          ['TS', 'AGENT', 'DECISION', 'ACTION', 'REPO', 'ID'],
          list.map((a) => [
            a.record.ts,
            a.record.agentId,
            a.record.decision,
            a.record.action.type,
            a.record.action.repo,
            a.record.id,
          ]),
        ),
      );
    });

  cmd.command('show <id>').action(async (id: string, _o, c: Command) => {
    const cfg = loadConfig(c.optsWithGlobals());
    print(
      cfg.json,
      await new ApiClient(cfg).call('GET', `/admin/audit/${encodeURIComponent(id)}`, Attestation),
    );
  });

  cmd
    .command('verify <id>')
    .description(
      'fetch an attestation and verify it locally: the broker signature, the record id and the agent signature against the pinned keys',
    )
    .action(async (id: string, _o, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      const api = new ApiClient(cfg);
      const att = await api.call('GET', `/admin/audit/${encodeURIComponent(id)}`, Attestation);
      const keys = await api.call('GET', '/admin/keys', z.array(PublicKeyEntry));
      // The check the public /verify runs, with the agent keys built into this binary.
      const { valid, reason, agentSignature } = await verifyRecord(att, id, keys);
      const result = {
        valid,
        ...(reason !== undefined ? { reason } : {}),
        ...(agentSignature !== undefined ? { agentSignature: agentSignature.status } : {}),
      };
      print(cfg.json, result, () =>
        result.valid
          ? `VALID  ${att.record.agentId}@${att.record.agentVersion} ${att.record.decision} ${att.record.action.type} ${att.record.action.repo}  (agent signature: ${result.agentSignature ?? 'none'})`
          : `INVALID  ${result.reason ?? ''}`,
      );
      if (!result.valid) process.exitCode = 1;
    });

  return cmd;
}
