// Durable Object namespace ownership checks for the deploy workflows (ADR 0018,
// docs/runbooks/pr-gate-cutover.md).
//
//   do-namespace-owner.ts <ClassName>
//       Prints the Worker (script) that owns the class's namespace, or nothing if there is none.
//   do-namespace-owner.ts <ClassName> --guard <workers/dir> <script>
//       Fails unless it is safe to deploy that Worker: if its wrangler.jsonc declares the class live
//       (an `exports` entry without a `state`, or a binding without `script_name`), the owner must
//       be exactly <script>. An empty or different owner fails: a guard must not pass on a lookup
//       that found nothing.
//
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Prints ids only, never the token.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Namespace {
  class?: string;
  script?: string;
}
interface Page {
  success: boolean;
  result?: Namespace[];
  result_info?: { total_count?: number };
}
interface WranglerConfig {
  exports?: Record<string, { state?: string } | undefined>;
  durable_objects?: { bindings?: { class_name: string; script_name?: string }[] };
}

const PER_PAGE = 100;
const MAX_PAGES = 50;

async function owners(className: string, token: string, account: string): Promise<Set<string>> {
  const found = new Set<string>();
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/durable_objects/namespaces?page=${page}&per_page=${PER_PAGE}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const body = (await res.json()) as Page;
    if (!res.ok || !body.success) throw new Error(`namespace list refused (HTTP ${res.status})`);
    const rows = body.result ?? [];
    seen += rows.length;
    for (const ns of rows) if (ns.class === className && ns.script) found.add(ns.script);
    // total_count is reported (total_pages is not, checked 2026-11-09).
    const total = body.result_info?.total_count;
    if (total === undefined) throw new Error('namespace list has no total_count');
    if (seen >= total) return found;
    if (rows.length === 0) throw new Error('namespace list ended before total_count');
  }
  throw new Error(`more than ${MAX_PAGES} pages of namespaces`);
}

function declaresLive(dir: string, className: string): boolean {
  const text = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  const config = JSON.parse(text) as WranglerConfig;
  const exported = config.exports?.[className];
  const liveExport = exported !== undefined && exported.state === undefined;
  const ownBinding = (config.durable_objects?.bindings ?? []).some(
    (b) => b.class_name === className && b.script_name === undefined,
  );
  return liveExport || ownBinding;
}

const [className = '', flag, dir, script] = process.argv.slice(2);
const token = process.env['CLOUDFLARE_API_TOKEN'];
const account = process.env['CLOUDFLARE_ACCOUNT_ID'];
if (!/^[A-Za-z][A-Za-z0-9]*$/.test(className) || !token || !account) {
  console.error('usage: do-namespace-owner.ts <ClassName> [--guard <dir> <script>]');
  process.exit(2);
}
const found = await owners(className, token, account);
if (found.size > 1) {
  console.error(`more than one namespace for ${className}: ${[...found].join(', ')}`);
  process.exit(1);
}
const owner = [...found][0] ?? '';

if (flag === undefined) {
  console.log(owner);
} else if (flag === '--guard' && dir && script) {
  if (declaresLive(dir, className) && owner !== script) {
    console.error(
      `${dir} declares ${className} live, but its namespace belongs to '${owner || 'nobody'}', not ${script}. ` +
        'After a cutover, merge its follow-up PR first (docs/runbooks/pr-gate-cutover.md).',
    );
    process.exit(1);
  }
  console.log(`${className}: owner ${owner || '(none)'}, ok for ${script}`);
} else {
  console.error('usage: do-namespace-owner.ts <ClassName> [--guard <dir> <script>]');
  process.exit(2);
}
