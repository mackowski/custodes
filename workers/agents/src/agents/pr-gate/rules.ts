// Deterministic CONTRIBUTING.md checks. Pure functions over GitHub data; no I/O, no model.
// Everything they read (PR body, file names) is untrusted, so they only ever count and match.
import type { IssueComment, PublicIssue, PublicPull, PullFile } from '../triage/github.js';

export const ACK_LABEL = 'ACK_OBTAINED';
export const WAITING_UPDATE_LABEL = 'WAITING_UPDATE';

/** Authors who are never gated: dependabot first (the operator's explicit rule), then any bot. */
export const DEPENDABOT = 'dependabot[bot]';
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export type CloseRule = 'ai_disclosure' | 'assigned_to_other' | 'no_approved_issue';

export type Exemption = 'dependabot' | 'bot' | 'draft' | 'maintainer' | 'waiting_update';

/**
 * Why a PR is not gated at all, or null when it is. `gateMaintainers` (sandbox only, ADR 0012)
 * drops the maintainer exemption so the operator can open scenarios themselves; bots stay exempt.
 */
export function exemption(
  pr: PublicPull,
  opts: { gateMaintainers?: boolean } = {},
): Exemption | null {
  const login = pr.user?.login ?? '';
  if (login.toLowerCase() === DEPENDABOT) return 'dependabot';
  if (pr.user?.type === 'Bot' || login.endsWith('[bot]')) return 'bot';
  if (pr.draft === true) return 'draft';
  if (!opts.gateMaintainers && TRUSTED_ASSOCIATIONS.has(pr.author_association ?? ''))
    return 'maintainer';
  if (pr.labels.some((l) => l.name === WAITING_UPDATE_LABEL)) return 'waiting_update';
  return null;
}

export type Disclosure = 'ok' | 'missing' | 'blank' | 'multiple';

const MAX_BODY_SCAN = 65_536;

/**
 * The template's "AI Tool Usage Disclosure" section must have exactly one ticked option.
 * `missing`: no such heading. `blank`: nothing ticked. `multiple`: more than one ticked.
 */
export function disclosure(body: string | null | undefined): Disclosure {
  const lines = (body ?? '').slice(0, MAX_BODY_SCAN).split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*(?:#{1,6}|\*\*)\s*AI Tool Usage Disclosure/i.test(l));
  if (start < 0) return 'missing';
  let ticked = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#{1,6}\s/.test(line)) break;
    if (/^\s*[-*+]\s*\[[xX]\]/.test(line)) ticked++;
  }
  if (ticked === 0) return 'blank';
  return ticked === 1 ? 'ok' : 'multiple';
}

/** Issue references read per PR. A body with more is flagged, never closed (we may miss the real one). */
export const MAX_LINKED = 5;

/**
 * Issue numbers the PR body points at: `#123` and links to this repository's issues. At most
 * MAX_LINKED + 1 distinct ones, so a caller can tell that there were more. Pull requests among
 * them are filtered later (an issue read says so).
 * Code blocks, longer code spans and escaped `\#` are ignored (pasted lint output is full of
 * `#9`), but a code span holding only a reference counts: ``#`123` `` and `` `#123` ``.
 */
