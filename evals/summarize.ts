// Prints a compact pass/fail summary of promptfoo result files with the reason for each failed
// assertion. Eval inputs are synthetic, so reasons are safe to print in CI logs.
// Run with `node evals/summarize.ts` (Node >= 22.18 strips the types).
import { readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';

interface EvalResult {
  success: boolean;
  provider?: { id?: string; label?: string };
  error?: string;
  testCase?: { description?: string; metadata?: { golden?: boolean } };
  gradingResult?: {
    componentResults?: {
      pass: boolean;
      reason?: unknown;
      assertion?: { type?: string; metric?: string };
    }[];
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
    // Golden-case agreement (#132): up to 5% of a suite's `golden` cases may disagree, and only on
    // their `state` assertion (metric: state). A failed safety assertion, an error, or any other case
    // (injection cases included) always fails (security review of #168, L3).
    const golden = list.filter((r) => r.testCase?.metadata?.golden === true);
    const goldenFailed = bad.filter((r) => r.testCase?.metadata?.golden === true);
    const tolerable = goldenFailed.filter(
      (r) =>
        !r.error &&
        (r.gradingResult?.componentResults ?? []).some((c) => !c.pass) &&
        (r.gradingResult?.componentResults ?? []).every(
          (c) => c.pass || c.assertion?.metric === 'state',
        ),
    ).length;
    const tolerated = Math.min(tolerable, Math.floor(golden.length * 0.05));
    if (golden.length > 0)
      console.log(
        `  golden agreement: ${String(golden.length - goldenFailed.length)}/${String(golden.length)} (${String(tolerated)} tolerated, bar 95%)`,
      );
    if (!isShadow) failed += bad.length - tolerated;
  }
}

function report(r: EvalResult): void {
  console.log(`  FAIL ${r.testCase?.description ?? '(no description)'}`);
  for (const c of r.gradingResult?.componentResults ?? []) {
    if (!c.pass) console.log(`    - ${c.assertion?.type}: ${String(c.reason).slice(0, 300)}`);
  }
  if (r.error) console.log(`    error: ${r.error.slice(0, 300)}`);
}
// Every suite that was meant to run must have written a result file.
const written = new Set(
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length)),
);
for (const suite of (process.env['EXPECTED_SUITES'] ?? '').split(/\s+/).filter(Boolean)) {
  if (written.has(suite)) continue;
  console.log(`${suite}: NO RESULT (the suite did not run to the end)`);
  failed++;
}
process.exitCode = failed > 0 ? 1 : 0;
