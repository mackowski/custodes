/**
 * One review of a frozen snapshot (ADR 0017): depth, links, independent reviewers in parallel,
 * then the judge, then the multi-model invariant. No side effects: the agent decides what to post.
 */
import {
  judgeMessage,
  linkMessage,
  reviewerMessage,
  scopeMessage,
  type LinkInput,
  type Snapshot,
} from './input.js';
import {
  anchors,
  checkInternal,
  isExternal,
  knownTargetForm,
  maskedLine,
  scanLinks,
  type AddedLink,
  MAX_EXTERNAL_LINKS,
  type FetchedLink,
} from './links.js';
import { invariantBreach, type RoleOutcome } from './lineup.js';
import { JUDGE_PROMPT, LINK_PROMPT, reviewerPrompt, SCOPE_PROMPT } from './prompts.js';
import { runRole, type RunnerDeps } from './runner.js';
import { classify, isSheet, REVIEWERS_FOR, type ChangeClass, type ReviewerRole } from './scope.js';
import {
  LinkAudit,
  ReviewDecision,
  ReviewerReport,
  ScopeAnswer,
  type Finding,
  normaliseDecision,
} from './types.js';

export interface PipelineDeps extends RunnerDeps {
  fetchLink: (url: string) => Promise<FetchedLink>;
}

export interface PipelineResult {
  changeClass: ChangeClass;
  classWhy: string;
  outcomes: RoleOutcome[];
  reports: { role: ReviewerRole; report: ReviewerReport }[];
  decision: ReviewDecision | undefined;
  /** Why nothing may be published, or null. */
  breach: string | null;
  /** URLs the link auditor fetched successfully: the only ones rendered as links. */
  allowed: Set<string>;
  /** Links to verify by hand (401/403/429/5xx, timeouts, refused hosts). */
  linkNotes: string[];
  injectionSeen: boolean;
  /** The reviewer roles whose reports saw instruction-like text (#79.9). */
  injectionRoles: ReviewerRole[];
  /** #89: every external link that was checked, for the "Links checked" table. */
  linkChecks: LinkCheck[];
}

/** One checked external link, as the review lists it. Status words come from code or the enum. */
export interface LinkCheck {
  url: string;
  file: string;
  line: number;
  moved: boolean;
  status: string;
  /** For a moved link, the previous URL (shown so a swap is visible at a glance). */
  previous?: string;
}

interface LinkStage {
  report: ReviewerReport;
  outcome: RoleOutcome | undefined;
  allowed: Set<string>;
  notes: string[];
  checks: LinkCheck[];
}

