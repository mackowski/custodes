/**
 * Links a pull request adds (ADR 0017). Internal links and anchors are checked by code; external
 * pages are fetched under tight limits and only their text excerpt reaches the link auditor, inside
 * `untrusted()`. Like upstream's link check, 401/403/429/5xx and timeouts mean "verify manually",
 * never "broken".
 */
import { cutWhole } from '@custodes/llm';
import type { Hunk } from './diff.js';

export interface AddedLink {
  url: string;
  file: string;
  line: number;
  /** The added line the link sits in: the claim it is cited for (author text, untrusted). */
  context: string;
  /** The target this link replaced, when its line changed nothing but link targets (#89). */
  previous?: string;
  /**
   * The target this link replaced on another site. Display only: the link is audited as new,
   * because a cross-site "move" is not trusted to be the same resource (sameSite).
   */
  replaced?: string;
  /**
   * Found in link markup other than an inline Markdown link: a reference definition or an HTML
   * href/src value (#95). Inside a fenced code block that is a code sample, not a rendered link.
   */
  markup?: true;
  /** Further new sentences that cite the same URL (`citeAgain`); author text, untrusted. */
  more?: { file: string; line: number; context: string }[];
  /** Further citing sentences past the limit: not audited, listed for a manual check. */
  unaudited?: { file: string; line: number }[];
  /** Places where this URL only replaced an older target, while it is audited as new here. */
  movedAt?: { file: string; line: number; previous: string }[];
}

/** Sentences audited for one URL: the first place and this many more that cite it again. */
export const MAX_EXTRA_CITATIONS = 5;

/**
 * The same URL cited again for new text, in this file or another: the auditor answers once per
 * URL, so the further sentence is judged with the first one's. Without this a true sentence at
 * the first place would cover a false claim at the second. Past the limit the sentence is counted
 * in `unaudited`, and the review says so.
 */
function citeAgain(prior: AddedLink, link: AddedLink): void {
  // A move that is not the one audited here (this place is audited as new, or as another move).
  if (link.previous !== undefined && link.previous !== prior.previous) {
    // Audited as new for its sentence; the move elsewhere is not judged, and the review says so.
    prior.movedAt = [
      ...(prior.movedAt ?? []),
      { file: link.file, line: link.line, previous: link.previous },
    ];
    return;
  }
  if (link.previous !== undefined || link.markup || prior.previous !== undefined) return;
  const more = prior.more ?? [];
  if (link.context === prior.context || more.some((m) => m.context === link.context)) return;
  if (more.length >= MAX_EXTRA_CITATIONS)
    prior.unaudited = [...(prior.unaudited ?? []), { file: link.file, line: link.line }];
  else prior.more = [...more, { file: link.file, line: link.line, context: link.context }];
}

/**
 * A URL seen again, in the same file or in another sheet: which place and sentence it is audited
 * at. One rule for both, in this order: new text wins over "only its target moved" (the page must
 * support the claim, not just be the same resource); a sentence wins over other markup (a
 * reference definition, a code sample); any further new sentence is judged too (`citeAgain`).
 */
export function mergeCitation(prior: AddedLink, link: AddedLink): void {
  // Display only: whichever citation swapped the target from another site, the table shows it.
  if (link.replaced !== undefined) prior.replaced ??= link.replaced;
  const newOverMoved = link.previous === undefined && prior.previous !== undefined;
  const sentenceOverMarkup = prior.markup === true && !link.markup;
  if (!newOverMoved && !sentenceOverMarkup) {
    citeAgain(prior, link);
    return;
  }
  if (newOverMoved && prior.previous !== undefined) {
    // The move is no longer what is judged here: keep it for the review's manual list.
    prior.movedAt = [
      ...(prior.movedAt ?? []),
      { file: prior.file, line: prior.line, previous: prior.previous },
    ];
    delete prior.previous;
  }
  if (sentenceOverMarkup) delete prior.markup;
  prior.file = link.file;
  prior.line = link.line;
  prior.context = link.context;
}

/** What the auditor reads for a link: its sentence and the further ones that cite the same URL. */
export function citedText(link: AddedLink): string {
  return [
    link.context,
    ...(link.more ?? []).map((m) => `Also cited in ${m.file} line ${m.line}: ${m.context}`),
  ].join('\n');
}

