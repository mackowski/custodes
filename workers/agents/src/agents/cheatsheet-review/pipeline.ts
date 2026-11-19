/**
 * One review of a frozen snapshot (ADR 0017): depth, links, independent reviewers in parallel,
 * the claim check (#90), then the judge, then the multi-model invariant. No side effects: the
 * agent decides what to post.
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
  MAX_LINK_LINE,
  anchors,
  checkInternal,
  isExternal,
  knownTargetForm,
  maskedLine,
  mergeCitation,
  citedText,
  scanLinks,
  type AddedLink,
  MAX_EXTERNAL_LINKS,
  NON_TEXT_MARK,
  type FetchedLink,
  type SourceDoc,
} from './links.js';
import {
  claimStage,
  enforceClaims,
  withoutMachinery,
  judgeClaims,
  reportsForJudge,
  type ClaimResult,
} from './claims.js';
import { invariantBreach, type RoleOutcome } from './lineup.js';
import {
  JUDGE_PROMPT,
  LINK_PROMPT,
  reviewerPrompt,
  SCOPE_PROMPT,
  SOURCES_PROMPT,
} from './prompts.js';
import { runOnce, runRole, type RunnerDeps } from './runner.js';
import { fetchSources, mergePasses, sourcesMessage, type FetchedSource } from './sources.js';
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
  /** #90: a claim's source, full text (PDFs through Workers AI toMarkdown). */
  fetchSource: (url: string) => Promise<SourceDoc>;
}

export type BlockingDimension = 'Security' | 'Links & sources';

/**
 * Which dimensions a security or links reviewer blocked. Both uses read this: the pipeline never
 * promotes such a review to MERGE, and the agent posts it as REQUEST_CHANGES. Two copies of the
 * role list could disagree the next time the lineup changes.
 */
export function blockingDimensions(
  reports: readonly { role: ReviewerRole; report: ReviewerReport }[],
): Set<BlockingDimension> {
  const out = new Set<BlockingDimension>();
  for (const x of reports) {
    if (x.report.verdict !== 'BLOCK') continue;
    if (x.role === 'security-reviewer' || x.role === 'security-second-voice') out.add('Security');
    if (x.role === 'link-auditor') out.add('Links & sources');
  }
  return out;
}

export interface PipelineResult {
  changeClass: ChangeClass;
  classWhy: string;
  outcomes: RoleOutcome[];
  reports: { role: ReviewerRole; report: ReviewerReport }[];
  /** The dimensions whose reviewer said BLOCK: one rule for "never MERGE" and "REQUEST_CHANGES". */
  blockedBy: ReadonlySet<BlockingDimension>;
  decision: ReviewDecision | undefined;
  /** Why nothing may be published, or null. */
  breach: string | null;
  /** URLs the link auditor fetched successfully: the only ones rendered as links. */
  allowed: Set<string>;
  /** Links to verify by hand (401/403/429/5xx, timeouts, refused hosts). */
  linkNotes: string[];
  injectionSeen: boolean;
  /** The reviewer roles (and the claim verifier) whose answers saw instruction-like text (#79.9). */
  injectionRoles: (ReviewerRole | 'claim-verifier')[];
  /** #89: every external link that was checked, for the "Links checked" table. */
  linkChecks: LinkCheck[];
  /**
   * #90: every claim a reviewer made, with its verdict. NOT-FOUND ones are listed for the maintainer;
   * REFUTED ones are left out of the review and recorded for the operator.
   */
  claims: ClaimResult[];
  /** #90: judge items and suggestions code removed because they were about an unconfirmed claim. */
  claimItemsRemoved: number;
  /** #155: judge sentences about the review's own machinery, removed by code. */
  machinerySentencesRemoved: number;
  /** ADR 0020: what the security reviewer's source fetch did; undefined when it asked for none. */
  sources: SourceLog | undefined;
}

export interface SourceLog {
  fetched: FetchedSource[];
  /** The second pass: ran, failed, or skipped because no page could be read. */
  pass2: 'ran' | 'failed' | 'skipped';
  added: number;
}

interface SourcePass {
  report: ReviewerReport;
  /** Findings from pass 1: the merged report's first ones (mergePasses keeps them in order). */
  pass1Findings: number;
  /** Pass 1's own verdict: a pass-2 finding that is refuted or unchecked never lowers it. */
  pass1Verdict: ReviewerReport['verdict'];
  docs: ReadonlyMap<string, SourceDoc>;
  log: SourceLog | undefined;
}

