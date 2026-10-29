/**
 * One review of a frozen snapshot (ADR 0017): depth, links, independent reviewers in parallel,
 * then the judge, then the multi-model invariant. No side effects: the agent decides what to post.
 */
import { addedLines } from './diff.js';
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
  extractLinks,
  isExternal,
  MAX_EXTERNAL_LINKS,
  type FetchedLink,
} from './links.js';
import { invariantBreach, type RoleOutcome } from './lineup.js';
import { JUDGE_PROMPT, LINK_PROMPT, reviewerPrompt, SCOPE_PROMPT } from './prompts.js';
import { runRole, type RunnerDeps } from './runner.js';
import { classify, isSheet, REVIEWERS_FOR, type ChangeClass, type ReviewerRole } from './scope.js';
import { LinkAudit, ReviewDecision, ReviewerReport, ScopeAnswer, type Finding } from './types.js';

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
}

interface LinkStage {
  report: ReviewerReport;
  outcome: RoleOutcome | undefined;
  allowed: Set<string>;
  notes: string[];
}

async function linkStage(snap: Snapshot, deps: PipelineDeps): Promise<LinkStage> {
  const sheetNames = new Set(snap.sheetNames);
  const findings: Finding[] = [];
  const notes: string[] = [];
  const allowed = new Set<string>();
  const external: { link: ReturnType<typeof extractLinks>[number] }[] = [];
  for (const f of snap.files.filter((x) => isSheet(x.file.filename))) {
    const self = f.file.filename.split('/').pop() ?? f.file.filename;
    const own = snap.contents.get(f.file.filename);
    for (const link of extractLinks(f.file.filename, addedLines(f.hunks))) {
      if (isExternal(link.url)) {
        external.push({ link });
        continue;
      }
      // javascript:, data:, mailto: and other schemes are never fetched; a person has to look.
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
  for (const { link } of external.slice(0, MAX_EXTERNAL_LINKS)) {
    await deps.guard();
    const got = await deps.limit(() => deps.fetchLink(link.url));
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
      if (!page || v.status === 'OK') continue;
      findings.push({
        severity: v.status === 'LOW-AUTHORITY' || v.status === 'STALE' ? 'MINOR' : 'BLOCKER',
        file: page.file,
        line: page.line,
        problem: `${v.status}: \`${page.url.slice(0, 300)}\`: ${v.reason}`,
      });
      if (v.status !== 'LOW-AUTHORITY' && v.status !== 'STALE') allowed.delete(page.url);
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
  };
}

export async function reviewPipeline(snap: Snapshot, deps: PipelineDeps): Promise<PipelineResult> {
  const outcomes: RoleOutcome[] = [];
  let scope = classify(snap.files);
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

  return {
    changeClass,
    classWhy: scope.why,
    outcomes,
    reports,
    decision: judged.answer,
    breach: invariantBreach(outcomes),
    allowed: links?.allowed ?? new Set(),
    linkNotes: links?.notes ?? [],
    injectionSeen: reports.some((x) => x.report.injectionSeen === true),
  };
}