async function linkStage(snap: Snapshot, deps: PipelineDeps): Promise<LinkStage> {
  const sheetNames = new Set(snap.sheetNames);
  const findings: Finding[] = [];
  const notes: string[] = [];
  const allowed = new Set<string>();
  const external: { link: AddedLink }[] = [];
  for (const f of snap.files.filter((x) => isSheet(x.file.filename))) {
    const self = f.file.filename.split('/').pop() ?? f.file.filename;
    const own = snap.contents.get(f.file.filename);
    for (const link of scanLinks(f.file.filename, f.hunks).links) {
      if (isExternal(link.url)) {
        external.push({ link });
        continue;
      }
      // javascript:, data:, mailto: and other schemes are never fetched; a person has to look.
      // Not a known target form (//host, &#47;&#47;host, a backslash path, a stray scheme): renderers
      // may resolve it to another host, and nothing here can fetch it. Verify by hand.
      if (!knownTargetForm(link.url) && !/^[a-z][a-z0-9+.-]*:/i.test(link.url)) {
        findings.push({
          severity: 'MAJOR',
          file: link.file,
          line: link.line,
          problem: `Link target in an unusual form (${link.url.slice(0, 40)}…): verify by hand; cheat sheets cite full https URLs or sibling .md files.`,
        });
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(link.url)) {
        findings.push({
          severity: 'MAJOR',
          file: link.file,
          line: link.line,
          problem: `Link with an unsupported scheme (${link.url.slice(0, 20)}…): verify by hand; cheat sheets cite https sources.`,
        });
        continue;
      }
      const check = checkInternal(link.url, self, sheetNames, (file) =>
        file === self && own !== undefined ? anchors(own) : undefined,
      );
      if (!check.ok && check.why !== 'unsupported')
        findings.push({
          severity: 'BLOCKER',
          file: link.file,
          line: link.line,
          problem: `Internal link \`${link.url.slice(0, 200)}\` is broken (${check.why === 'missing_file' ? 'no such cheat sheet' : 'no such heading anchor; the site uses Python-Markdown anchors'}).`,
        });
    }
  }
  const pages: LinkInput[] = [];
  const checks: LinkCheck[] = [];
  const check = (link: AddedLink, status: string) =>
    checks.push({
      url: link.url,
      file: link.file,
      line: link.line,
      moved: link.previous !== undefined,
      status,
      ...(link.previous !== undefined ? { previous: link.previous } : {}),
    });
  for (const { link } of external.slice(0, MAX_EXTERNAL_LINKS)) {
    await deps.guard();
    const got = await deps.limit(() => deps.fetchLink(link.url));
    if (got.kind === 'broken') check(link, `broken (HTTP ${got.status})`);
    else if (got.kind === 'unreachable') check(link, 'verify manually');
    else check(link, 'not judged');
    if (got.kind === 'broken')
      findings.push({
        severity: 'BLOCKER',
        file: link.file,
        line: link.line,
        problem: `Link \`${link.url.slice(0, 300)}\` is broken (HTTP ${got.status}).`,
      });
    else if (got.kind === 'unreachable') notes.push(`${link.url.slice(0, 300)} (${got.why})`);
    else {
      allowed.add(link.url);
      pages.push({
        url: link.url,
        file: link.file,
        line: link.line,
        context: link.context,
        title: got.title,
        excerpt: got.excerpt,
        ...(link.previous !== undefined ? { previous: link.previous } : {}),
      });
    }
  }
  if (external.length > MAX_EXTERNAL_LINKS)
    notes.push(`${external.length - MAX_EXTERNAL_LINKS} more external link(s) were not checked`);

  let outcome: RoleOutcome | undefined;
  let injectionSeen = false;
  if (pages.length > 0) {
    const r = await runRole(deps, 'link-auditor', LinkAudit, LINK_PROMPT, linkMessage(pages));
    outcome = r.outcome;
    injectionSeen = r.answer?.injectionSeen === true;
    for (const v of r.answer?.links ?? []) {
      const page = pages.find((p) => p.url === v.url);
      if (!page) continue;
      const status = linkStatus(v.status, page.previous !== undefined);
      const row = checks.find((c) => c.url === page.url);
      if (row) row.status = status;
      if (status === 'OK' || status === 'SAME-RESOURCE') continue;
      findings.push({
        severity: status === 'LOW-AUTHORITY' || status === 'STALE' ? 'MINOR' : 'BLOCKER',
        file: page.file,
        line: page.line,
        problem: `${status}: \`${page.url.slice(0, 300)}\`${page.previous !== undefined ? ` (moved from \`${page.previous.slice(0, 300)}\`)` : ''}: ${v.reason}`,
      });
      if (status !== 'LOW-AUTHORITY' && status !== 'STALE') allowed.delete(page.url);
    }
    if (r.outcome.status === 'unavailable')
      notes.push('the link auditor was unavailable; sources were not judged');
  }
  const verdict = findings.some((f) => f.severity === 'BLOCKER')
    ? 'BLOCK'
    : findings.length
      ? 'CONCERNS'
      : 'PASS';
  return {
    report: {
      verdict,
      findings,
      injectionSeen,
      notes: `${external.length} external and ${findings.length} flagged link(s)`,
    },
    outcome,
    allowed,
    notes,
    checks,
  };
}

/**
 * The auditor's status, read in the link's mode (#89). A moved link is the same resource only when
 * the model says so (SAME-RESOURCE or OK); WRONG-PAGE counts as DIFFERENT-RESOURCE; STALE stays;
 * UNSUPPORTED or LOW-AUTHORITY means the model doubts the new target and becomes a MINOR. A new link
 * never gets the moved-only statuses: SAME-RESOURCE reads as OK, DIFFERENT-RESOURCE as WRONG-PAGE.
 */
export function linkStatus(status: string, moved: boolean): string {
  if (moved) {
    if (status === 'SAME-RESOURCE' || status === 'OK') return 'SAME-RESOURCE';
    if (status === 'DIFFERENT-RESOURCE' || status === 'WRONG-PAGE') return 'DIFFERENT-RESOURCE';
    if (status === 'STALE') return 'STALE';
    // UNSUPPORTED or LOW-AUTHORITY: the model doubts the new target; a MINOR, never "same".
    return 'LOW-AUTHORITY';
  }
  if (status === 'SAME-RESOURCE') return 'OK';
  if (status === 'DIFFERENT-RESOURCE') return 'WRONG-PAGE';
  return status;
}

/**
 * #89: a suggestion that only touches target-only lines may change link targets, never wording:
 * otherwise it rewrites text the pull request did not change.
 */
function suggestionInScope(
  s: ReviewDecision['suggestions'][number],
  snap: Snapshot,
  targetOnly: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
  const lines = targetOnly.get(s.file);
  if (!lines) return true;
  const start = s.startLine ?? s.line;
  for (let n = start; n <= s.line; n++) if (!lines.has(n)) return true;
  const hunks = snap.files.find((f) => f.file.filename === s.file)?.hunks ?? [];
  const current = hunks
    .flatMap((h) => h.lines)
    .filter((l) => l.newLine !== undefined && l.newLine >= start && l.newLine <= s.line)
    .map((l) => l.text)
    .join('\n');
  return maskedLine(current) === maskedLine(s.replacement);
}

export async function reviewPipeline(snap: Snapshot, deps: PipelineDeps): Promise<PipelineResult> {
  const outcomes: RoleOutcome[] = [];
  let scope = classify(snap.files, snap.unreviewedFiles);
  if (scope.kind === 'ambiguous') {
    const r = await runRole(
      deps,
      'scope-classifier',
      ScopeAnswer,
      SCOPE_PROMPT,
      scopeMessage(snap),
    );
    outcomes.push(r.outcome);
    scope = r.answer
      ? { kind: 'decided', class: r.answer.class, why: `small edit, judged ${r.answer.class}` }
      : {
          kind: 'decided',
          class: 'content',
          why: 'small edit; classifier unavailable, so full review',
        };
  }
  const changeClass = scope.class;
  const roles = REVIEWERS_FOR[changeClass];

  const reports: PipelineResult['reports'] = [];
  const [links, ...others] = await Promise.all([
    roles.includes('link-auditor') ? linkStage(snap, deps) : Promise.resolve(undefined),
    ...roles
      .filter((r): r is Exclude<ReviewerRole, 'link-auditor'> => r !== 'link-auditor')
      .map(async (role) => ({
        role,
        r: await runRole(
          deps,
          role,
          ReviewerReport,
          reviewerPrompt(role),
          reviewerMessage(snap, { withRelated: role === 'duplication-checker' }),
        ),
      })),
  ]);
  if (links) {
    if (links.outcome) outcomes.push(links.outcome);
    reports.push({ role: 'link-auditor', report: links.report });
  }
  for (const o of others) {
    outcomes.push(o.r.outcome);
    if (o.r.answer) reports.push({ role: o.role, report: o.r.answer });
  }
  const notRun = roles.filter((r) => !reports.some((x) => x.role === r));

  const judged = await runRole(
    deps,
    'judge',
    ReviewDecision,
    JUDGE_PROMPT,
    judgeMessage(snap, reports, notRun),
  );
  outcomes.push(judged.outcome);

  // #89: lines whose only change is a link target, for every sheet (also when no link stage ran).
  const targetOnly = new Map(
    snap.files
      .filter((f) => isSheet(f.file.filename))
      .map((f) => [f.file.filename, scanLinks(f.file.filename, f.hunks).targetOnlyLines] as const),
  );
  const reviewerBlocked = reports.some(
    (x) =>
      x.report.verdict === 'BLOCK' &&
      (x.role === 'security-reviewer' ||
        x.role === 'security-second-voice' ||
        x.role === 'link-auditor'),
  );
  const scoped = (d: ReviewDecision): ReviewDecision => {
    const n = normaliseDecision(d, reviewerBlocked, targetOnly);
    return {
      ...n,
      suggestions: n.suggestions.filter((x) => suggestionInScope(x, snap, targetOnly)),
    };
  };
  return {
    changeClass,
    classWhy: scope.why,
    outcomes,
    reports,
    decision: judged.answer && scoped(judged.answer),
    breach: invariantBreach(outcomes),
    allowed: links?.allowed ?? new Set(),
    linkNotes: links?.notes ?? [],
    injectionSeen: reports.some((x) => x.report.injectionSeen === true),
    injectionRoles: reports.filter((x) => x.report.injectionSeen === true).map((x) => x.role),
    linkChecks: links?.checks ?? [],
  };
}
