// Prints a compact pass/fail summary of promptfoo result files with the reason for each failed
// assertion. Eval inputs are synthetic, so reasons are safe to print in CI logs.
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('./output/', import.meta.url);
let failed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const results = JSON.parse(readFileSync(new URL(file, dir), 'utf8')).results?.results ?? [];
  const bad = results.filter((r) => !r.success);
  console.log(`${file}: ${results.length - bad.length}/${results.length} passed`);
  for (const r of bad) {
    console.log(`  FAIL ${r.testCase?.description ?? '(no description)'}`);
    for (const c of r.gradingResult?.componentResults ?? []) {
      if (!c.pass) console.log(`    - ${c.assertion?.type}: ${String(c.reason).slice(0, 300)}`);
    }
    if (r.error) console.log(`    error: ${String(r.error).slice(0, 300)}`);
  }
  failed += bad.length;
}
process.exitCode = failed > 0 ? 1 : 0;