export function linkedIssueNumbers(body: string | null | undefined, repo: string): number[] {
  const raw = (body ?? '').slice(0, MAX_BODY_SCAN);
  const out: number[] = [];
  const add = (s: string | undefined) => {
    const n = Number(s);
    if (Number.isSafeInteger(n) && n > 0 && n < 1_000_000 && !out.includes(n)) out.push(n);
  };
  const unfenced = raw.replace(/```[\s\S]*?(```|$)/g, ' ');
  // A code span that holds only a reference is a reference: the template's #`123` and a plain
  // `#123` (PR #2801 wrote "This PR fixes issue `#2770`." and was closed by mistake).
  for (const m of unfenced.matchAll(/(?<![\w&/\\])#`(\d{1,7})`|` ?#(\d{1,7}) ?`/g))
    add(m[1] ?? m[2]);
  const text = unfenced.replace(/`[^`\n]*`/g, ' ').replace(/\\#/g, ' ');
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const url = new RegExp(`https://github\\.com/${escaped}/issues/(\\d{1,7})\\b`, 'gi');
  for (const m of text.matchAll(url)) add(m[1]);
  // `#123` not preceded by a word character, `&` (HTML entities) or `/` (other URLs).
  for (const m of text.matchAll(/(?<![\w&/])#(\d{1,7})\b/g)) add(m[1]);
  return out.slice(0, MAX_LINKED + 1);
}

export type IssueApproval =
  /** An approved issue is assigned to the PR author: the PR follows the guide. */
  | { kind: 'approved_assigned'; issue: number }
  /** Approved, but assigned only to other people. */
  | { kind: 'assigned_to_other'; issue: number; assignees: string[] }
  /** Approved and nobody assigned: ambiguous, a maintainer decides. */
  | { kind: 'approved_unassigned'; issue: number }
  /** No linked issue is approved (or none is linked). */
  | { kind: 'none'; unapproved: number[] };

function labelNames(issue: PublicIssue): string[] {
  return issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
}

/** Judges the linked issues (already read, pull requests and closed issues included) for one author. */
export function issueApproval(author: string, issues: readonly PublicIssue[]): IssueApproval {
  const real = issues.filter((i) => i.pull_request === undefined);
  const approved = real.filter((i) => i.state !== 'closed' && labelNames(i).includes(ACK_LABEL));
  const who = (i: PublicIssue) => (i.assignees ?? []).map((a) => a.login);
  const me = author.toLowerCase();
  const mine = approved.find((i) => who(i).some((a) => a.toLowerCase() === me));
  if (mine) return { kind: 'approved_assigned', issue: mine.number };
  const unassigned = approved.find((i) => who(i).length === 0);
  if (unassigned) return { kind: 'approved_unassigned', issue: unassigned.number };
  const other = approved[0];
  if (other) return { kind: 'assigned_to_other', issue: other.number, assignees: who(other) };
  return { kind: 'none', unapproved: real.map((i) => i.number) };
}

/** A comment by a maintainer, quotes and pasted blocks removed. */
export interface MaintainerComment {
  thread: number;
  login: string;
  body: string;
  /** The comment @-mentions the PR author by exact login. */
  mentionsAuthor: boolean;
}

/** The comments endpoint returns at most this many per read; a full page may mean more exist. */
export const COMMENTS_PAGE = 100;

/** The agents' own trailer block (an HTML comment, one field per line); quotes cannot fake it. */
const AGENT_TRAILER = /^Custodes-Agent: [a-z0-9-]+@/m;

/**
 * Comments by OWNER, MEMBER or COLLABORATOR in the given threads, oldest first per thread, those
 * that mention the author first. `author_association` comes from GitHub, so only a maintainer can
 * put text here. Dropped: the author's own comments, bots, agent comments, and in the rest quoted
 * (`>`) lines, code blocks and HTML comments, which may repeat third-party words. Quotes go first,
 * so a maintainer who quotes an agent comment keeps their own words. `truncated` when a thread
 * filled a whole page.
 */
export function maintainerComments(
  author: string,
  threads: readonly { thread: number; comments: readonly IssueComment[] }[],
): { comments: MaintainerComment[]; truncated: boolean } {
  const me = author.toLowerCase();
  const mention = new RegExp(
    `(?<![\\w-])@${author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`,
    'i',
  );
  const out: MaintainerComment[] = [];
  let truncated = false;
  for (const t of threads) {
    if (t.comments.length >= COMMENTS_PAGE) truncated = true;
    for (const c of t.comments) {
      const login = c.user?.login ?? '';
      if (!login || login.toLowerCase() === me) continue;
      if (c.user?.type === 'Bot' || login.endsWith('[bot]')) continue;
      if (!TRUSTED_ASSOCIATIONS.has(c.author_association ?? '')) continue;
      const unquoted = (c.body ?? '')
        .split(/\r?\n/)
        .filter((l) => !/^\s*>/.test(l))
        .join('\n');
      if (AGENT_TRAILER.test(unquoted)) continue;
      const body = unquoted
        .replace(/```[\s\S]*?(```|$)/g, ' ')
        .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
        .trim();
      if (body)
        out.push({
          thread: t.thread,
          login,
          body,
          mentionsAuthor: author !== '' && mention.test(body),
        });
    }
  }
  return {
    comments: [...out.filter((c) => c.mentionsAuthor), ...out.filter((c) => !c.mentionsAuthor)],
    truncated,
  };
}

/** Above this many changed lines a PR is not a minor fix, whatever it changes. */
export const MINOR_MAX_LINES = 60;

export type MinorPrefilter =
  /** Cannot be minor: adds, removes or renames a file, or is too large. */
  | { kind: 'not_minor'; reason: 'file_added_or_removed' | 'too_large' }
  /** Touches something other than cheat sheet content: not ours to judge, a human decides. */
  | { kind: 'out_of_scope' }
  /** Small edits to existing cheat sheets: needs a look at the diff. */
  | { kind: 'candidate'; lines: number };

export const CONTENT_PATH = /^(cheatsheets|cheatsheets_draft)\/[^/]+\.md$/;

/** Cheap structural check that runs before any model sees the diff. */
export function minorPrefilter(files: readonly PullFile[]): MinorPrefilter {
  if (files.length === 0) return { kind: 'out_of_scope' };
  if (files.some((f) => !CONTENT_PATH.test(f.filename))) return { kind: 'out_of_scope' };
  if (files.some((f) => f.status !== 'modified'))
    return { kind: 'not_minor', reason: 'file_added_or_removed' };
  const lines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (lines > MINOR_MAX_LINES) return { kind: 'not_minor', reason: 'too_large' };
  return { kind: 'candidate', lines };
}

/** The diff as the classifier sees it: file headers and patches, nothing else from the PR. */
export function diffText(files: readonly PullFile[]): string {
  return files.map((f) => `--- ${f.filename}\n${f.patch ?? '(no textual diff)'}`).join('\n\n');
}

/** Act only on a PR nobody touched for this long, so an author mid-edit is not closed. */
export const GRACE_MS = 30 * 60_000;

export function settled(pr: PublicPull, now: Date): boolean {
  const at = Date.parse(pr.updated_at);
  return !Number.isNaN(at) && now.getTime() - at >= GRACE_MS;
}

/** Wake-ups are rounded up to slots, so a burst of events or skipped PRs costs one poll per slot. */
export const WAKE_SLOT_MS = 5 * 60_000;

/** The first slot boundary after `now`. */
export function nextSlot(now: Date): Date {
  return new Date(Math.ceil((now.getTime() + 1) / WAKE_SLOT_MS) * WAKE_SLOT_MS);
}

/**
 * When to poll for a PR last updated at `updatedAt`: once its grace period is over, rounded up to a
 * slot and always in the future. An unparsable or future time (only a hint, from a webhook or a
 * listing) counts as `now`, so a wake-up is never later than one grace period plus one slot.
 */
export function wakeAt(updatedAt: string, now: Date): Date {
  const parsed = Date.parse(updatedAt);
  const at = Number.isNaN(parsed) ? now.getTime() : Math.min(parsed, now.getTime());
  return at + GRACE_MS > now.getTime()
    ? new Date(Math.ceil((at + GRACE_MS) / WAKE_SLOT_MS) * WAKE_SLOT_MS)
    : nextSlot(now);
}

/** Sticky flags: decisions that later polls must not undo by themselves. */
export const REOPENED = 'reopened_after_close';
export const CLOSE_FAILED = 'close_failed';

export interface PriorDecision {
  outcome: string;
  why: string | undefined;
  headSha: string;
  prUpdatedAt: string;
}

/**
 * What a poll does with an open PR given the stored decision:
 * `reopened` (we closed it, someone reopened it: report once, never act again), `decide`, or `leave`.
 */
export function nextStep(
  pr: Pick<PublicPull, 'updated_at'> & { head: { sha: string } },
  prior: PriorDecision | undefined,
  /** Enforcing and under today's close cap: only then is a "would close" worth deciding again. */
  canClose: boolean,
): 'reopened' | 'decide' | 'leave' {
  if (!prior) return 'decide';
  if (prior.outcome === 'close') return 'reopened';
  if (prior.why === REOPENED) return 'leave';
  // Our own comment bumped updated_at; only new commits justify another attempt.
  if (prior.why === CLOSE_FAILED) return prior.headSha !== pr.head.sha ? 'decide' : 'leave';
  if (prior.headSha !== pr.head.sha || prior.prUpdatedAt !== pr.updated_at) return 'decide';
  if (prior.outcome === 'error') return 'decide';
  return prior.outcome === 'would_close' && canClose ? 'decide' : 'leave';
}
