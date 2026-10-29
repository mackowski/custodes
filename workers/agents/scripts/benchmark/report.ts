/**
 * Step 4: metrics against the thresholds fixed before the run (grill-plan Q5), written to
 * REPORT.md next to this file (pull request numbers and numbers only, no third-party text).
 * Also writes `.bench/cheatsheet-review/spotcheck.md`: 10 random grader matches with their text,
 * for the operator to check (grill-plan Q12); it stays out of the repository.
 */
import { writeFileSync } from 'node:fs';
import type { ReviewDecision, ReviewerReport } from '../../src/agents/cheatsheet-review/types.js';
import { dataPath, exists, readJson, ROOT, spent } from './common.js';
import { findingsOf, type Grade } from './findings.js';
import type { Output } from './run.js';
import type { FrozenPull, Stratum } from './select.js';

const sample = readJson<{ pull: number; stratum: Stratum }[]>(dataPath('sample.json'));

interface Tally {
  hits: Set<string>;
  falseBlockers: number;
  findings: number;
  runs: number;
  usd: number;
}
const tallies = new Map<string, Tally>();
const tally = (k: string) => {
  let t = tallies.get(k);
  if (!t) tallies.set(k, (t = { hits: new Set(), falseBlockers: 0, findings: 0, runs: 0, usd: 0 }));
  return t;
};
const unique = { wonder: new Set<string>() };
const verdicts: Record<string, { strict: number; lenient: number; n: number }> = {};
const verdict = (k: string, got: string | undefined, s: Stratum) => {
  const v = (verdicts[k] ??= { strict: 0, lenient: 0, n: 0 });
  if (!got) return;
  v.n++;
  const want = s === 'clean' ? 'MERGE' : s === 'fixed' ? 'REQUEST_CHANGES' : 'CLOSE';
  if (got === want) v.strict++;
  if (s === 'clean' ? got === 'MERGE' : got !== 'MERGE') v.lenient++;
};
let problems = 0;
const spot: string[] = [];

for (const { pull, stratum } of sample) {
  const gradeFile = dataPath('grades', `${pull}.json`);
  if (!exists(gradeFile)) continue;
  const g = readJson<Grade>(gradeFile);
  const frozen = readJson<FrozenPull>(dataPath('snapshots', `${pull}.json`));
  const real = new Set(g.notes.filter((n) => n.isProblem).map((n) => n.id));
  problems += real.size;
  const findings = findingsOf(pull);
  const match = new Map(g.matches.map((m) => [m.finding, m.note]));
  for (const f of findings) {
    const t = tally(f.source);
    t.findings++;
    const note = match.get(f.id) ?? null;
    if (note && real.has(note)) t.hits.add(`${pull}:${note}`);
    else if (f.severity === 'BLOCKER') t.falseBlockers++;
    if (note && spot.length < 400) {
      const n = frozen.notes.find((x) => x.id === note);
      spot.push(
        `### #${pull} ${f.id} (${f.severity})\n- finding: ${f.text.replace(/\s+/g, ' ')}\n- maintainer: ${(n?.text ?? '').replace(/\s+/g, ' ').slice(0, 400)}\n- grader: same problem\n`,
      );
    }
  }
  const hit = (src: string) =>
    new Set([...tally(src).hits].filter((h) => h.startsWith(`${pull}:`)));
  for (const h of hit('security-second-voice:museWonder'))
    if (!hit('security-reviewer:opus').has(h) && !hit('security-second-voice:deepseekPro').has(h))
      unique.wonder.add(h);

  const dir = dataPath('outputs', String(pull), 'x');
  for (const f of [
    'security-reviewer.opus',
    'security-second-voice.deepseekPro',
    'security-second-voice.deepseekFlash',
    'security-second-voice.museWonder',
    'practicality-reviewer.museSpark',
    'practicality-reviewer.museWonder',
    'practicality-reviewer.sonnet',
    'duplication-checker.museSpark',
    'language-reviewer.luna',
    'judge.sol',
    'judge.astra',
  ]) {
    const u = new URL(`${f}.json`, dir);
    if (!exists(u)) continue;
    const o = readJson<Output<unknown>>(u);
    const t = tally(f.replace('.', ':'));
    t.runs++;
    t.usd += o.usd;
  }
  for (const j of ['sol', 'astra']) {
    const u = new URL(`judge.${j}.json`, dir);
    verdict(
      `judge:${j}`,
      exists(u) ? readJson<Output<ReviewDecision>>(u).answer?.verdict : undefined,
      stratum,
    );
  }
  // The rule without a model (grill-plan Q10): any baseline BLOCK asks for changes.
  const blocks = [
    'security-reviewer.opus',
    'security-second-voice.deepseekPro',
    'practicality-reviewer.museSpark',
    'duplication-checker.museSpark',
    'language-reviewer.luna',
  ].some((f) => {
    const u = new URL(`${f}.json`, dir);
    return exists(u) && readJson<Output<ReviewerReport>>(u).answer?.verdict === 'BLOCK';
  });
  verdict('sum rule', blocks ? 'REQUEST_CHANGES' : 'MERGE', stratum);
}