export type FetchedLink =
  | { kind: 'page'; status: number; finalUrl: string; title: string; excerpt: string }
  | { kind: 'broken'; status: number }
  | { kind: 'unreachable'; why: string };

export const MAX_EXTERNAL_LINKS = 15;
/** How a fetched file that is not text (a PDF, an image) starts its excerpt. */
export const NON_TEXT_MARK = '(non-text content';
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** #155: like the original OWASP command, the link auditor reads most of a page. */
export const EXCERPT_CHARS = 40_000;
/** #155: all page excerpts in one link-audit call together. */
export const LINK_AUDIT_CHARS = 160_000;
/** #155: the top of the page kept in front of an anchored excerpt. */
export const PAGE_TOP_CHARS = 500;

const MD_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
// Bare URLs (prose in parentheses, autolinks, href and src values). Run on text with the Markdown
// links MD_LINK read already removed (withoutMdLinks), so only those are skipped: a link MD_LINK
// cannot parse is still audited.
const BARE = /\bhttps?:\/\/[^\s)<>\]"']+/g;
const withoutMdLinks = (t: string) => t.replace(MD_LINK, ' ');

/** Inline code: n-backtick spans (CommonMark) and <code> elements. Markup inside them is text. */
export const CODE_SPAN = /(?<!`)(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|<code>[\s\S]*?<\/code>/gi;
/** A reference-style link definition, `[label]: <dest> "title"`, at the start of a line (#95). */
const REF_DEF = /^( {0,3}\[[^\]\n]+\]:[ \t]*<?)([^\s>]+)/;
/**
 * An HTML href or src value, quoted or not (#95). Taken as written: an entity-encoded scheme stays
 * encoded, so knownTargetForm refuses it and the link is verified by hand.
 */
const HTML_ATTR =
  /(\b(?:href|src|srcset|action|formaction|poster)[ \t]*=[ \t]*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const trailing = (u: string) => u.replace(/[.,;:]+$/, '');

/** Targets of link markup other than inline Markdown links, outside inline code (#95). */
function markupTargets(text: string): string[] {
  const outside = text.replace(CODE_SPAN, ' ');
  const ref = REF_DEF.exec(outside)?.[2];
  const attrs = [...outside.matchAll(HTML_ATTR)].flatMap((m) => {
    const value = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    // srcset lists "url width, url width": each URL is a target (review of #125, L4).
    return /^srcset/i.test(m[1] ?? '')
      ? value.split(',').map((c) => c.trim().split(/\s+/)[0] ?? '')
      : [value];
  });
  return [...(ref === undefined ? [] : [ref]), ...attrs].filter((u) => u !== '');
}

/** Link targets in a line, in order (Markdown links, other link markup, then bare URLs), each once. */
export function targets(text: string): string[] {
  return [
    ...new Set(
      [
        ...[...text.matchAll(MD_LINK)].map((m) => m[1] ?? ''),
        ...markupTargets(text),
        ...[...withoutMdLinks(text).matchAll(BARE)].map((m) => m[0]),
      ].map(trailing),
    ),
  ];
}

/**
 * Targets of link markup: inline Markdown links, reference definitions and HTML href/src values
 * (#95). A bare URL (code samples, CORS or CSP values) is content, not a citation.
 */
export function citationTargets(text: string): string[] {
  return [...[...text.matchAll(MD_LINK)].map((m) => m[1] ?? ''), ...markupTargets(text)].map(
    trailing,
  );
}

/**
 * The line with every inline Markdown link target replaced, so two lines that differ only in cited
 * targets compare equal. Bare URLs, reference definitions and href/src values stay: changing one is
 * a content change and gets the full review (#92 round 10), while #95 still audits them as links.
 */
export function maskedLine(text: string): string {
  // Only the target: a changed link title is a text change, never a link change (#92 round 12).
  return text.replace(MD_LINK, (m, u: string) => m.replace(u, '<target>'));
}

/**
 * Link targets a cheat sheet may use, as an allow-list: an http(s) URL, a sibling cheat sheet with
 * an optional anchor, an anchor, or an image under assets. Anything else (//host, entity-encoded
 * slashes, backslashes, other schemes) is "verify by hand" and the change gets the full review.
 */
export function knownTargetForm(target: string): boolean {
  return (
    // The host part is plain (no backslash, entity, @ or userinfo): what we fetch is what renders.
    (/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:[/?#][^\s\\]*)?$/i.test(target) &&
      !/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(target)) ||
    /^(\.\/)?[A-Za-z0-9_.-]+\.md(#[A-Za-z0-9_-]*)?$/.test(target) ||
    /^#[A-Za-z0-9_-]+$/.test(target) ||
    /^(\.\.\/)*(\.\/)?assets\/[A-Za-z0-9_./-]+\.(png|jpe?g|gif|svg|webp)$/i.test(target)
  );
}

/** A GitHub organisation and the one domain it owns, for moves between the two (#2880). */
const ORG_DOMAINS: Readonly<Record<string, string>> = { owasp: 'owasp.org' };
/** Hosts where the first path segment is the owner: a different owner is a different site. */
const OWNER_HOSTS = new Set([
  'github.com',
  'gist.github.com',
  'raw.githubusercontent.com',
  'gitlab.com',
  'bitbucket.org',
  // Path tenants: medium.com/@user and hackmd.io/@user are anyone's pages (#95).
  'medium.com',
  'hackmd.io',
]);
/** Hosts that serve anyone's copy of anything: never "the same site" as anything. */
const NEVER_SAME = new Set([
  'web.archive.org',
  'archive.org',
  'archive.ph',
  'archive.today',
  // archive.today's mirrors (#95).
  'archive.is',
  'archive.li',
  'archive.vn',
  'archive.md',
]);

/** "github:<owner>" for GitHub-hosted URLs, otherwise the exact host without a leading www. */
function siteOf(u: URL): string {
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (NEVER_SAME.has(host)) return '';
  if (OWNER_HOSTS.has(host)) {
    const owner = (u.pathname.split('/')[1] ?? '').toLowerCase();
    // GitHub hosts share one owner namespace; every other host has its own.
    const ns =
      host === 'gist.github.com' || host === 'raw.githubusercontent.com' || host === 'github.com'
        ? 'github'
        : host;
    return owner ? `${ns}:${owner}` : '';
  }
  const pages = /^([a-z0-9-]+)\.github\.io$/.exec(host);
  if (pages) return `github:${pages[1] ?? ''}`;
  return host;
}

/**
 * The same site, so a changed target can be a "move" (Claude review and round 13 on #92): the exact
 * same host, the same owner on GitHub hosts, or a listed GitHub organisation and its own domain
 * (github.com/OWASP and owasp.org). Anything else, including other tenants of a shared host and
 * lookalike domains, is a new source and is audited as new.
 */
export function sameSite(a: string, b: string): boolean {
  try {
    const x = siteOf(new URL(a));
    const y = siteOf(new URL(b));
    if (x === y) return x !== '';
    const pair = (g: string, h: string) => g.startsWith('github:') && ORG_DOMAINS[g.slice(7)] === h;
    return pair(x, y) || pair(y, x);
  } catch {
    return false;
  }
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
  /** Added lines too long to scan for links (MAX_LINK_LINE): verified by hand, never skipped. */
  longLines: number[];
}

/** Longer lines are not scanned (the link patterns are not linear on hostile input); flagged instead. */
export const MAX_LINK_LINE = 4_000;

/**
 * Links a file's diff adds, with moved links told apart (#89). Within a hunk, an added line that
 * equals a removed line once link targets are masked is a target-only change: an unchanged target
 * there is not audited at all, a changed one is "moved" and keeps its previous URL. Any other added
 * line is new text and its links are audited as before. Pure.
 */
export function scanLinks(
  file: string,
  hunks: readonly Hunk[],
  /** New-side lines inside fenced code (scope.ts fencedLines); null or absent: none known. */
  codeLines?: ReadonlySet<number> | null,
): LinkScan {
  const links: AddedLink[] = [];
  const targetOnlyLines = new Set<number>();
  const longLines: number[] = [];
  const seen = new Set<string>();
  const push = (link: AddedLink) => {
    if (!link.url) return;
    if (seen.has(link.url)) {
      const prior = links.find((x) => x.url === link.url);
      if (prior) mergeCitation(prior, link);
      return;
    }
    seen.add(link.url);
    links.push(link);
  };
  for (const h of hunks) {
    const removed = h.lines.filter((l) => l.kind === '-');
    const used = new Set<number>();
    // Pairs only inside one contiguous block (removed run, then added run), as scope.ts does.
    let block = new Set<number>();
    let afterAdd = false;
    const scannable = (t: string) => t.length <= MAX_LINK_LINE;
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
      if (!scannable(l.text)) {
        longLines.push(l.newLine);
        continue;
      }
      // Link markup on this line, computed once (review of #125, M3). An href/src or reference
      // definition inside fenced code is a code sample, dropped here before any deduplication so it
      // never hides a real citation of the same URL (M1); an http(s) target is never dropped, as
      // the bare-URL scan always audited it (M2).
      const markup = new Set(markupTargets(l.text).map(trailing));
      const inCode = codeLines?.has(l.newLine) === true;
      // Never an http(s) or protocol-relative target: those render as live links (L-a).
      const sample = (url: string) => inCode && markup.has(url) && !/^(?:https?:)?\/\//i.test(url);
      const flag = (url: string) => (markup.has(url) ? { markup: true as const } : {});
      const now = targets(l.text).filter((u) => !sample(u));
      const cited = citationTargets(l.text);
      const key = maskedLine(l.text);
      const i = removed.findIndex(
        (r, idx) =>
          block.has(idx) &&
          !used.has(idx) &&
          scannable(r.text) &&
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
          if (previous === undefined || previous === url || sample(url)) return;
          const base = {
            url,
            file,
            line: l.newLine ?? 0,
            context: l.text.slice(0, 600),
            ...flag(url),
          };
          push(sameSite(previous, url) ? { ...base, previous } : { ...base, replaced: previous });
        });
        continue;
      }
      // A target the same block already had (only the anchor text changed) is not new.
      const blockTargets = new Set(
        [...block].flatMap((idx) => {
          const t = removed[idx]?.text ?? '';
          return scannable(t) ? targets(t) : [];
        }),
      );
      for (const url of now)
        if (!blockTargets.has(url))
          push({
            url,
            file,
            line: l.newLine,
            context: l.text.slice(0, 600),
            ...flag(url),
          });
    }
  }
  return { links, targetOnlyLines, longLines };
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
  // A fully qualified name ("custodes.work.", "localhost.") is the same host: check it without the dot.
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return false;
  if (host === 'custodes.work' || host.endsWith('.custodes.work')) return false;
  // GitHub's API is read through the broker only (invariant 1), and Workers are not sources; on
  // every hop of every fetch (security review of #155).
  if (
    host === 'api.github.com' ||
    host === 'uploads.github.com' ||
    host === 'workers.dev' ||
    host.endsWith('.workers.dev')
  )
    return false;
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

// The name must end there: <svg-icon> or <template-row> is an ordinary tag, not a hidden block.
const HIDDEN_BLOCK = /^<(script|style|noscript|svg|template)(?=[\s/>])/i;

/**
 * `html` without comments, hidden blocks (script, style, noscript, svg, template) and tags, in one
 * pass. The page is chosen by the PR author: regexes with a lazy `[\s\S]*?` or `<[^>]+>` rescan
 * to the end from every unclosed opener, which is quadratic and can use up the Worker's CPU limit
 * (200 KB of `<svg ` took 3.6 s). Here an unclosed comment or hidden block drops the rest of the
 * page, and a `<` with no `>` after it ends the scan, so every search to the end happens once.
 */
function stripMarkup(html: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    out.push(html.slice(i, lt));
    let end: number;
    const block = HIDDEN_BLOCK.exec(html.slice(lt, lt + 10));
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      end = close < 0 ? -1 : close + 3;
    } else if (block?.[1] !== undefined) {
      const closer = new RegExp(`</${block[1]}>`, 'gi');
      closer.lastIndex = lt;
      end = closer.exec(html) ? closer.lastIndex : -1;
    } else {
      const gt = html.indexOf('>', lt + 1);
      if (gt < 0) {
        // No tag can close any more: the rest is text.
        out.push(html.slice(lt));
        return out.join('');
      }
      if (gt === lt + 1) {
        // "<>" is not a tag.
        out.push('<');
        i = lt + 1;
        continue;
      }
      end = gt + 1;
    }
    if (end < 0) return out.join('');
    out.push(' ');
    i = end;
  }
  out.push(html.slice(i));
  return out.join('');
}

/** The first <title>'s content, found without a regex that rescans (see stripMarkup). */
function rawTitle(html: string): string {
  const open = html.search(/<title/i);
  if (open < 0) return '';
  const gt = html.indexOf('>', open);
  if (gt < 0) return '';
  const closer = /<\/title>/gi;
  closer.lastIndex = gt;
  const m = closer.exec(html);
  return m ? html.slice(gt + 1, m.index) : '';
}

/** Visible text of an HTML page: no scripts, styles or tags. */
export function pageText(html: string): { title: string; text: string } {
  const title = rawTitle(html);
  const text = stripMarkup(html)
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const decoded = title.replace(
    /&(amp|lt|gt|quot|#39|nbsp);/g,
    (_, e: string) => ENTITIES[e] ?? ' ',
  );
  return { title: cutWhole(decoded.replace(/\s+/g, ' ').trim(), 200), text };
}

/**
 * The visible text from the element a URL's `#fragment` names (`id` or `name`) onwards, or
 * undefined when the URL has no fragment or the page has no such element (#155). Without it the
 * reader sees the first 8,000 characters, and a cited section further down reads as missing (OWASP
 * PRs 2955, 2956: the anchors existed). The search is one bounded regex over the raw HTML.
 */
export function anchorText(html: string, url: string): string | undefined {
  let fragment: string;
  try {
    fragment = decodeURIComponent(new URL(url).hash.slice(1));
  } catch {
    return undefined;
  }
  if (fragment === '' || fragment.length > 200) return undefined;
  const esc = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `id` on any element, `name` only on <a>: browsers scroll to nothing else (ninth security review).
  const m =
    new RegExp(`<[a-z][^<>]{0,500}?\\sid\\s*=\\s*["']?${esc}(?=["'\\s>/])`, 'i').exec(html) ??
    new RegExp(`<a\\b[^<>]{0,500}?\\sname\\s*=\\s*["']?${esc}(?=["'\\s>/])`, 'i').exec(html);
  if (!m) return undefined;
  const start = m[0].startsWith('<') ? m.index : html.lastIndexOf('<', m.index);
  return start < 0 ? undefined : pageText(html.slice(start)).text;
}

/** The marker an anchored excerpt starts with, so a reader knows where it begins. */
export const anchorMark = (url: string) => `[from #${new URL(url).hash.slice(1, 81)}] `;

/** At most `max` bytes of the body; `over` when the body had more. */
async function readBytes(
  res: Response,
  max: number,
): Promise<{ bytes: Uint8Array; over: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), over: false };
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let over = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - kept;
    if (value.byteLength > room) over = true;
    chunks.push(value.subarray(0, room));
    kept += Math.min(value.byteLength, room);
    if (kept >= max) {
      // Exactly full: one more read tells whether anything is left.
      if (!over) over = !(await reader.read()).done;
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
  return { bytes: all, over };
}

async function readCapped(res: Response): Promise<string> {
  return new TextDecoder().decode((await readBytes(res, MAX_BYTES)).bytes);
}

type Opened =
  { kind: 'open'; res: Response; finalUrl: string } | Exclude<FetchedLink, { kind: 'page' }>;

/**
 * GET `url`, following at most 5 redirects, each re-checked by `fetchable` (https, public DNS name,
 * not ours). 404 and 410 are broken; any other non-2xx is unreachable. The caller reads the body.
 */
async function open(url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<Opened> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!fetchable(current)) return { kind: 'unreachable', why: 'not fetched (host or scheme)' };
    const res = await fetchImpl(current, {
      redirect: 'manual',
      signal,
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
    return { kind: 'open', res, finalUrl: current };
  }
  return { kind: 'unreachable', why: 'too many redirects' };
}

const failure = (err: unknown, signal: AbortSignal): string =>
  signal.aborted ? 'timeout' : err instanceof Error ? err.name : 'error';

/** One external page, following at most 5 redirects, each to an https public host. */
export async function fetchLink(url: string, fetchImpl: typeof fetch): Promise<FetchedLink> {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, TIMEOUT_MS);
  try {
    const got = await open(url, fetchImpl, ac.signal);
    if (got.kind !== 'open') return got;
    const { res, finalUrl } = got;
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      await res.body?.cancel();
      return {
        kind: 'page',
        status: res.status,
        finalUrl,
        title: '',
        excerpt: `${NON_TEXT_MARK}: ${type.slice(0, 60) || 'unknown'})`,
      };
    }
    const body = await readCapped(res);
    const { title, text } = /html/i.test(type) ? pageText(body) : { title: '', text: body };
    const anchored = /html/i.test(type) ? anchorText(body, url) : undefined;
    return {
      kind: 'page',
      status: res.status,
      finalUrl,
      title,
      // The page's first lines stay in front (an RFC's "Obsoleted by" banner, ninth security review).
      excerpt: cutWhole(
        anchored !== undefined
          ? `${cutWhole(text, PAGE_TOP_CHARS)} … ${anchorMark(url)}${anchored}`
          : text,
        EXCERPT_CHARS,
      ),
    };
  } catch (err) {
    return { kind: 'unreachable', why: failure(err, ac.signal) };
  } finally {
    clearTimeout(timer);
  }
}

