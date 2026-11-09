// Prints the Worker (script) that owns the Durable Object namespace of a class, or nothing if
// there is none. Used by the deploy workflows to refuse a deploy that would contradict a cutover
// (ADR 0018, docs/runbooks/pr-gate-cutover.md).
//
// Usage: node --experimental-strip-types scripts/do-namespace-owner.ts <ClassName>
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Prints ids only, never the token.

interface Namespace {
  class?: string;
  script?: string;
}
interface Page {
  success: boolean;
  result?: Namespace[];
}

const className = process.argv[2] ?? '';
const token = process.env['CLOUDFLARE_API_TOKEN'];
const account = process.env['CLOUDFLARE_ACCOUNT_ID'];
if (!/^[A-Za-z][A-Za-z0-9]*$/.test(className) || !token || !account) {
  console.error(
    'usage: do-namespace-owner.ts <ClassName> (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)',
  );
  process.exit(2);
}

const owners = new Set<string>();
for (let page = 1; page <= 50; page++) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/durable_objects/namespaces?page=${page}&per_page=100`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const body = (await res.json()) as Page;
  if (!res.ok || !body.success) {
    console.error(`Cloudflare API refused the namespace list (HTTP ${res.status})`);
    process.exit(1);
  }
  for (const ns of body.result ?? [])
    if (ns.class === className && ns.script) owners.add(ns.script);
  // The API reports page and count but not total_pages (checked 2026-11-09): stop on a short page.
  if ((body.result ?? []).length < 100) break;
}
if (owners.size > 1) {
  console.error(`more than one namespace for ${className}: ${[...owners].join(', ')}`);
  process.exit(1);
}
console.log([...owners][0] ?? '');
