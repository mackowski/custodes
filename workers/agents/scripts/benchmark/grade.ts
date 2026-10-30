/**
 * Step 3: GPT-6.1 Terra, which plays no candidate role, maps every finding to the maintainers'
 * notes (grill-plan Q2). It sees findings without the model that wrote them (blind ids), so it
 * cannot favour a model. Maintainer notes and findings are untrusted text inside envelopes.
 * Output per pull request: which notes are real problems, and which finding matches which note.
 */
import { parseStructured, untrusted, UNTRUSTED_DATA_RULES } from '@custodes/llm';
import { call, clients, dataPath, exists, readJson, writeJson } from './common.js';
import { findingsOf, Grade } from './findings.js';
import type { FrozenPull, Stratum } from './select.js';

const PROMPT = `You grade an automated review of a pull request to the OWASP Cheat Sheet Series against what
the human maintainers actually said about it.
1. For each maintainer note, decide whether it states a real problem with the change (wrong or
   risky advice, a broken or unsupported source, duplication, misplacement, poor or unclear
   language, scope or process). Thanks, approvals, questions without a problem, and merge
   chatter are not problems.
2. For each automated finding, give the id of the maintainer note that raises the same problem,
   or null when no note does. Same problem means the same defect in substance, even if worded
   differently or on a nearby line; a vaguely related remark is not a match.
Answer with one JSON object and nothing else:
{"notes":[{"id":"<note id>","isProblem":true|false}],"matches":[{"finding":"<finding id>","note":"<note id>"|null}]}

${UNTRUSTED_DATA_RULES}`;

const c = clients();
const sample = readJson<{ pull: number; stratum: Stratum }[]>(dataPath('sample.json'));
for (const { pull } of sample) {
  const file = dataPath('grades', `${pull}.json`);
  if (exists(file)) continue;
  const frozen = readJson<FrozenPull>(dataPath('snapshots', `${pull}.json`));
  const findings = findingsOf(pull);
  if (findings.length === 0 || frozen.notes.length === 0) {
    writeJson(file, {
      notes: frozen.notes.map((n) => ({ id: n.id, isProblem: false })),
      matches: findings.map((f) => ({ finding: f.id, note: null })),
    });
    continue;
  }
  const user = [
    'Maintainer notes:',
    untrusted(
      'maintainer-notes',
      JSON.stringify(
        frozen.notes.map((n) => ({ id: n.id, path: n.path, line: n.line, text: n.text })),
      ),
    ),
    'Automated findings:',
    untrusted(
      'findings',
      JSON.stringify(
        findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          file: f.file,
          line: f.line,
          text: f.text,
        })),
      ),
    ),
  ].join('\n\n');
  const r = await call(c, 'terra', { system: PROMPT, user, max_tokens: 8_000 }, `grade:${pull}`);
  let grade: Grade;
  try {
    grade = parseStructured(Grade, r.result.text);
  } catch (err) {
    // The error can quote the model's answer, which can quote pull request text: name only.
    console.log(`#${pull} grade unparsable: ${err instanceof Error ? err.name : 'error'}`);
    continue;
  }
  writeJson(file, grade);
  console.log(`#${pull} graded`);
}
