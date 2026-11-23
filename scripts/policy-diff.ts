// Capability diff for workers/github-broker/policy/{policy,boundary}.json (ADR 0022): every grant
// the head version adds or removes against the base, as a Markdown table for the job summary of
// .github/workflows/pr-architecture.yml. Plain Node, no workspace packages: that job installs none.
//
//   node --experimental-strip-types scripts/policy-diff.ts <base.json> <head.json> <title>
//
// Both files come from the pull request, so every value is untrusted: cells keep only a safe
// character set and nothing is executed.
import { existsSync, readFileSync } from 'node:fs';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const entries = (v: unknown): [string, Json][] =>
  isObj(v)
    ? Object.entries(v).filter((e): e is [string, Json] => !e[0].startsWith('$') && isObj(e[1]))
    : [];

/** Keeps ids, repos, action names and numbers readable; anything else becomes `?`. */
export function cell(v: unknown): string {
  return String(v)
    .replace(/[^A-Za-z0-9_./@:=+*-]/g, '?')
    .slice(0, 120);
}

/** One line per grant, so a set difference is the capability diff. */
export function grants(policy: unknown): Set<string> {
  const out = new Set<string>();
  const doc = isObj(policy) ? policy : {};
  for (const [id, a] of entries(doc['agents'])) {
    const mode = a['mode'];
    const approvalAll = strings(a['requiresApproval']);
    const approvalOn = isObj(a['requiresApprovalOn']) ? a['requiresApprovalOn'] : {};
    out.add(
      `${cell(id)} | agent | tier=${cell(a['tier'])} mode=${cell(mode)} token=${cell(a['tokenBinding'])}`,
    );
    for (const repo of strings(a['repos'])) {
      out.add(`${cell(id)} | rate | ${cell(repo)} ${cell(a['rateLimitPerHour'] ?? 60)}/h`);
      for (const action of strings(a['actions'])) {
        const needs =
          mode === 'hitl' ||
          approvalAll.includes(action) ||
          strings(approvalOn[repo]).includes(action);
        out.add(
          `${cell(id)} | action | ${cell(repo)} ${cell(action)} approval=${needs ? 'yes' : 'no'}`,
        );
      }
    }
    const labels = a['labels'];
    const labelActions = strings(a['actions']).some((t) => t.startsWith('issue.label.'));
    if (!labelActions) {
      // No label action, so no label grant whatever `labels` says.
    } else if (labels === undefined) out.add(`${cell(id)} | label | *any*`);
    else for (const l of strings(labels)) out.add(`${cell(id)} | label | ${cell(l)}`);
    out.add(
      `${cell(id)} | approvals | ttl=${cell(a['approvalTtlHours'] ?? 24)}h pending=${cell(a['maxPendingApprovals'] ?? 20)} trailer=${cell(a['trailer'] ?? 'visible')} bundleOnly=${cell(a['bundleOnly'] ?? false)}`,
    );
  }
  for (const [id, r] of entries(doc['reads'])) {
    out.add(`${cell(id)} | read token | ${cell(r['tokenBinding'])}`);
    for (const repo of strings(r['repos']))
      for (const res of strings(r['resources']))
        out.add(`${cell(id)} | read | ${cell(repo)} ${cell(res)}`);
  }
  return out;
}

export function capabilityDiff(
  base: unknown,
  head: unknown,
): { added: string[]; removed: string[] } {
  const b = grants(base);
  const h = grants(head);
  return {
    added: [...h].filter((g) => !b.has(g)).sort(),
    removed: [...b].filter((g) => !h.has(g)).sort(),
  };
}

export function renderDiff(title: string, d: { added: string[]; removed: string[] }): string {
  const lines = [`### Capability diff: ${cell(title)}`, ''];
  if (d.added.length === 0 && d.removed.length === 0)
    return [...lines, 'No grant changes.', ''].join('\n');
  lines.push('|   | Agent | Kind | Grant |', '| - | ----- | ---- | ----- |');
  for (const g of d.added) lines.push(`| + | ${g} |`);
  for (const g of d.removed) lines.push(`| − | ${g} |`);
  return [...lines, ''].join('\n');
}

const read = (path: string | undefined): unknown =>
  path !== undefined && existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : {};

if (process.argv[1]?.endsWith('policy-diff.ts')) {
  const [base, head, title] = process.argv.slice(2);
  console.log(renderDiff(title ?? 'policy', capabilityDiff(read(base), read(head))));
}