const t = (k: string) => tally(k);
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');
const row = (k: string) =>
  `| ${k} | ${t(k).runs} | ${t(k).hits.size} | ${t(k).falseBlockers} | ${t(k).findings} | $${t(k).usd.toFixed(2)} |`;
const sol = verdicts['judge:sol'] ?? { strict: 0, lenient: 0, n: 0 };
const astra = verdicts['judge:astra'] ?? { strict: 0, lenient: 0, n: 0 };
const pp = (v: { lenient: number; n: number }) => (v.n ? (100 * v.lenient) / v.n : 0);
const judgeToAstra =
  pp(astra) - pp(sol) >= 10 || t('judge:astra').falseBlockers <= 0.7 * t('judge:sol').falseBlockers;
const wonderThird =
  unique.wonder.size >= 3 && t('security-second-voice:museWonder').falseBlockers <= 2;
const flash = t('security-second-voice:deepseekFlash');
const pro = t('security-second-voice:deepseekPro');
const toFlash = flash.hits.size >= pro.hits.size - 1 && flash.falseBlockers <= pro.falseBlockers;
const prac = [
  'practicality-reviewer:museSpark',
  'practicality-reviewer:museWonder',
  'practicality-reviewer:sonnet',
].sort((a, b) => t(b).hits.size - t(a).hits.size || t(a).usd - t(b).usd)[0];

const report = `# cheatsheet-review model benchmark (one-off, 2026-10)

Run by hand with \`workers/agents/scripts/benchmark/\` (README.md); not part of CI. ${sample.length} external pull
requests to OWASP/CheatSheetSeries closed in the last 12 months (${['clean', 'fixed', 'closed'].map((s) => `${sample.filter((x) => x.stratum === s).length} ${s}`).join(', ')}), each reviewed at the commit of the first maintainer review.
Grader: GPT-6.1 Terra (in no candidate role). Real problems found by maintainers: ${problems}.
Total cost: $${spent().usd.toFixed(2)} in ${spent().calls} calls.

## Findings per model and role

"Hits": maintainer-raised problems the model found. "False blockers": BLOCKER findings matching no real problem.

| Source | Runs | Hits | False blockers | Findings | Cost |
| --- | --- | --- | --- | --- | --- |
${[...tallies.keys()]
  .filter((k) => !k.includes('.'))
  .sort()
  .map(row)
  .join('\n')}

Muse Wonder as a third security voice found ${unique.wonder.size} problem(s) neither Opus nor DeepSeek V4 Pro found.

## Verdicts

Expected: clean → MERGE, fixed → REQUEST_CHANGES, closed → CLOSE. Lenient: anything but MERGE counts for fixed and closed.

| Decider | Strict | Lenient | PRs |
| --- | --- | --- | --- |
${Object.entries(verdicts)
  .map(([k, v]) => `| ${k} | ${pct(v.strict, v.n)} | ${pct(v.lenient, v.n)} | ${v.n} |`)
  .join('\n')}

## Decisions against the thresholds set before the run

| Question | Threshold | Result |
| --- | --- | --- |
| Judge → Astra | ≥10 pp lenient agreement or ≥30% fewer false blockers | ${judgeToAstra ? '**switch to Astra**' : 'keep Sol'} (${pp(astra).toFixed(0)}% vs ${pp(sol).toFixed(0)}%; false blockers ${t('judge:astra').falseBlockers} vs ${t('judge:sol').falseBlockers}) |
| Muse Wonder as third security voice | ≥3 unique hits and ≤2 false blockers | ${wonderThird ? '**add**' : 'do not add'} (${unique.wonder.size} unique, ${t('security-second-voice:museWonder').falseBlockers} false blockers) |
| Second voice → DeepSeek V4.1 Flash | hits ≥ V4 Pro −1 and no more false blockers | ${toFlash ? '**switch to Flash**' : 'keep V4 Pro'} (${flash.hits.size} vs ${pro.hits.size} hits; ${flash.falseBlockers} vs ${pro.falseBlockers} false blockers) |
| Practicality | most hits, then cheapest | **${prac ?? 'n/a'}** |

Results within 1 of a threshold get a second run before the lineup changes (grill-plan Q8).
`;
writeFileSync(new URL('workers/agents/scripts/benchmark/REPORT.md', ROOT), report);

// Ten random matches for the operator's check, seeded so a rerun shows the same ones.
let seed = 20261029;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const picks = [...spot].sort(() => rnd() - 0.5).slice(0, 10);
writeFileSync(
  dataPath('spotcheck.md'),
  `# Spot check: is each pair the same problem? (≥3 "no" of 10 = distrust the grader)\n\n${picks.join('\n')}`,
);
console.log(report);
