// Prints a compact pass/fail summary of promptfoo result files with the reason for each failed
// assertion. Eval inputs are synthetic, so reasons are safe to print in CI logs.
// Run with `node evals/summarize.ts` (Node >= 22.18 strips the types).
import { readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';

interface EvalResult {
  success: boolean;
  provider?: { id?: string; label?: string };
  error?: string;
  testCase?: { description?: string };
  gradingResult?: {
    componentResults?: { pass: boolean; reason?: unknown; assertion?: { type?: string } }[];
  };
}

const dir = new URL('./output/', import.meta.url);
let failed = 0;
// Providers labelled `shadow:` (ADR 0015) are reported next to the real one but never fail the run.
const shadow = (r: EvalResult) => (r.provider?.label ?? '').startsWith('shadow:');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const parsed = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as {
    results?: { results?: EvalResult[] };
  };
  const byProvider = new Map<string, EvalResult[]>();
  for (const r of parsed.results?.results ?? []) {
    const label = r.provider?.label ?? r.provider?.id ?? '(provider)';
    byProvider.set(label, [...(byProvider.get(label) ?? []), r]);
  }
  for (const [label, list] of byProvider) {
    const bad = list.filter((r) => !r.success);
    const isShadow = list.some(shadow);
    console.log(
      `${file} [${label}]: ${list.length - bad.length}/${list.length} passed${isShadow ? ' (shadow, report only)' : ''}`,
    );
    for (const r of bad) report(r);
    if (!isShadow) failed += bad.length;
  }
}

function report(r: EvalResult): void {
  console.log(`  FAIL ${r.testCase?.description ?? '(no description)'}`);
  for (const c of r.gradingResult?.componentResults ?? []) {
    if (!c.pass) console.log(`    - ${c.assertion?.type}: ${String(c.reason).slice(0, 300)}`);
  }
  if (r.error) console.log(`    error: ${r.error.slice(0, 300)}`);
}
process.exitCode = failed > 0 ? 1 : 0;
