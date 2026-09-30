// Prints a compact pass/fail summary of promptfoo result files with the reason for each failed
// assertion. Eval inputs are synthetic, so reasons are safe to print in CI logs.
// Run with `node evals/summarize.ts` (Node >= 22.18 strips the types).
import { readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';

interface EvalResult {
  success: boolean;
  error?: string;
  testCase?: { description?: string };
  gradingResult?: {
    componentResults?: { pass: boolean; reason?: unknown; assertion?: { type?: string } }[];
  };
}

const dir = new URL('./output/', import.meta.url);
let failed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const parsed = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as {
    results?: { results?: EvalResult[] };
  };
  const results = parsed.results?.results ?? [];
  const bad = results.filter((r) => !r.success);
  console.log(`${file}: ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) {
    console.log(`  FAIL ${r.testCase?.description ?? '(no description)'}`);
    for (const c of r.gradingResult?.componentResults ?? []) {
      if (!c.pass) console.log(`    - ${c.assertion?.type}: ${String(c.reason).slice(0, 300)}`);
    }
    if (r.error) console.log(`    error: ${r.error.slice(0, 300)}`);
  }
  failed += bad.length;
}
process.exitCode = failed > 0 ? 1 : 0;
