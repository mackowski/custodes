// Checks that a pull request body carries the "Architecture and data flow" section the /ship skill
// writes (.claude/skills/ship/SKILL.md): diagrams, the data-flow verdict, the security table and the
// documentation list. Run by .github/workflows/pr-architecture.yml on every PR but Dependabot's.
//
//   PR_BODY=... node --experimental-strip-types scripts/pr-architecture.ts <changed-files.txt>
//
// The body is untrusted text (anyone who opens a PR writes it): it is only read and matched here,
// never executed or echoed back beyond fixed messages.
import { readFileSync } from 'node:fs';

const START = '<!-- architecture:start -->';
const END = '<!-- architecture:end -->';
/** The template's placeholder diagram: present means the section was not filled in. */
const PLACEHOLDER = 'A["..."] --> B["..."]';
const ASPECTS = [
  'Trust boundaries',
  'Credentials and secrets',
  'Untrusted input and models',
  'Authority (policy, actions, repos)',
  'Approvals and kill switch',
  'CI, supply chain, deploy',
  'Access and public routes',
];
/** Files whose change usually changes the data flow (Workers, bindings, routes, policy, CI, infra). */
const FLOW_FILES: RegExp[] = [
  /^workers\/[^/]+\/wrangler\.jsonc$/,
  /^workers\/github-broker\/policy\/policy\.json$/,
  /^workers\/github-broker\/src\/index\.ts$/,
  /^workers\/gateway\/src\//,
  /^workers\/agents\/src\/[^/]+-worker\.ts$/,
  /^packages\/schema\/src\/callers\.ts$/,
  /^\.github\/workflows\/deploy-[^/]+\.yml$/,
  /^infra\/terraform\//,
];
const DATA_FLOW_DOC = 'docs/architecture/data-flow.md';

export interface Verdict {
  errors: string[];
  /** Files that suggest a data-flow change, for the message. */
  flowFiles: string[];
}

export function checkPrBody(body: string, changed: readonly string[]): Verdict {
  const errors: string[] = [];
  const flowFiles = changed.filter((f) => FLOW_FILES.some((re) => re.test(f)));
  const text = body.replace(/\r\n/g, '\n');
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    errors.push(`missing the section between ${START} and ${END} (run /ship)`);
    return { errors, flowFiles };
  }
  const section = text.slice(start + START.length, end);

  if (!/^## Architecture and data flow\s*$/m.test(section))
    errors.push('missing the heading "## Architecture and data flow"');

  const diagrams = [...section.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  if (diagrams.length === 0) errors.push('no Mermaid diagram');
  else if (diagrams.every((d) => d.includes(PLACEHOLDER) || d.trim().split('\n').length < 3))
    errors.push('the diagrams are still the template placeholder');

  const verdict = /^Data flow: (changed\b.*|unchanged: .*)$/m.exec(section)?.[1];
  if (verdict === undefined || verdict.includes('|') || verdict.includes('<reason>'))
    errors.push('missing "Data flow: changed ..." or "Data flow: unchanged: <reason>"');
  else if (verdict.startsWith('changed') && !changed.includes(DATA_FLOW_DOC))
    errors.push(`says the data flow changed but ${DATA_FLOW_DOC} is not updated`);
  else if (verdict.startsWith('unchanged') && verdict.replace('unchanged:', '').trim().length < 10)
    errors.push('"Data flow: unchanged" needs a reason');

  const security = /^### Security\s*$([\s\S]*?)(?=^### |(?![\s\S]))/m.exec(section)?.[1] ?? '';
  if (security === '') errors.push('missing "### Security"');
  else
    for (const aspect of ASPECTS) {
      const row = security.split('\n').find((l) => l.trim().startsWith('|') && l.includes(aspect));
      const cells = row?.split('|').map((c) => c.trim()) ?? [];
      // | aspect | change | effect | control |  →  ['', aspect, change, effect, control, '']
      if (row === undefined) errors.push(`security table: no row for "${aspect}"`);
      else if (!cells[2] || !cells[3])
        errors.push(`security table: "${aspect}" needs its change and effect`);
    }

  const docs = /^### Documentation\s*$([\s\S]*)/m.exec(section)?.[1] ?? '';
  if (!/^\s*- \[[ xX]\] \S/m.test(docs)) errors.push('missing "### Documentation" with its list');

  return { errors, flowFiles };
}

if (process.argv[1]?.endsWith('pr-architecture.ts')) {
  const file = process.argv[2];
  const changed = file
    ? readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
    : [];
  const { errors, flowFiles } = checkPrBody(process.env['PR_BODY'] ?? '', changed);
  if (flowFiles.length > 0)
    console.log(`Files that usually change the data flow: ${flowFiles.join(', ')}`);
  for (const e of errors) console.log(`::error::Architecture section: ${e}`);
  if (errors.length > 0) {
    console.log('See .claude/skills/ship/SKILL.md and .github/pull_request_template.md.');
    process.exit(1);
  }
  console.log('Architecture section present.');
}
