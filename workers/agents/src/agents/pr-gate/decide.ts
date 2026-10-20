// One PR through the ladder: rules decide almost everything; Jev only judges whether a small diff
// with no approved issue is a minor fix and, before a close, whether a maintainer agreed to the
// PR in a comment. A human gets whatever Jev is unsure about.
import { climb, type Rung, type TraceEntry } from '@custodes/core';
import type { IssueComment, PublicIssue, PublicPull, PullFile } from '../triage/github.js';
import { approvalCut, approvalState, approvalSteps, type ApprovalDeps } from './approval.js';
import { minorSteps, type MinorDeps } from './minor.js';
import {
  diffText,
  disclosure,
  exemption,
  issueApproval,
  linkedIssueNumbers,
  maintainerComments,
  MAX_LINKED,
  minorPrefilter,
  type CloseRule,
  type Exemption,
} from './rules.js';

export type SkipReason = Exemption | 'compliant' | 'minor_fix' | 'maintainer_approved';
export type FlagReason =
  | 'disclosure_missing'
  | 'disclosure_multiple'
  | 'approved_unassigned'
  | 'out_of_scope'
  | 'too_many_refs'
  | 'author_has_approved_issue'
  | 'approval_list_truncated'
  | 'maintainer_maybe_approved'
  | 'maintainer_comments_truncated'
  | 'undecided';

export type Decision =
  | { outcome: 'skip'; reason: SkipReason; rung: Rung; issue?: number; trace: TraceEntry[] }
  | {
      outcome: 'close';
      rule: CloseRule;
      rung: Rung;
      /** The approved issue (assigned_to_other) or the unapproved linked ones (no_approved_issue). */
      issues: number[];
      /** Current assignees of the approved issue (assigned_to_other only). */
      assignees?: string[];
      trace: TraceEntry[];
    }
  | { outcome: 'flag'; reason: FlagReason; issue?: number; trace: TraceEntry[] };

export interface DecideDeps extends MinorDeps, ApprovalDeps {
  /** The issue, or null when the number is not an issue in this repository (404). */
  getIssue: (n: number) => Promise<PublicIssue | null>;
  listFiles: () => Promise<PullFile[]>;
  /**
   * Open ACK_OBTAINED issues assigned to this login. A safety net before a no_approved_issue close:
   * if the author has one, the link was probably written in a way we did not parse (PR #2801).
   */
  approvedIssuesOf: (login: string) => Promise<{ issues: number[]; complete: boolean }>;
  /** Comments on an issue or PR (first page), or null when the number is not one here (404). */
  listComments: (n: number) => Promise<IssueComment[] | null>;
}

const ruleTrace = (detail: Record<string, string | number | boolean>): TraceEntry[] => [
  { rung: 'rule', outcome: 'decided', detail },
];

