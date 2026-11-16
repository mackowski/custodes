/**
 * Claim verification (#90, ADR 0017 amendment 2026-11-16). A reviewer finding may carry a `claim`
 * about what a cited source says. Code checks it against that source, never against a URL the model
 * chose: only URLs that are links in the pull request's cheat sheets are fetched. The verifier gets
 * the text around the locator inside `untrusted()`, and code applies the verdict to the finding:
 *
 * - CONFIRMED keeps the finding, marked "verified against <host>, <locator>";
 * - NOT-FOUND moves it out of the review into "Claims to verify manually";
 * - REFUTED removes it from the review and records it for the operator.
 *
 * Every failure (no PR link, over the limit, fetch, PDF, verifier) is NOT-FOUND with a code-written
 * reason: an error never removes or confirms a finding, and the review always goes on. The judge
 * cannot bring back a removed finding: `enforceClaims` runs on its answer.
 */
import { inertText } from '@custodes/llm';
import { claimMessage, type ClaimInput, type JudgeClaim, type Snapshot } from './input.js';
import {
  fetchable,
  isExternal,
  knownTargetForm,
  MAX_LINK_LINE,
  targets,
  type SourceDoc,
} from './links.js';
import type { RoleOutcome } from './lineup.js';
import { VERIFIER_PROMPT } from './prompts.js';
import { runRole, type RunnerDeps } from './runner.js';
import { isSheet, type ReviewerRole } from './scope.js';
import {
  ClaimCheck,
  type Claim,
  type ClaimVerdict,
  type Dimension,
  type Finding,
  type Item,
  type ReviewDecision,
  type ReviewerReport,
} from './types.js';

/** Claims checked per review, BLOCKER first, then MAJOR (then MINOR, NIT). */
export const MAX_CLAIMS = 5;
/** Characters of source text on each side of the locator. */
export const AROUND_CHARS = 3_000;
/** Characters from the start of the source when the locator is not in it. */
export const HEAD_CHARS = 6_000;

export type ClaimedFinding = Finding & { claim: Claim };

export interface ClaimResult {
  role: ReviewerRole;
  /** The finding's index in its reviewer's report: with `role`, the id used in logs. */
  index: number;
  finding: ClaimedFinding;
  verdict: ClaimVerdict;
  /** Host of the PR link the claim cites, when it cites one. */
  host?: string;
  /** Code found the locator in the source text. */
  found?: boolean;
  /** `code`: a fixed phrase written by code. `verifier`: the model's sentence (rendered inert, never logged). */
  by: 'code' | 'verifier';
  reason: string;
}

export interface ClaimDeps extends RunnerDeps {
  fetchSource: (url: string) => Promise<SourceDoc>;
}

export interface ClaimStageResult {
  results: ClaimResult[];
  outcome: RoleOutcome | undefined;
  injectionSeen: boolean;
}

const RANK: Readonly<Record<Finding['severity'], number>> = {
  BLOCKER: 0,
  MAJOR: 1,
  MINOR: 2,
  NIT: 3,
};

/** The lines of the cheat sheet diffs and of the changed cheat sheets at the head commit. */
function sheetLines(snap: Snapshot): string[] {
  const out: string[] = [];
  for (const f of snap.files) {
    if (!isSheet(f.file.filename)) continue;
    for (const h of f.hunks) for (const l of h.lines) out.push(l.text);
  }
  for (const [path, text] of snap.contents) if (isSheet(path)) out.push(...text.split('\n'));
  return out;
}

/**
 * The only URLs a claim may be checked against: external links (known target form, fetchable) in
 * the diff of a cheat sheet or in a changed cheat sheet at the head commit. Lines longer than
 * MAX_LINK_LINE are not scanned (the link stage flags them for a person).
 */
export function sourceUrls(snap: Snapshot): Set<string> {
  const out = new Set<string>();
  for (const text of sheetLines(snap)) {
    if (text.length > MAX_LINK_LINE) continue;
    for (const u of targets(text))
      if (isExternal(u) && knownTargetForm(u) && fetchable(u)) out.add(u);
  }
  return out;
}

