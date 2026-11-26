// Which eval suites a pull request needs, from the files it changes. Evals call real models and
// cost real money, so CI runs only the suites whose agent the change can affect; a change to the
// shared plumbing runs them all. Reads changed paths (one per line) on stdin, prints suite names
// separated by spaces. Run with `node evals/select-suites.ts` (Node >= 22.18 strips the types).
import { readdirSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const AGENTS = 'workers/agents/src/agents/';
const CHEATSHEET = [
  `${AGENTS}cheatsheet-review/prompts.ts`,
  `${AGENTS}cheatsheet-review/lineup.ts`,
  `${AGENTS}cheatsheet-review/types.ts`,
  `${AGENTS}cheatsheet-review/input.ts`,
  // Builds the sentence the link auditor reads for each URL.
  `${AGENTS}cheatsheet-review/links.ts`,
  'packages/llm/src/chat.ts',
];
const JEV = ['packages/llm/src/jev.ts', 'packages/llm/src/clef.ts'];
/** #90: builds the verifier's input and what the judge is told about claim verdicts. */
const CLAIMS = `${AGENTS}cheatsheet-review/claims.ts`;

/** Paths that can change what one suite's agent does. Its own `evals/agents/<suite>/` is implied. */
export const SUITE_PATHS: Record<string, readonly string[]> = {
  // #132 v1: the role's agent.md and context, the runtime, the dispatcher and the eval provider.
  'backlog-review': [
    `${AGENTS}backlog-review/`,
    'packages/llm/src/runtime.ts',
    'packages/llm/src/runtime-host.ts',
    'packages/core/src/runtime/dispatcher.ts',
    'workers/agents/scripts/eval-backlog-runtime.ts',
    'evals/providers/backlog-runtime.mjs',
    'evals/fixtures/backlog-review/',
  ],
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
  'cheatsheet-review-judge': [...CHEATSHEET, CLAIMS],
  'cheatsheet-review-links': CHEATSHEET,
  'cheatsheet-review-scope': CHEATSHEET,
  'cheatsheet-review-security': CHEATSHEET,
  // The second voice runs the first one's cases (its config loads them): a new case must reach both.
  'cheatsheet-review-security-2': [
    ...CHEATSHEET,
    'evals/agents/cheatsheet-review-security/cases.yaml',
  ],
  'cheatsheet-review-verifier': [...CHEATSHEET, CLAIMS],
  // ADR 0020: the security reviewer's second pass; sources.ts builds its message.
  'cheatsheet-review-sources': [...CHEATSHEET, `${AGENTS}cheatsheet-review/sources.ts`],
};

/** Paths every suite depends on: a change here runs all of them. */
export const SHARED_PATHS: readonly string[] = [
  '.github/workflows/evals.yml',
  'evals/providers/',
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
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
  // Read stdin as a stream: readFileSync(0) fails with EAGAIN on a non-blocking pipe (seen in CI).
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  const changed = input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  console.log(selectSuites(changed, all).join(' '));
}
