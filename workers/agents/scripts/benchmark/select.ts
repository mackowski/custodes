/**
 * Step 1: choose 30 historical OWASP pull requests and freeze a snapshot of each (grill-plan Q1).
 *
 * External authors only (not OWNER/MEMBER/COLLABORATOR, not bots), closed in the last 12 months,
 * touching a cheat sheet. Strata, newest first:
 * - clean (10): merged, a maintainer approved, no maintainer inline comment or CHANGES_REQUESTED;
 * - fixed (12): merged after maintainer inline comments or CHANGES_REQUESTED;
 * - closed (8): not merged, closed after a maintainer review or comment.
 * The snapshot is taken at the commit of the first maintainer review (or the head for a closed PR
 * with only comments), so the issues maintainers found are still in the diff. Ground truth: the
 * maintainers' words (inline comments, review bodies, closing comments), stored as untrusted text.
 */
import { CheatSheetPath } from '@custodes/schema';
import { disclosure } from '../../src/agents/pr-gate/rules.js';
import { relatedSheets } from '../../src/agents/cheatsheet-review/input.js';
import { REPO, dataPath, decodeContent, exists, gh, ghAll, writeJson } from './common.js';

export type Stratum = 'clean' | 'fixed' | 'closed';

export interface MaintainerNote {
  id: string;
  kind: 'inline' | 'review' | 'comment';
  path?: string;
  line?: number;
  text: string;
}

export interface FrozenPull {
  pull: number;
  stratum: Stratum;
  merged: boolean;
  sha: string;
  base: string;
  title: string;
  body: string;
  author: string;
  disclosure: ReturnType<typeof disclosure>;
  /** `pull_files`-shaped entries for the base...sha comparison. */
  files: {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }[];
  contents: [string, string][];
  sheetNames: string[];
  related: [string, string][];
  notes: MaintainerNote[];
}

const MAINTAINER = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const QUOTA: Record<Stratum, number> = { clean: 10, fixed: 12, closed: 8 };
const SINCE = '2025-10-29T00:00:00Z';

interface Pull {
  number: number;
  title: string;
  body: string | null;
  user: { login: string; type: string };
  author_association: string;
  merged_at: string | null;
  closed_at: string | null;
  base: { sha: string };
  head: { sha: string };
}
interface Review {
  user: { login: string; type: string } | null;
  author_association: string;
  state: string;
  body: string | null;
  commit_id: string;
  submitted_at: string;
  id: number;
}
interface ReviewComment {
  user: { login: string } | null;
  author_association: string;
  path: string;
  line: number | null;
  original_line: number | null;
  body: string;
  commit_id: string;
  original_commit_id: string;
  id: number;
}
interface IssueComment {
  user: { login: string; type: string } | null;
  author_association: string;
  body: string | null;
  created_at: string;
  id: number;
}

function lineOf(c: ReviewComment): { line?: number } {
  const line = c.original_line ?? c.line;
  return line ? { line } : {};
}

function stratumOf(
  p: Pull,
  reviews: Review[],
  inline: ReviewComment[],
  comments: IssueComment[],
): Stratum | null {
  const m = reviews.filter((r) => r.user?.type !== 'Bot' && MAINTAINER.has(r.author_association));
  const mi = inline.filter((c) => MAINTAINER.has(c.author_association));
  if (p.merged_at) {
    const objections = mi.length > 0 || m.some((r) => r.state === 'CHANGES_REQUESTED');
    if (objections) return 'fixed';
    return m.some((r) => r.state === 'APPROVED') ? 'clean' : null;
  }
  const said =
    m.length > 0 ||
    comments.some((c) => c.user?.type !== 'Bot' && MAINTAINER.has(c.author_association));
  return said ? 'closed' : null;
}

