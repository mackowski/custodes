/**
 * Writes cheatsheet-review's shipped prompts into the eval suites (ADR 0017), so the evals test
 * exactly what the agent sends. A unit test fails when they drift; run from workers/agents after changing a prompt:
 * pnpm --filter ./workers/agents exec esbuild scripts/print-review-prompts.ts --bundle --platform=node --format=esm --outfile=/tmp/p.mjs && node /tmp/p.mjs
 */
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import {
  JUDGE_PROMPT,
  LINK_PROMPT,
  reviewerPrompt,
  SCOPE_PROMPT,
} from '../src/agents/cheatsheet-review/prompts.js';

const root = new URL('../../evals/agents/', `file://${process.cwd()}/`);
const files: Record<string, string> = {
  'cheatsheet-review-scope/system.txt': SCOPE_PROMPT,
  'cheatsheet-review-security/system.txt': reviewerPrompt('security-reviewer'),
  'cheatsheet-review-security-2/system.txt': reviewerPrompt('security-second-voice'),
  'cheatsheet-review-links/system.txt': LINK_PROMPT,
  'cheatsheet-review-judge/system.txt': JUDGE_PROMPT,
};
for (const [path, text] of Object.entries(files)) writeFileSync(new URL(path, root), text);
console.log(`wrote ${Object.keys(files).length} prompts`);
