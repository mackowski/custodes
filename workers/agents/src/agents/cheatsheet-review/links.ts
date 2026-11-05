/**
 * Links a pull request adds (ADR 0017). Internal links and anchors are checked by code; external
 * pages are fetched under tight limits and only their text excerpt reaches the link auditor, inside
 * `untrusted()`. Like upstream's link check, 401/403/429/5xx and timeouts mean "verify manually",
 * never "broken".
 */
import type { DiffLine, Hunk } from './diff.js';

export interface AddedLink {
  url: string;
  file: string;
  line: number;
  /** The added line the link sits in: the claim it is cited for (author text, untrusted). */
  context: string;
  /** The target this link replaced, when its line changed nothing but link targets (#89). */
  previous?: string;
}

export type FetchedLink =
  | { kind: 'page'; status: number; finalUrl: string; title: string; excerpt: string }
  | { kind: 'broken'; status: number }
  | { kind: 'unreachable'; why: string };

export const MAX_EXTERNAL_LINKS = 15;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
export const EXCERPT_CHARS = 8_000;

const MD_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const BARE = /(?<![("])\bhttps?:\/\/[^\s)<>\]"]+/g;

/** Link targets in a line, in order (Markdown links first, then bare URLs, as extractLinks). */
function targets(text: string): string[] {
  return [
    ...[...text.matchAll(MD_LINK)].map((m) => m[1] ?? ''),
    ...[...text.matchAll(BARE)].map((m) => m[0]),
  ].map((u) => u.replace(/[.,;:]+$/, ''));
}

/** Markdown link targets only: a bare URL (code samples, CORS or CSP values) is content, not a citation. */
function citationTargets(text: string): string[] {
  return [...text.matchAll(MD_LINK)].map((m) => (m[1] ?? '').replace(/[.,;:]+$/, ''));
}

/**
 * The line with every Markdown link target replaced, so two lines that differ only in cited
 * targets compare equal. Bare URLs stay: changing one is a content change.
 */
export function maskedLine(text: string): string {
  return text.replace(MD_LINK, '](<target>)');
}

/** https to http is a downgrade, never a "move": such a line is new text (#92 review). */
function downgrades(before: readonly string[], after: readonly string[]): boolean {
  return after.some((u, k) => /^http:/i.test(u) && /^https:/i.test(before[k] ?? ''));
}

export interface LinkScan {
  /** New links (audited as today) and moved links (`previous` set; audited against the old URL). */
  links: AddedLink[];
  /** New-side lines whose only change is a link target: their wording is not part of the PR. */
  targetOnlyLines: Set<number>;
}

/**
 * Links a file's diff adds, with moved links told apart (#89). Within a hunk, an added line that
 * equals a removed line once link targets are masked is a target-only change: an unchanged target
 * there is not audited at all, a changed one is "moved" and keeps its previous URL. Any other added
 * line is new text and its links are audited as before. Pure.
 */
export function scanLinks(file: string, hunks: readonly Hunk[]): LinkScan {
  const links: AddedLink[] = [];
  const targetOnlyLines = new Set<number>();
  const seen = new Set<string>();
  const push = (link: AddedLink) => {
    if (!link.url) return;
    if (seen.has(link.url)) {
      // Cited again for new text: judge it as new (support for the sentence), not only as a move.
      const prior = links.find((x) => x.url === link.url);
      if (prior && link.previous === undefined && prior.previous !== undefined) {
        delete prior.previous;
        prior.line = link.line;
        prior.context = link.context;
      }
      return;
    }
    seen.add(link.url);
    links.push(link);
  };
  for (const h of hunks) {
    const removed = h.lines.filter((l) => l.kind === '-');
    // A target the hunk already had (only the anchor text or the sentence changed) is not new.
    const before = new Set(removed.flatMap((r) => targets(r.text)));
    const used = new Set<number>();
    // Pairs only inside one contiguous block (removed run, then added run), as scope.ts does.
    let block = new Set<number>();
    let afterAdd = false;
    for (const l of h.lines) {
      if (l.kind === ' ') {
        block = new Set();
        afterAdd = false;
        continue;
      }
      if (l.kind === '-') {
        if (afterAdd) {
          block = new Set();
          afterAdd = false;
        }
        block.add(removed.indexOf(l));
        continue;
      }
      afterAdd = true;
      if (l.newLine === undefined) continue;
      const now = targets(l.text);
      const cited = citationTargets(l.text);
      const key = maskedLine(l.text);
      const i = removed.findIndex(
        (r, idx) =>
          block.has(idx) &&
          !used.has(idx) &&
          maskedLine(r.text) === key &&
          citationTargets(r.text).length === cited.length &&
          !downgrades(citationTargets(r.text), cited),
      );
      if (i >= 0 && cited.length > 0) {
        used.add(i);
        const prior = citationTargets(removed[i]?.text ?? '');
        targetOnlyLines.add(l.newLine);
        cited.forEach((url, k) => {
          const previous = prior[k];
          if (previous !== undefined && previous !== url)
            push({ url, file, line: l.newLine ?? 0, context: l.text.slice(0, 600), previous });
        });
        continue;
      }
      for (const url of now)
        if (!before.has(url)) push({ url, file, line: l.newLine, context: l.text.slice(0, 600) });
    }
  }
  return { links, targetOnlyLines };
}

/** Links in added lines, in order, each once. */
export function extractLinks(file: string, added: readonly DiffLine[]): AddedLink[] {
  const out: AddedLink[] = [];
  const seen = new Set<string>();
  for (const l of added) {
    if (l.newLine === undefined) continue;
    const found = [
      ...[...l.text.matchAll(MD_LINK)].map((m) => m[1] ?? ''),
      ...[...l.text.matchAll(BARE)].map((m) => m[0]),
    ];
    for (const raw of found) {
      const url = raw.replace(/[.,;:]+$/, '');
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, file, line: l.newLine, context: l.text.slice(0, 600) });
    }
  }
  return out;
}

