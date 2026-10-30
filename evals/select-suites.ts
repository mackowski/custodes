// Which eval suites a pull request needs, from the files it changes. Evals call real models and
// cost real money, so CI runs only the suites whose agent the change can affect; a change to the
// shared plumbing runs them all. Reads changed paths (one per line) on stdin, prints suite names
// separated by spaces. Run with `node evals/select-suites.ts` (Node >= 22.18 strips the types).
import { readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';

const AGENTS = 'workers/agents/src/agents/';
const CHEATSHEET = [
  `${AGENTS}cheatsheet-review/prompts.ts`,
  `${AGENTS}cheatsheet-review/lineup.ts`,
  `${AGENTS}cheatsheet-review/types.ts`,
  `${AGENTS}cheatsheet-review/input.ts`,
  'packages/llm/src/chat.ts',
];
const JEV = ['packages/llm/src/jev.ts', 'packages/llm/src/clef.ts'];

/** Paths that can change what one suite's agent does. Its own `evals/agents/<suite>/` is implied. */
export const SUITE_PATHS: Record<string, readonly string[]> = {
  triage: [`${AGENTS}triage/prompt.ts`, `${AGENTS}triage/model.ts`, `${AGENTS}triage/assess.ts`],
  'implementation-check': [
    `${AGENTS}specialists/implementation.ts`,
    `${AGENTS}specialists/select.ts`,
    `${AGENTS}specialists/model.ts`,
  ],
  'proposal-review': [
    `${AGENTS}specialists/proposal.ts`,
    `${AGENTS}specialists/select.ts`,
    `${AGENTS}specialists/model.ts`,
  ],
  'pr-gate': [`${AGENTS}pr-gate/minor.ts`, `${AGENTS}pr-gate/rules.ts`, ...JEV],
  'pr-gate-approval': [`${AGENTS}pr-gate/approval.ts`, `${AGENTS}pr-gate/rules.ts`, ...JEV],
  'cheatsheet-review-judge': CHEATSHEET,
  'cheatsheet-review-links': CHEATSHEET,
  'cheatsheet-review-scope': CHEATSHEET,
  'cheatsheet-review-security': CHEATSHEET,
  'cheatsheet-review-security-2': CHEATSHEET,
};

/** Paths every suite depends on: a change here runs all of them. */
export const SHARED_PATHS: readonly string[] = [
  '.github/workflows/evals.yml',
  'evals/providers/',
  'evals/injection/',
  'evals/summarize.ts',
  'evals/select-suites.ts',
  'packages/llm/src/models.ts',
  'packages/llm/src/structured.ts',
  'packages/llm/src/untrusted.ts',
];

export function selectSuites(changed: readonly string[], all: readonly string[]): string[] {
  const hit = (prefixes: readonly string[]) =>
    changed.some((f) => prefixes.some((p) => f === p || (p.endsWith('/') && f.startsWith(p))));
  if (hit(SHARED_PATHS)) return [...all];
  return all.filter((s) => hit([`evals/agents/${s}/`, ...(SUITE_PATHS[s] ?? [])]));
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const all = readdirSync(new URL('./agents/', import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  // A suite with no entry in SUITE_PATHS would only run for its own folder: refuse, so it is not
  // silently skipped when its agent changes.
  const unmapped = all.filter((s) => !(s in SUITE_PATHS));
  if (unmapped.length) {
    console.error(`suites without SUITE_PATHS: ${unmapped.join(', ')}`);
    process.exit(1);
  }
  if (process.argv.includes('--all')) {
    console.log(all.join(' '));
    process.exit(0);
  }
  const changed = readFileSync(0, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  console.log(selectSuites(changed, all).join(' '));
}