/** #90: PDFs up to this size go to Workers AI `toMarkdown`; HTML and text keep MAX_BYTES. */
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
/** #90: the PDF conversion gets its own bound; a hung conversion is NOT-FOUND, not a stuck review. */
export const CONVERT_TIMEOUT_MS = 15_000;

/** Workers AI `toMarkdown` for one file, injected (tests stay deterministic). */
export type ToMarkdown = (
  name: string,
  blob: Blob,
) => Promise<{ format: string; data?: string; error?: string }>;

/**
 * The full text of a claim's source (#90). The reason on failure is a code-written phrase (never
 * page or error text): it is shown to the maintainer and logged.
 */
export type SourceDoc =
  { kind: 'text'; text: string; format: 'html' | 'text' | 'pdf' } | { kind: 'failed'; why: string };

/**
 * One claim source, with fetchLink's limits (redirects re-checked, 10 s, 2 MB for HTML and text).
 * A PDF (by content type) is read up to 10 MB and converted by `toMarkdown`; anything else is
 * refused. The 10 s cover the download; the conversion runs after it.
 */
export async function fetchSource(
  url: string,
  fetchImpl: typeof fetch,
  toMarkdown: ToMarkdown,
  convertTimeoutMs = CONVERT_TIMEOUT_MS,
): Promise<SourceDoc> {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, TIMEOUT_MS);
  let pdf: Uint8Array;
  try {
    const got = await open(url, fetchImpl, ac.signal);
    if (got.kind === 'broken') return { kind: 'failed', why: `HTTP ${got.status}` };
    if (got.kind === 'unreachable') return { kind: 'failed', why: got.why };
    const { res } = got;
    const type = res.headers.get('content-type') ?? '';
    if (/text\/html|application\/xhtml/i.test(type)) {
      const html = await readCapped(res);
      const text = pageText(html).text;
      // #155: the cited section first, then the whole page, so a locator is found there first.
      const anchored = anchorText(html, url);
      return {
        kind: 'text',
        text: anchored !== undefined ? `${anchorMark(url)}${anchored}\n…\n${text}` : text,
        format: 'html',
      };
    }
    if (/text\/plain/i.test(type))
      return { kind: 'text', text: await readCapped(res), format: 'text' };
    if (!/application\/pdf/i.test(type)) {
      await res.body?.cancel();
      return { kind: 'failed', why: 'unsupported content type' };
    }
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > PDF_MAX_BYTES) {
      await res.body?.cancel();
      return { kind: 'failed', why: 'PDF larger than 10 MB' };
    }
    const read = await readBytes(res, PDF_MAX_BYTES);
    if (read.over) return { kind: 'failed', why: 'PDF larger than 10 MB' };
    pdf = read.bytes;
  } catch (err) {
    return { kind: 'failed', why: failure(err, ac.signal) };
  } finally {
    clearTimeout(timer);
  }
  let stop: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    stop = setTimeout(() => {
      resolve('timeout');
    }, convertTimeoutMs);
  });
  try {
    // A fixed name: nothing from the URL reaches the converter but the bytes.
    const out = await Promise.race([
      toMarkdown('source.pdf', new Blob([pdf], { type: 'application/pdf' })),
      timedOut,
    ]);
    if (out === 'timeout') return { kind: 'failed', why: 'PDF conversion timed out' };
    if (out.format === 'error' || typeof out.data !== 'string')
      return { kind: 'failed', why: 'PDF conversion error' };
    return { kind: 'text', text: out.data, format: 'pdf' };
  } catch {
    return { kind: 'failed', why: 'PDF conversion failed' };
  } finally {
    clearTimeout(stop);
  }
}
