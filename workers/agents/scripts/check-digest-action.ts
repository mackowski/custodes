// Checks backlog-review digest actions before the operator runs one by hand (/backlog-digest,
// threat model backlog-review E1): the same rules the broker applies on its own path. Reads a file
// (its path is the only argument: no D1 text on a command line, security review of #168 M1) with
// one line per action, `{ "row": { "repo", "issue" }, "action": {...} }`, and prints one JSON
// verdict per line:
// { ok, type?, denial?, problem?, mentions?, action?, bodyFile? }.
// - For an ok action, `action` is the checked action without its body and `bodyFile` the path of
//   a file holding the checked body: the session builds its `gh` command from these only, so what
//   runs is what was checked (security review r2 of #168, L2).
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
  action?: BrokerAction;
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
  return {
    ok: true,
    type: action.type,
    ...(mentions.length > 0 ? { mentions } : {}),
    action,
  };
}

async function main(): Promise<void> {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const path = process.argv[2];
  if (path === undefined) throw new Error('usage: check-digest-action.sh <file>');
  let n = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    n++;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      console.log(JSON.stringify({ ok: false, denial: 'not JSON' }));
      continue;
    }
    const { row, action, route } = (typeof raw === 'object' && raw !== null ? raw : {}) as {
      row?: Row;
      action?: unknown;
      route?: unknown;
    };
    if (!row || typeof row.repo !== 'string' || !Number.isInteger(row.issue)) {
      console.log(JSON.stringify({ ok: false, denial: 'no row' }));
      continue;
    }
    if (route !== 'digest') {
      console.log(JSON.stringify({ ok: false, denial: 'not a digest route' }));
      continue;
    }
    const r = checkAction(action, row);
    if (!r.ok || !r.action) {
      console.log(JSON.stringify(r));
      continue;
    }
    const { body, ...rest } = r.action as BrokerAction & { body?: string };
    let bodyFile: string | undefined;
    if (typeof body === 'string' && body !== '') {
      bodyFile = `${path}.${String(n)}.body.md`;
      writeFileSync(bodyFile, body);
    }
    console.log(JSON.stringify({ ...r, action: rest, ...(bodyFile ? { bodyFile } : {}) }));
  }
}

if (process.argv[1]?.endsWith('check-digest-action.mjs')) void main();