async function freeze(
  p: Pull,
  stratum: Stratum,
  reviews: Review[],
  inline: ReviewComment[],
  comments: IssueComment[],
  sheetNames: string[],
): Promise<FrozenPull | null> {
  const m = reviews
    .filter((r) => r.user?.type !== 'Bot' && MAINTAINER.has(r.author_association))
    .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
  const first =
    stratum === 'fixed'
      ? (m.find(
          (r) =>
            r.state === 'CHANGES_REQUESTED' ||
            inline.some((c) => c.original_commit_id === r.commit_id),
        ) ?? m[0])
      : m[0];
  const sha = first?.commit_id ?? p.head.sha;
  const cmp = await gh<{ files?: FrozenPull['files'] }>(
    `/repos/${REPO}/compare/${p.base.sha}...${sha}`,
  );
  const files = (cmp.files ?? []).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    ...(f.patch !== undefined ? { patch: f.patch } : {}),
  }));
  const sheets = files.filter(
    (f) => CheatSheetPath.safeParse(f.filename).success && f.status !== 'removed',
  );
  if (sheets.length === 0) return null;
  const contents: [string, string][] = [];
  for (const f of sheets.slice(0, 5)) {
    const c = await gh<{ content: string }>(
      `/repos/${REPO}/contents/${f.filename.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`,
    );
    contents.push([f.filename, decodeContent(c.content)]);
  }
  const related: [string, string][] = [];
  for (const name of relatedSheets(
    contents.map(([n]) => n),
    sheetNames,
  )) {
    const c = await gh<{ content: string }>(
      `/repos/${REPO}/contents/cheatsheets/${encodeURIComponent(name)}?ref=${sha}`,
    ).catch(() => null);
    if (c) related.push([name, decodeContent(c.content)]);
  }
  const notes: MaintainerNote[] = [];
  for (const c of inline.filter((x) => MAINTAINER.has(x.author_association)))
    notes.push({
      id: `i${c.id}`,
      kind: 'inline',
      path: c.path,
      ...lineOf(c),
      text: c.body.slice(0, 2_000),
    });
  for (const r of m.filter((x) => (x.body ?? '').trim().length > 0))
    notes.push({ id: `r${r.id}`, kind: 'review', text: (r.body ?? '').slice(0, 2_000) });
  for (const c of comments.filter(
    (x) => x.user?.type !== 'Bot' && MAINTAINER.has(x.author_association) && (x.body ?? '').trim(),
  ))
    notes.push({ id: `c${c.id}`, kind: 'comment', text: (c.body ?? '').slice(0, 2_000) });
  return {
    pull: p.number,
    stratum,
    merged: p.merged_at !== null,
    sha,
    base: p.base.sha,
    title: p.title,
    body: p.body ?? '',
    author: p.user.login,
    disclosure: disclosure(p.body),
    files,
    contents,
    sheetNames,
    related,
    notes,
  };
}

const sheetNames = (await gh<{ name: string }[]>(`/repos/${REPO}/contents/cheatsheets`)).map(
  (x) => x.name,
);
const closed = (
  await ghAll<Pull>(`/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc`, 8)
)
  .filter(
    (p) =>
      (p.closed_at ?? '') >= SINCE &&
      !MAINTAINER.has(p.author_association) &&
      p.user.type !== 'Bot' &&
      !p.user.login.endsWith('[bot]'),
  )
  .sort((a, b) => b.number - a.number);
const taken: Record<Stratum, number> = { clean: 0, fixed: 0, closed: 0 };
const chosen: { pull: number; stratum: Stratum }[] = [];
for (const p of closed) {
  if (Object.entries(QUOTA).every(([s, q]) => taken[s as Stratum] >= q)) break;
  const out = dataPath('snapshots', `${p.number}.json`);
  const [reviews, inline, comments] = await Promise.all([
    gh<Review[]>(`/repos/${REPO}/pulls/${p.number}/reviews?per_page=100`),
    gh<ReviewComment[]>(`/repos/${REPO}/pulls/${p.number}/comments?per_page=100`),
    gh<IssueComment[]>(`/repos/${REPO}/issues/${p.number}/comments?per_page=100`),
  ]);
  // pr-gate closes as the operator's account (an OWASP MEMBER) for process reasons, not content:
  // its PRs say nothing about review quality.
  if ([...reviews, ...comments].some((x) => (x.body ?? '').includes('Custodes-Agent'))) continue;
  const s = stratumOf(p, reviews, inline, comments);
  if (!s || taken[s] >= QUOTA[s]) continue;
  if (!exists(out)) {
    const frozen = await freeze(p, s, reviews, inline, comments, sheetNames);
    if (!frozen) continue;
    writeJson(out, frozen);
  }
  taken[s]++;
  chosen.push({ pull: p.number, stratum: s });
  console.log(`#${p.number} ${s}`);
}
writeJson(dataPath('sample.json'), chosen);
console.log(`chosen ${chosen.length}: ${JSON.stringify(taken)}`);