export async function decide(
  repo: string,
  pr: PublicPull,
  deps: DecideDeps,
  opts: { gateMaintainers?: boolean } = {},
): Promise<Decision> {
  const exempt = exemption(pr, opts);
  if (exempt)
    return { outcome: 'skip', reason: exempt, rung: 'rule', trace: ruleTrace({ exempt }) };

  const disc = disclosure(pr.body);
  // The template promises to close PRs that leave the section blank. A missing section usually
  // means the template was not used (or upstream renamed the heading): a maintainer decides.
  if (disc === 'missing')
    return {
      outcome: 'flag',
      reason: 'disclosure_missing',
      trace: ruleTrace({ disclosure: disc }),
    };
  if (disc === 'blank')
    return {
      outcome: 'close',
      rule: 'ai_disclosure',
      rung: 'rule',
      issues: [],
      trace: ruleTrace({ disclosure: disc }),
    };
  // Both options ticked is unclear rather than blank: never a close on its own.
  const softFlag = disc === 'multiple';

  const author = pr.user?.login ?? '';
  const refs = linkedIssueNumbers(pr.body, repo).filter((n) => n !== pr.number);
  // More references than we read: the PR's own issue may be among the unread ones, so a missing
  // approval below is not proof. Such a PR can still be skipped, but never closed.
  const overflow = refs.length > MAX_LINKED;
  const linked = refs.slice(0, MAX_LINKED);
  const issues: PublicIssue[] = [];
  let files: PullFile[] | undefined;
  const changedFiles = async () => (files ??= await deps.listFiles());
  for (const n of linked) {
    const issue = await deps.getIssue(n);
    if (issue) issues.push(issue);
  }
  const approval = issueApproval(author, issues);
  const base = { disclosure: disc, linked: refs.length, approval: approval.kind };
  const close = async (d: Extract<Decision, { outcome: 'close' }>): Promise<Decision> => {
    if (overflow) return { outcome: 'flag', reason: 'too_many_refs', trace: d.trace };
    if (d.rule === 'no_approved_issue') {
      const mine = await deps.approvedIssuesOf(author);
      const first = mine.issues[0];
      const trace: TraceEntry[] = [
        ...d.trace,
        {
          rung: 'rule',
          outcome: 'undecided',
          detail: { authorApproved: mine.issues.length, complete: mine.complete },
        },
      ];
      if (first !== undefined)
        return { outcome: 'flag', reason: 'author_has_approved_issue', issue: first, trace };
      // An incomplete list cannot prove the author has no approved issue.
      if (!mine.complete) return { outcome: 'flag', reason: 'approval_list_truncated', trace };
      d = { ...d, trace };
    }
    return maintainerCheck(d);
  };
  // Before any close for a missing or taken issue (never ai_disclosure: agreement does not replace
  // the disclosure): did a maintainer agree in this PR or in a thread it links, issues and PRs
  // alike? Nobody spoke: close. Otherwise Jev, and only a confident no closes (PR #2831).
  const maintainerCheck = async (d: Extract<Decision, { outcome: 'close' }>): Promise<Decision> => {
    const threads: { thread: number; comments: IssueComment[] }[] = [];
    for (const n of [pr.number, ...linked]) {
      const comments = await deps.listComments(n);
      if (comments) threads.push({ thread: n, comments });
    }
    const said = maintainerComments(author, threads);
    if (said.comments.length === 0)
      return {
        ...d,
        trace: [
          ...d.trace,
          { rung: 'rule', outcome: 'decided', detail: { maintainerComments: 0 } },
        ],
      };
    const state = approvalState(author, await changedFiles(), said.comments);
    const ladder = await climb(approvalSteps(state, deps));
    // Comments Jev did not see (a full page, or cut to fit) may hold the agreement (PR #2801 lesson).
    const partial = said.truncated || approvalCut(said.comments);
    // A yes must be about this author: a comment naming them, or one on this PR itself. Agreement
    // given to someone else in a thread the author chose to link is not enough to skip.
    const addressed = said.comments.some((c) => c.mentionsAuthor || c.thread === pr.number);
    const trace: TraceEntry[] = [
      ...d.trace,
      {
        rung: 'rule',
        outcome: 'undecided',
        detail: { maintainerComments: said.comments.length, partial, addressed },
      },
      ...ladder.trace,
    ];
    if (!ladder.decided) return { outcome: 'flag', reason: 'maintainer_maybe_approved', trace };
    if (ladder.value) {
      if (!addressed) return { outcome: 'flag', reason: 'maintainer_maybe_approved', trace };
      return { outcome: 'skip', reason: 'maintainer_approved', rung: ladder.rung, trace };
    }
    // A no over a partial list proves nothing: the agreement may be in what Jev did not see.
    if (partial) return { outcome: 'flag', reason: 'maintainer_comments_truncated', trace };
    return { ...d, trace };
  };

  if (approval.kind === 'approved_assigned') {
    if (softFlag)
      return {
        outcome: 'flag',
        reason: 'disclosure_multiple',
        issue: approval.issue,
        trace: ruleTrace(base),
      };
    return {
      outcome: 'skip',
      reason: 'compliant',
      rung: 'rule',
      issue: approval.issue,
      trace: ruleTrace(base),
    };
  }
  if (approval.kind === 'assigned_to_other')
    return close({
      outcome: 'close',
      rule: 'assigned_to_other',
      rung: 'rule',
      issues: [approval.issue],
      assignees: approval.assignees,
      trace: ruleTrace(base),
    });
  if (approval.kind === 'approved_unassigned')
    return {
      outcome: 'flag',
      reason: 'approved_unassigned',
      issue: approval.issue,
      trace: ruleTrace(base),
    };

  const pre = minorPrefilter(await changedFiles());
  if (pre.kind === 'out_of_scope')
    return {
      outcome: 'flag',
      reason: 'out_of_scope',
      trace: ruleTrace({ ...base, files: (await changedFiles()).length }),
    };
  if (pre.kind === 'not_minor')
    return close({
      outcome: 'close',
      rule: 'no_approved_issue',
      rung: 'rule',
      issues: approval.unapproved,
      trace: ruleTrace({ ...base, notMinor: pre.reason }),
    });

  const ladder = await climb(minorSteps(diffText(await changedFiles()), deps));
  const trace: TraceEntry[] = [
    { rung: 'rule', outcome: 'undecided', detail: { ...base, lines: pre.lines } },
    ...ladder.trace,
  ];
  if (!ladder.decided) return { outcome: 'flag', reason: 'undecided', trace };
  if (ladder.value) {
    if (softFlag) return { outcome: 'flag', reason: 'disclosure_multiple', trace };
    return { outcome: 'skip', reason: 'minor_fix', rung: ladder.rung, trace };
  }
  return close({
    outcome: 'close',
    rule: 'no_approved_issue',
    rung: ladder.rung,
    issues: approval.unapproved,
    trace,
  });
}