export function isExternal(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Python-Markdown's toc slugify, which the published site uses (not GitHub's anchors). */
export function slugify(heading: string): string {
  return heading
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '-');
}

export function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm))
    out.add(slugify(m[1] ?? ''));
  return out;
}

export type InternalCheck =
  { ok: true } | { ok: false; why: 'missing_file' | 'missing_anchor' | 'unsupported' };

/**
 * An internal link from a cheat sheet: `Other_Cheat_Sheet.md`, `Other_Cheat_Sheet.md#anchor` or
 * `#anchor`. `sheets` are the file names under `cheatsheets/`; `headings(file)` the anchors of a
 * file (the changed file's own at the head commit).
 */
export function checkInternal(
  url: string,
  self: string,
  sheets: ReadonlySet<string>,
  headings: (file: string) => ReadonlySet<string> | undefined,
): InternalCheck {
  const [path = '', anchor] = url.split('#', 2);
  const file = path === '' ? self : path.replace(/^\.\//, '');
  if (!/^[A-Za-z0-9_.-]+\.md$/.test(file)) return { ok: false, why: 'unsupported' };
  if (file !== self && !sheets.has(file)) return { ok: false, why: 'missing_file' };
  if (anchor === undefined || anchor === '') return { ok: true };
  const known = headings(file);
  if (known === undefined) return { ok: true };
  return known.has(anchor) ? { ok: true } : { ok: false, why: 'missing_anchor' };
}

/** Hosts never fetched: our own, and anything that is not a public DNS name. */
export function fetchable(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return false;
  if (host === 'custodes.work' || host.endsWith('.custodes.work')) return false;
  if (/^[\d.]+$/.test(host) || host.includes(':')) return false;
  return host.includes('.');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  nbsp: ' ',
};

/** Visible text of an HTML page: no scripts, styles or tags. */
export function pageText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const text = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const decoded = title.replace(
    /&(amp|lt|gt|quot|#39|nbsp);/g,
    (_, e: string) => ENTITIES[e] ?? ' ',
  );
  return { title: decoded.replace(/\s+/g, ' ').trim().slice(0, 200), text };
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = MAX_BYTES - kept;
    chunks.push(value.subarray(0, room));
    kept += Math.min(value.byteLength, room);
    if (kept >= MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }
  const all = new Uint8Array(kept);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** One external page, following at most 5 redirects, each to an https public host. */
export async function fetchLink(url: string, fetchImpl: typeof fetch): Promise<FetchedLink> {
  let current = url;
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!fetchable(current)) return { kind: 'unreachable', why: 'not fetched (host or scheme)' };
      const res = await fetchImpl(current, {
        redirect: 'manual',
        signal: ac.signal,
        headers: {
          'user-agent': 'custodes-cheatsheet-review (+https://github.com/mackowski/custodes)',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        await res.body?.cancel();
        if (!next) return { kind: 'unreachable', why: `redirect ${res.status} without location` };
        current = new URL(next, current).toString();
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel();
        return { kind: 'broken', status: res.status };
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { kind: 'unreachable', why: `HTTP ${res.status}` };
      }
      const type = res.headers.get('content-type') ?? '';
      if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
        await res.body?.cancel();
        return {
          kind: 'page',
          status: res.status,
          finalUrl: current,
          title: '',
          excerpt: `(non-text content: ${type.slice(0, 60) || 'unknown'})`,
        };
      }
      const body = await readCapped(res);
      const { title, text } = /html/i.test(type) ? pageText(body) : { title: '', text: body };
      return {
        kind: 'page',
        status: res.status,
        finalUrl: current,
        title,
        excerpt: text.slice(0, EXCERPT_CHARS),
      };
    }
    return { kind: 'unreachable', why: 'too many redirects' };
  } catch (err) {
    return {
      kind: 'unreachable',
      why: ac.signal.aborted ? 'timeout' : err instanceof Error ? err.name : 'error',
    };
  } finally {
    clearTimeout(timer);
  }
}