/** Whether `sourceUrl` appears only on a line too long to scan: then the reason says so. */
function onLongLine(snap: Snapshot, sourceUrl: string): boolean {
  const u = sourceUrl.trim();
  return u.length > 0 && sheetLines(snap).some((t) => t.length > MAX_LINK_LINE && t.includes(u));
}

const withoutFragment = (u: string) => u.split('#', 1)[0] ?? u;

/**
 * The PR link a claim's `sourceUrl` names (the same URL, or the same URL with another fragment), or
 * undefined. What gets fetched is always the PR's own string, never the model's.
 */
export function citedSource(sourceUrl: string, sources: ReadonlySet<string>): string | undefined {
  const u = sourceUrl.trim();
  if (sources.has(u)) return u;
  for (const s of sources) if (withoutFragment(s) === withoutFragment(u)) return s;
  return undefined;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The locator as a pattern: whitespace runs match any whitespace; a number never matches a longer one. */
function pattern(locator: string): RegExp {
  const body = locator.split(/\s+/).map(escape).join('\\s+');
  // A number at either end never runs into a longer one ("5.1.1" vs "5.1.10" or "15.1.1", "page 12"
  // vs "page 120"); a word at the end never runs into a numbered revision ("800-63B" vs "800-63B-4").
  const before = /^\d/.test(locator) ? '(?<![\\w.])' : '';
  const after = /\d$/.test(locator) ? '(?!\\w|\\.\\d|-\\d)' : /\w$/.test(locator) ? '(?!-\\d)' : '';
  return new RegExp(`${before}${body}${after}`, 'giu');
}

/** A match at the start of a line (heading or list), on a line that is not a table-of-contents entry. */
function headingLike(text: string, at: number): boolean {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const endAt = text.indexOf('\n', at);
  const line = text.slice(start, endAt === -1 ? undefined : endAt);
  return /^[\s#*>|-]*$/.test(text.slice(start, at)) && !/(\.\s?){4,}|…{2,}/.test(line);
}

/**
 * Where the locator is in the text, matched with whitespace normalised and case ignored: the literal
 * locator, else its leading section number ("§3.1.3", "Section 3.1.3 Embedded malware" → "3.1.3",
 * only numbers with a dot). Of several matches, the last one that starts a line and is not a
 * table-of-contents entry (the section itself, after the contents), else the first.
 */
export function locate(text: string, locator: string): { at: number; length: number } | undefined {
  const l = locator
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
  if (l.length < 2) return undefined;
  const candidates = [l];
  const section = /^(?:§+\s*|section\s+|sec\.\s*)?(\d+(?:\.\d+)+)(?![\w.]|\.\d)/i.exec(l)?.[1];
  if (section !== undefined && section !== l) candidates.push(section);
  for (const c of candidates) {
    // At most 500 matches are looked at: a short locator in a converted PDF can match very often.
    const hits: RegExpExecArray[] = [];
    for (const h of text.matchAll(pattern(c))) if (hits.push(h) >= 500) break;
    const first = hits[0];
    if (!first) continue;
    const pick = hits.filter((h) => headingLike(text, h.index)).at(-1) ?? first;
    return { at: pick.index, length: pick[0].length };
  }
  return undefined;
}

/** ±3,000 characters around the locator; without a match, the first 6,000 characters. */
export function excerptFor(text: string, locator: string): { excerpt: string; found: boolean } {
  const hit = locate(text, locator);
  if (!hit) return { excerpt: text.slice(0, HEAD_CHARS), found: false };
  const start = Math.max(0, hit.at - AROUND_CHARS);
  const end = Math.min(text.length, hit.at + hit.length + AROUND_CHARS);
  return {
    excerpt: `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
    found: true,
  };
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
};

/**
 * Checks every claim the reviewers made (#90). At most MAX_CLAIMS are fetched and verified, BLOCKER
 * first; the kill switch is checked before every fetch and model call. Never throws for a source or
 * a verifier failure: those become NOT-FOUND with a reason.
 */
export async function claimStage(
  snap: Snapshot,
  reports: readonly { role: ReviewerRole; report: ReviewerReport }[],
  deps: ClaimDeps,
): Promise<ClaimStageResult> {
  const claimed = reports.flatMap(({ role, report }) =>
    role === 'link-auditor'
      ? []
      : report.findings.flatMap((f, index) =>
          f.claim ? [{ role, index, finding: f as ClaimedFinding }] : [],
        ),
  );
  const results: ClaimResult[] = [];
  if (claimed.length === 0) return { results, outcome: undefined, injectionSeen: false };

  const sources = sourceUrls(snap);
  const cited: ((typeof claimed)[number] & { source: string })[] = [];
  for (const c of claimed) {
    const source = citedSource(c.finding.claim.sourceUrl, sources);
    if (source === undefined)
      results.push({
        ...c,
        verdict: 'NOT-FOUND',
        by: 'code',
        reason: onLongLine(snap, c.finding.claim.sourceUrl)
          ? 'the source line is too long to read, so it was not fetched'
          : 'the source is not a link in this pull request, so it was not fetched',
      });
    else cited.push({ ...c, source });
  }
  cited.sort((a, b) => RANK[a.finding.severity] - RANK[b.finding.severity]);
  for (const c of cited.slice(MAX_CLAIMS))
    results.push({
      role: c.role,
      index: c.index,
      finding: c.finding,
      host: hostOf(c.source),
      verdict: 'NOT-FOUND',
      by: 'code',
      reason: `not checked: at most ${MAX_CLAIMS} claims are checked per review`,
    });

  const docs = new Map<string, SourceDoc>();
  const asked: { input: ClaimInput; c: (typeof cited)[number] }[] = [];
  for (const c of cited.slice(0, MAX_CLAIMS)) {
    const host = hostOf(c.source);
    const base = { role: c.role, index: c.index, finding: c.finding, host };
    let doc = docs.get(c.source);
    if (!doc) {
      await deps.guard();
      doc = await deps.limit(() => deps.fetchSource(c.source));
      docs.set(c.source, doc);
    }
    if (doc.kind === 'failed') {
      results.push({
        ...base,
        verdict: 'NOT-FOUND',
        by: 'code',
        reason: `source not read: ${doc.why}`,
      });
      continue;
    }
    if (doc.text.trim() === '') {
      results.push({
        ...base,
        verdict: 'NOT-FOUND',
        by: 'code',
        reason: 'source not read: no text',
      });
      continue;
    }
    const { excerpt, found } = excerptFor(doc.text, c.finding.claim.locator);
    asked.push({
      c,
      input: {
        id: String(asked.length + 1),
        claim: c.finding.claim,
        host,
        format: doc.format,
        found,
        excerpt,
      },
    });
  }

  let outcome: RoleOutcome | undefined;
  let injectionSeen = false;
  if (asked.length > 0) {
    const r = await runRole(
      deps,
      'claim-verifier',
      ClaimCheck,
      VERIFIER_PROMPT,
      claimMessage(asked.map((x) => x.input)),
    );
    outcome = r.outcome;
    injectionSeen = r.answer?.injectionSeen === true;
    const answers = new Map<string, ClaimCheck['claims'][number]>();
    for (const a of r.answer?.claims ?? []) if (!answers.has(a.id)) answers.set(a.id, a);
    for (const { c, input } of asked) {
      const base = {
        role: c.role,
        index: c.index,
        finding: c.finding,
        host: input.host,
        found: input.found,
      };
      const a = answers.get(input.id);
      const code = (reason: string): ClaimResult => ({
        ...base,
        verdict: 'NOT-FOUND',
        by: 'code',
        reason,
      });
      if (!r.answer) results.push(code('the claim verifier was unavailable'));
      else if (!a) results.push(code('the claim verifier gave no verdict'));
      // Injection never confirms and never removes a finding: a person looks.
      else if (injectionSeen && a.verdict !== 'NOT-FOUND')
        results.push(code('instruction-like text in the claim or the source'));
      // A refutation needs the cited passage; the start of the document is not enough.
      else if (a.verdict === 'REFUTED' && !input.found)
        results.push(code('the locator is not in the source, so the claim cannot be refuted'));
      else results.push({ ...base, verdict: a.verdict, by: 'verifier', reason: a.reason });
    }
  }
  results.sort((a, b) => RANK[a.finding.severity] - RANK[b.finding.severity]);
  return { results, outcome, injectionSeen };
}

const VERDICT_RANK = { PASS: 0, CONCERNS: 1, BLOCK: 2 } as const;

/**
 * The reports the judge sees, and the ones code reads reviewer verdicts from: REFUTED findings
 * removed, CONFIRMED and NOT-FOUND ones marked `"verified": "CONFIRMED" | "NOT-FOUND"` (a field
 * only code sets: zod strips it from model output). NOT-FOUND never removes or weakens anything:
 * only a report that lost a REFUTED finding gets the verdict of what is left, never a higher one.
 */
export function reportsForJudge(
  reports: readonly { role: ReviewerRole; report: ReviewerReport }[],
  results: readonly ClaimResult[],
): { role: ReviewerRole; report: ReviewerReport }[] {
  const verdictOf = (role: ReviewerRole, index: number) =>
    results.find((r) => r.role === role && r.index === index)?.verdict;
  return reports.map(({ role, report }) => {
    const findings: Finding[] = [];
    report.findings.forEach((f, index) => {
      const v = verdictOf(role, index);
      if (v === 'REFUTED') return;
      const kept: Finding & { verified?: 'CONFIRMED' | 'NOT-FOUND' } =
        v === undefined ? f : { ...f, verified: v };
      findings.push(kept);
    });
    if (findings.length === report.findings.length || report.verdict === 'N/A')
      return { role, report: { ...report, findings } };
    const left = findings.some((f) => f.severity === 'BLOCKER')
      ? 'BLOCK'
      : findings.some((f) => f.severity === 'MAJOR' || f.severity === 'MINOR')
        ? 'CONCERNS'
        : 'PASS';
    const verdict = VERDICT_RANK[left] < VERDICT_RANK[report.verdict] ? left : report.verdict;
    return { role, report: { ...report, findings, verdict } };
  });
}

/** What the judge is told about each checked claim. */
export function judgeClaims(results: readonly ClaimResult[]): JudgeClaim[] {
  return results.map((r) => ({
    role: r.role,
    file: r.finding.file,
    ...(r.finding.line !== undefined ? { line: r.finding.line } : {}),
    verdict: r.verdict,
    claim: r.finding.claim.text,
  }));
}

const STOP = new Set([
  'about',
  'also',
  'been',
  'does',
  'from',
  'have',
  'into',
  'more',
  'must',
  'only',
  'should',
  'such',
  'than',
  'that',
  'their',
  'there',
  'this',
  'when',
  'where',
  'which',
  'will',
  'with',
  'would',
]);

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function words(s: string): Set<string> {
  return new Set(
    (fold(s).match(/[a-z0-9][a-z0-9.]*[a-z0-9]|[a-z0-9]/g) ?? []).filter(
      (w) => (w.length >= 4 || /\d/.test(w)) && !STOP.has(w),
    ),
  );
}

/**
 * Whether text speaks about the claimed finding: it quotes the locator (a number, or 12 characters
 * or more; matched like `locate`, so 5.1.1 never matches 15.1.1), names the source URL, or shares
 * at least half of its significant words with the finding's problem and claim (`strict`: 60%, for
 * text with no file or line to anchor it).
 */
export function mentions(text: string, f: ClaimedFinding, strict = false): boolean {
  const t = fold(text);
  const loc = f.claim.locator
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
  if ((/\d/.test(loc) && loc.length >= 3) || loc.length >= 12)
    if (pattern(loc).test(text)) return true;
  const url = fold(f.claim.sourceUrl);
  if (/^https?:\/\/\S{8,}$/.test(url) && t.includes(url)) return true;
  const a = words(text);
  const b = words(`${f.problem} ${f.claim.text}`);
  const small = Math.min(a.size, b.size);
  if (small < 3) return false;
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / small >= (strict ? 0.6 : 0.5);
}

/**
 * A judge item about the claimed finding: same file, the same line (an item without a line only
 * for a finding without one), and it mentions it.
 */
export function refersTo(i: Pick<Item, 'file' | 'line' | 'text'>, f: ClaimedFinding): boolean {
  if (i.file !== f.file) return false;
  if (i.line === undefined && f.line !== undefined) return false;
  if (i.line !== undefined && f.line !== undefined && i.line !== f.line) return false;
  return mentions(i.text, f);
}

export const DIMENSION: Readonly<Record<ReviewerRole, Dimension>> = {
  'security-reviewer': 'Security',
  'security-second-voice': 'Security',
  'practicality-reviewer': 'Practicality',
  'link-auditor': 'Links & sources',
  'duplication-checker': 'Duplication & placement',
  'language-reviewer': 'Language',
};

/** The code-written mark on a confirmed finding. */
export function verifiedNote(r: ClaimResult): string {
  return ` (verified against ${r.host ?? 'its source'}, ${inertText(r.finding.claim.locator, 80)})`;
}

/** Sentences of `text` that do not mention any of the claims. */
function withoutSentences(text: string, gone: readonly ClaimedFinding[]): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !gone.some((f) => mentions(s, f, true)))
    .join(' ');
}

/**
 * The claim verdicts applied to the judge's decision, in code (#90). A REFUTED finding removes only
 * the claimant's own item: judge items of the claimant's dimension about it, and the claimant's
 * own suggestion; another reviewer's corroborating finding in another dimension survives. No
 * sentence about a REFUTED claim stays in the rationale, close reasons, reply, dimension headlines
 * or earlier-request summaries. NOT-FOUND changes nothing here (it is also listed for the
 * maintainer). A CONFIRMED finding stays: its item is marked verified, or code adds it back when
 * the judge dropped it (a BLOCKER or MAJOR then makes MERGE a REQUEST_CHANGES). Runs before
 * normaliseDecision.
 */
export function enforceClaims(
  d: ReviewDecision,
  results: readonly ClaimResult[],
): { decision: ReviewDecision; removed: number } {
  const gone = results.filter((r) => r.verdict === 'REFUTED');
  const refuted = gone.map((r) => r.finding);
  const confirmed = results.filter((r) => r.verdict === 'CONFIRMED');
  let removed = 0;
  const keep = <T>(list: readonly T[], drop: (x: T) => boolean): T[] =>
    list.filter((x) => {
      const out = drop(x);
      if (out) removed++;
      return !out;
    });
  const dropItem = (i: Item) =>
    gone.some((r) => i.dimension === DIMENSION[r.role] && refersTo(i, r.finding));
  const lists = {
    mustFix: keep(d.mustFix, dropItem),
    shouldFix: keep(d.shouldFix, dropItem),
    nits: keep(d.nits, dropItem),
    outOfScope: keep(d.outOfScope, dropItem),
  };
  // Suggestions carry no dimension: only the claimant's own suggestion goes.
  const suggestions = keep(d.suggestions, (s) =>
    gone.some(
      ({ finding: f }) =>
        s.file === f.suggestion?.file &&
        s.line === f.suggestion.line &&
        s.replacement === f.suggestion.replacement,
    ),
  );
  const closeReasons = keep(d.closeReasons, (c) => refuted.some((f) => mentions(c, f, true)));
  const { replyToAuthor, ...rest } = d;
  let rationale = d.rationale;
  let reply = replyToAuthor;
  let dimensions = d.dimensions;
  let earlierRequests = d.earlierRequests;
  if (refuted.length > 0) {
    rationale =
      withoutSentences(d.rationale, refuted) ||
      'Code removed the rationale: it rested on a claim that its cited source refutes.';
    reply = replyToAuthor !== undefined ? withoutSentences(replyToAuthor, refuted) : undefined;
    dimensions = d.dimensions.map((x) => ({
      ...x,
      headline: withoutSentences(x.headline, refuted),
    }));
    earlierRequests = d.earlierRequests.map((e) => ({
      ...e,
      request:
        withoutSentences(e.request, refuted) ||
        '(summary removed by code: it repeated a refuted claim)',
    }));
  }

  // Confirmed findings: marked where the judge kept them, added back where it did not.
  const mark = (i: Item): Item => {
    const r = confirmed.find((c) => refersTo(i, c.finding));
    if (!r) return i;
    const note = verifiedNote(r);
    return { ...i, text: `${i.text.slice(0, 800 - note.length)}${note}` };
  };
  const marked = {
    mustFix: lists.mustFix.map(mark),
    shouldFix: lists.shouldFix.map(mark),
    nits: lists.nits.map(mark),
    outOfScope: lists.outOfScope.map(mark),
  };
  const all = [...lists.mustFix, ...lists.shouldFix, ...lists.nits, ...lists.outOfScope];
  let verdict = d.verdict;
  for (const r of confirmed) {
    if (all.some((i) => refersTo(i, r.finding))) continue;
    const f = r.finding;
    const note = verifiedNote(r);
    marked.mustFix.push({
      dimension: DIMENSION[r.role],
      severity: f.severity,
      file: f.file,
      ...(f.line !== undefined ? { line: f.line } : {}),
      text: `${f.problem.slice(0, 800 - note.length)}${note}`,
    });
    if (verdict === 'MERGE' && (f.severity === 'BLOCKER' || f.severity === 'MAJOR'))
      verdict = 'REQUEST_CHANGES';
  }
  return {
    decision: {
      ...rest,
      ...marked,
      verdict,
      suggestions,
      closeReasons,
      rationale,
      dimensions,
      earlierRequests,
      ...(reply ? { replyToAuthor: reply } : {}),
    },
    removed,
  };
}

const claimId = (r: ClaimResult) => `${r.role}#${r.index}`;

/**
 * What a run logs and puts on its span about claims: ids (`role#index`), severities, verdicts,
 * hosts and code-written reasons. Never claim, finding, page or verifier text.
 */
export function claimLog(results: readonly ClaimResult[], removedItems: number) {
  const count = (v: ClaimVerdict) => results.filter((r) => r.verdict === v).length;
  const confirmed = count('CONFIRMED');
  const refuted = count('REFUTED');
  const notFound = count('NOT-FOUND');
  return {
    confirmed,
    refuted,
    notFound,
    refutedIds: results
      .filter((r) => r.verdict === 'REFUTED')
      .map((r) => `${claimId(r)}@${r.host ?? 'none'}`)
      .join(', '),
    log: {
      claims: results.length,
      confirmed,
      refuted,
      notFound,
      removedItems,
      verdicts: results.map((r) => ({
        id: claimId(r),
        severity: r.finding.severity,
        verdict: r.verdict,
        host: r.host ?? null,
        ...(r.by === 'code' ? { reason: r.reason } : {}),
      })),
    },
  };
}

/**
 * #90: the refuted claims for the operator, appended to the approval request's note (shown escaped
 * on the approval page, OWASP). Model text, made inert and clipped; empty when nothing was refuted.
 */
export function refutedNote(results: readonly ClaimResult[]): string {
  const refuted = results.filter((r) => r.verdict === 'REFUTED');
  if (refuted.length === 0) return '';
  // Count first and short entries: the whole rationale is cut at 4,000 characters.
  return [
    '',
    '',
    `${refuted.length} refuted claim(s), left out of the review (checked by code against the cited source; the text is model output):`,
    ...refuted.map(
      (r) =>
        `- ${r.finding.severity} ${inertText(r.finding.file, 120)}${r.finding.line ? `:${r.finding.line}` : ''} (${r.role}) against ${r.host ?? 'its source'} at "${inertText(r.finding.claim.locator, 60)}": "${inertText(r.finding.claim.text, 150)}" Verifier: ${inertText(r.reason, 150)}`,
    ),
  ].join('\n');
}