/**
 * ADR 0020: when the security reviewer asked for sources, fetch them and give them to the model that
 * answered pass 1. Only additions survive (`mergePasses`); with no request, or no model to ask, pass 1
 * stands. Never throws for a fetch or a model failure.
 */
async function sourcePass(
  outcome: RoleOutcome,
  pass1: ReviewerReport,
  input: string,
  deps: PipelineDeps,
): Promise<SourcePass> {
  const asked = pass1.sourceRequests ?? [];
  if (asked.length === 0 || outcome.status === 'unavailable')
    return {
      report: mergePasses(pass1, undefined),
      pass1Findings: pass1.findings.length,
      pass1Verdict: pass1.verdict,
      docs: new Map(),
      log: undefined,
    };
  const { log, docs } = await fetchSources(asked, deps);
  const pass2 =
    docs.size === 0
      ? undefined
      : await runOnce(
          deps,
          'security-reviewer',
          outcome.model,
          ReviewerReport,
          SOURCES_PROMPT,
          sourcesMessage(input, pass1, log, docs),
        );
  const report = mergePasses(pass1, pass2, new Set(docs.keys()));
  return {
    report,
    pass1Findings: pass1.findings.length,
    pass1Verdict: pass1.verdict,
    docs,
    log: {
      fetched: log,
      pass2: docs.size === 0 ? 'skipped' : pass2 ? 'ran' : 'failed',
      added: report.findings.length - pass1.findings.length,
    },
  };
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
  /** For a new link that replaced a link on another site: the old URL, display only. */
  replaced?: string;
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
  const externalByUrl = new Map<string, { link: AddedLink }>();
  for (const f of snap.files.filter((x) => isSheet(x.file.filename))) {
    const self = f.file.filename.split('/').pop() ?? f.file.filename;
    const own = snap.contents.get(f.file.filename);
    const scan = scanLinks(f.file.filename, f.hunks, f.codeLines);
    // A line too long to scan is verified by hand, never skipped (review of #125, M3).
    for (const line of scan.longLines)
      findings.push({
        severity: 'MAJOR',
        file: f.file.filename,
        line,
        problem: `Line too long to audit its links (over ${MAX_LINK_LINE} characters): verify every link on it by hand.`,
      });
    // Code-sample markup inside fenced code is dropped in scanLinks (the XSS sheet is full of it).
    for (const link of scan.links) {
      // Not a known target form (//host, &#47;&#47;host, a backslash or entity in an https host, a
      // stray scheme is handled below): what renders may differ from what we would fetch. Verify by
      // hand, before anything is fetched.
      if (!knownTargetForm(link.url) && !/^[a-z][a-z0-9+.-]*:(?!\/\/)/i.test(link.url)) {
        findings.push({
          severity: 'MAJOR',
          file: link.file,
          line: link.line,
          problem: `Link target in an unusual form (${link.url.slice(0, 40)}…): verify by hand; cheat sheets cite full https URLs or sibling .md files.`,
        });
        continue;
      }
      if (isExternal(link.url)) {
        // One fetch and one verdict per URL, at its first place, for every sentence that cites it
        // (mergeCitation). scanLinks dedupes within a file only; the auditor answers by URL, so the
        // same URL in two sheets got both answers on the first one and used two of the
        // MAX_EXTERNAL_LINKS places.
        const prior = externalByUrl.get(link.url);
        if (prior === undefined) {
          const entry = { link };
          externalByUrl.set(link.url, entry);
          external.push(entry);
        } else mergeCitation(prior.link, link);
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
  const checks: LinkCheck[] = [];
  const check = (link: AddedLink, status: string) =>
    checks.push({
      url: link.url,
      file: link.file,
      line: link.line,
      moved: link.previous !== undefined,
      status,
      ...(link.previous !== undefined ? { previous: link.previous } : {}),
      ...(link.replaced !== undefined ? { replaced: link.replaced } : {}),
    });
  for (const { link } of external.slice(0, MAX_EXTERNAL_LINKS)) {
    // The reason comes first: the note is cut at 400 characters when rendered.
    if (link.unaudited)
      notes.push(
        `not checked: further sentences at ${link.unaudited
          .slice(0, 5)
          .map((u) => `${u.file}:${u.line}`)
          .join(
            ', ',
          )}${link.unaudited.length > 5 ? ' and more' : ''} cite ${link.url.slice(0, 200)}`,
      );
    for (const m of (link.movedAt ?? []).slice(0, 5))
      notes.push(
        `link change not checked: at ${m.file}:${m.line} ${link.url.slice(0, 150)} replaces ${m.previous.slice(0, 150)}`,
      );
    await deps.guard();
    const got = await deps.limit(() => deps.fetchLink(link.url));
    // A page with no text (a script-rendered shell) or a file that is not text (a PDF) cannot
    // support or refute anything: the auditor would answer UNSUPPORTED for a correct source (OWASP
    // PR 3008, crbug.com). Code says "verify manually" instead; the page is not sent and not linked.
    const unreadable =
      got.kind === 'page' &&
      (`${got.title}${got.excerpt}`.trim() === '' || got.excerpt.startsWith(NON_TEXT_MARK));
    if (got.kind === 'broken') check(link, `broken (HTTP ${got.status})`);
    else if (got.kind === 'unreachable' || unreadable) check(link, 'verify manually');
    else check(link, 'not checked');
    if (got.kind === 'broken')
      findings.push({
        severity: 'BLOCKER',
        file: link.file,
        line: link.line,
        problem: `Link \`${link.url.slice(0, 300)}\` is broken (HTTP ${got.status}).`,
      });
    else if (got.kind === 'unreachable') notes.push(`${link.url.slice(0, 300)} (${got.why})`);
    else if (unreadable)
      notes.push(`${link.url.slice(0, 300)} (could not read the page; check it by hand)`);
    else {
      allowed.add(link.url);
      pages.push({
        url: link.url,
        file: link.file,
        line: link.line,
        context: citedText(link),
        ...(link.more?.length
          ? { also: link.more.map((m) => `${m.file}:${m.line}`).join(', ') }
          : {}),
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
      // Injection taints the auditor's own call, as it does the verifier's: no OK and no UNCLEAR
      // note, a MINOR to check by hand instead (ninth security review of #155).
      const said = linkStatus(v.status, page.previous !== undefined);
      const status =
        injectionSeen && (said === 'OK' || said === 'SAME-RESOURCE' || said === 'UNCLEAR')
          ? 'UNSUPPORTED'
          : said;
      const row = checks.find((c) => c.url === page.url);
      if (row) row.status = status;
      if (status === 'OK' || status === 'SAME-RESOURCE') continue;
      if (status === 'UNCLEAR') {
        // #155: the excerpt did not reach the cited place: a note, never a finding, and never a
        // live link (the audit did not accept it).
        if (row) row.status = 'verify manually';
        allowed.delete(page.url);
        notes.push(
          `${page.url.slice(0, 300)} (the cited place was not in the excerpt; check it by hand)`,
        );
        continue;
      }
      // #155: a model's reading of a page never blocks on its own (OWASP PRs 2955, 2956, 3005: the
      // page did support the sentence). It is a MINOR the maintainer checks by hand; a broken link,
      // a long line or a disallowed form still blocks.
      const doubt = status === 'LOW-AUTHORITY' || status === 'STALE' ? '' : ' (check by hand)';
      findings.push({
        severity: 'MINOR',
        file: page.file,
        line: page.line,
        problem: `${status}${doubt}: \`${page.url.slice(0, 300)}\`${page.previous !== undefined ? ` (moved from \`${page.previous.slice(0, 300)}\`)` : ''}${page.also ? ` (also cited at ${page.also})` : ''}: ${v.reason}`,
      });
      if (status !== 'LOW-AUTHORITY' && status !== 'STALE') allowed.delete(page.url);
    }
    if (r.outcome.status === 'unavailable')
      notes.push('the sources could not be checked; check them by hand');
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
  if (status === 'UNCLEAR') return 'UNCLEAR';
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
  let sources: SourcePass | undefined;
  const [links, ...others] = await Promise.all([
    roles.includes('link-auditor') ? linkStage(snap, deps) : Promise.resolve(undefined),
    ...roles
      .filter((r): r is Exclude<ReviewerRole, 'link-auditor'> => r !== 'link-auditor')
      .map(async (role) => {
        const input = reviewerMessage(snap, { withRelated: role === 'duplication-checker' });
        const r = await runRole(deps, role, ReviewerReport, reviewerPrompt(role), input);
        // sourceRequests is the security reviewer's only; any other role's is dropped here.
        if (role !== 'security-reviewer' || !r.answer)
          return { role, r: r.answer ? { ...r, answer: mergePasses(r.answer, undefined) } : r };
        // ADR 0020: the security reviewer's sources, read in a second pass by the same model.
        sources = await sourcePass(r.outcome, r.answer, input, deps);
        return { role, r: { ...r, answer: sources.report } };
      }),
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

  // ADR 0020: claims on findings pass 2 added are checked last, never remove or demote a judge item
  // (which may be pass 1's), and the judge is not told about refuted ones (security review of #155).
  const pass1Findings = sources?.pass1Findings;
  const added = (r: { role: ReviewerRole; index: number }) =>
    r.role === 'security-reviewer' && pass1Findings !== undefined && r.index >= pass1Findings;
  // #90: claims are checked before the judge, which sees only what the verdicts leave.
  const claims = await claimStage(snap, reports, deps, sources?.docs, (role, index) =>
    added({ role, index }),
  );
  if (claims.outcome) outcomes.push(claims.outcome);
  // Security review of #155: injection turns every verifier verdict into NOT-FOUND; detecting an
  // attack (by the verifier or by pass 2 in a fetched page) must never weaken the review.
  const demoteUnchecked =
    !claims.injectionSeen && !reports.some((x) => x.report.injectionSeen === true);
  const judgedReports = reportsForJudge(
    reports,
    claims.results,
    demoteUnchecked,
    sources && {
      late: (role, index) => added({ role, index }),
      floor: new Map([['security-reviewer', sources.pass1Verdict]]),
    },
  );

  const judged = await runRole(
    deps,
    'judge',
    ReviewDecision,
    JUDGE_PROMPT,
    judgeMessage(
      snap,
      judgedReports,
      notRun,
      judgeClaims(claims.results.filter((r) => !(added(r) && r.verdict === 'REFUTED'))),
    ),
  );
  outcomes.push(judged.outcome);
  const enforced =
    judged.answer &&
    enforceClaims(
      judged.answer,
      // A NOT-FOUND claim on an added finding still marks (and may demote) its own item; backed()
      // keeps any item a pass-1 finding stands behind (fifth security review of #155).
      claims.results.filter((r) => !added(r) || r.verdict === 'NOT-FOUND'),
      { demoteUnchecked, reports, late: (role, index) => added({ role, index }) },
    );
  const plain = enforced && withoutMachinery(enforced.decision);

  // #89: lines whose only change is a link target, for every sheet (also when no link stage ran).
  const targetOnly = new Map(
    snap.files
      .filter((f) => isSheet(f.file.filename))
      .map(
        (f) =>
          [
            f.file.filename,
            scanLinks(f.file.filename, f.hunks, f.codeLines).targetOnlyLines,
          ] as const,
      ),
  );
  // The original reports minus REFUTED findings (reportsForJudge); a BLOCKER whose claim is
  // NOT-FOUND no longer blocks (#155). The agent reads the same reports for reviewEvent.
  const blockedBy = blockingDimensions(judgedReports);
  const reviewerBlocked = blockedBy.size > 0;
  const scoped = (d: ReviewDecision): ReviewDecision => {
    // #91: an entry must name a maintainer whose request was shown; anything else is dropped.
    const shown = new Set((snap.requests ?? []).map((r) => r.by.toLowerCase()));
    const earlierRequests = d.earlierRequests
      .map((e) => ({ ...e, by: e.by.replace(/^@/, '') }))
      .filter((e) => shown.has(e.by.toLowerCase()));
    // An open maintainer request blocks the promotion of REQUEST_CHANGES to MERGE.
    const open = earlierRequests.some((e) => e.status === 'open');
    const n = normaliseDecision({ ...d, earlierRequests }, reviewerBlocked || open, targetOnly);
    return {
      ...n,
      suggestions: n.suggestions.filter((x) => suggestionInScope(x, snap, targetOnly)),
    };
  };
  return {
    changeClass,
    classWhy: scope.why,
    outcomes,
    reports: judgedReports,
    blockedBy,
    decision: plain && scoped(plain.decision),
    breach: invariantBreach(outcomes),
    allowed: links?.allowed ?? new Set(),
    linkNotes: links?.notes ?? [],
    injectionSeen: claims.injectionSeen || reports.some((x) => x.report.injectionSeen === true),
    injectionRoles: [
      ...reports.filter((x) => x.report.injectionSeen === true).map((x) => x.role),
      ...(claims.injectionSeen ? (['claim-verifier'] as const) : []),
    ],
    linkChecks: links?.checks ?? [],
    claims: claims.results,
    claimItemsRemoved: enforced?.removed ?? 0,
    machinerySentencesRemoved: plain?.removed ?? 0,
    sources: sources?.log,
  };
}
