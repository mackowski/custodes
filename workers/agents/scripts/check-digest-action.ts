// Checks backlog-review digest actions before the operator runs one by hand (/backlog-digest,
// threat model backlog-review E1): the same rules the broker applies on its own path. Reads a file
// (its path is the only argument: no D1 text on a command line, security review of #168 M1) with
// one line per action, `{ "row": { "repo", "issue" }, "action": {...} }`, and prints one JSON
// verdict per line:
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

/** The verdict row an action was filed under: an action about any other item is refused. */
export interface Row {
  repo: string;
  issue: number;
}

export function checkAction(
  raw: unknown,
  row: Row,
): {
  ok: boolean;
  type?: string;
  denial?: string;
  problem?: string;
  mentions?: string[];
} {
  const parsed = BrokerAction.safeParse(raw);
  if (!parsed.success) return { ok: false, denial: 'not a BrokerAction' };
  const action = parsed.data;
  const n = 'issue' in action ? action.issue : action.pull;
  if (action.repo !== row.repo || n !== row.issue)
    return { ok: false, type: action.type, denial: 'action is about another item than its row' };
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
  const { readFileSync } = await import('node:fs');
  const path = process.argv[2];
  if (path === undefined) throw new Error('usage: check-digest-action.sh <file>');
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let raw: { row?: Row; action?: unknown };
    try {
      raw = JSON.parse(line) as { row?: Row; action?: unknown };
    } catch {
      console.log(JSON.stringify({ ok: false, denial: 'not JSON' }));
      continue;
    }
    const row = raw.row;
    console.log(
      JSON.stringify(
        row && typeof row.repo === 'string' && Number.isInteger(row.issue)
          ? checkAction(raw.action, row)
          : { ok: false, denial: 'no row' },
      ),
    );
  }
}

if (process.argv[1]?.endsWith('check-digest-action.mjs')) void main();
