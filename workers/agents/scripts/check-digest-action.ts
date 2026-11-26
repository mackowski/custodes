// Checks backlog-review digest actions before the operator runs one by hand (/backlog-digest,
// threat model backlog-review E1): the same rules the broker applies on its own path. Reads one
// JSON action per line on stdin and prints one JSON verdict per line:
// { ok, type?, denial?, problem?, mentions? }.
// - ok is false when the action does not parse, the policy denies it, or a comment body breaks the
//   comment rules.
// - mentions lists the @logins in a body that are not the repository's policy maintainers; the
//   session must check them against the thread's people.
// Run: scripts/check-digest-action.sh (bundles this file for Node).
import { actionDenial, commentProblem, mentionsIn } from '@custodes/core';
import { BrokerAction } from '@custodes/schema';
import { POLICY } from '../src/agents/backlog-review/bundle.js';

const AGENT = 'backlog-review';

export function checkAction(raw: unknown): {
  ok: boolean;
  type?: string;
  denial?: string;
  problem?: string;
  mentions?: string[];
} {
  const parsed = BrokerAction.safeParse(raw);
  if (!parsed.success) return { ok: false, denial: 'not a BrokerAction' };
  const action = parsed.data;
  const agent = POLICY.agents[AGENT];
  if (!agent) return { ok: false, type: action.type, denial: 'no policy entry' };
  const denial = actionDenial(AGENT, agent, action);
  if (denial !== undefined) return { ok: false, type: action.type, denial };
  const body = 'body' in action && typeof action.body === 'string' ? action.body : '';
  const problem = body === '' ? null : commentProblem(body, action.repo);
  if (problem !== null) return { ok: false, type: action.type, problem };
  const maintainers = new Set((POLICY.maintainers[action.repo] ?? []).map((m) => m.toLowerCase()));
  const mentions = [...mentionsIn(body)].filter((m) => !maintainers.has(m.toLowerCase()));
  return { ok: true, type: action.type, ...(mentions.length > 0 ? { mentions } : {}) };
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      console.log(JSON.stringify({ ok: false, denial: 'not JSON' }));
      continue;
    }
    console.log(JSON.stringify(checkAction(raw)));
  }
}

if (process.argv[1]?.endsWith('check-digest-action.mjs')) void main();
