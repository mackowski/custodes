import { invokeAgent, type Turn } from '@custodes/core';
import { AgentHaltedError } from '@custodes/core/agent';
import { parseStructured } from '@custodes/llm';
import { RawAssessment, validateAssessment, type Assessment } from './assess.js';
import { describeError, isInputSpecific, isRequestRefused } from './errors.js';
import type { BrokerGitHubReader, PublicIssue } from './github.js';
import { buildUserMessage, isSafeName, SYSTEM_PROMPT, type TriageContext } from './prompt.js';

export interface TriageStore {
  /** True when this issue was already assessed at this `updated_at`. */
  isCurrent(issue: number, updatedAt: string): boolean;
  /** Failures counted against this issue at this `updated_at` (see `runTriage`). */
  failures(issue: number, updatedAt: string): number;
  /** Records one failure that is about this issue and returns the new count. */
  recordFailure(issue: number, updatedAt: string): number;
  save(issue: PublicIssue, assessment: Assessment, now: Date): void;
}

export interface TriageDeps {
  reader: Pick<
    BrokerGitHubReader,
    'listUpdatedIssues' | 'listRecentIssueTitles' | 'listLabels' | 'listCheatSheets'
  >;
  /** Sends one prompt to the model and returns its raw text. */
  complete(system: string, user: string, issue: number, turn?: Turn): Promise<string>;
  /** The trace turn for one issue (ADR 0016); absent means untraced. */
  turn?(issue: number): Turn;
  store: TriageStore;
  now(): Date;
}

export interface TriageRunResult {
  assessed: number;
  skipped: number;
  errors: string[];
  nextSince: string;
}

/** Maximum issues assessed per run: bounds model spend and GitHub API use. */
export const MAX_PER_RUN = 15;
/** An issue whose output is unusable this many times (same content) is skipped until it changes. */
export const MAX_ATTEMPTS = 3;
/** Consecutive infrastructure failures after which the run stops instead of hammering a broken path. */
export const MAX_CONSECUTIVE_INFRA_FAILURES = 3;

/**
 * A fixed, harmless issue. When a run assessed nothing and requests were refused, it goes through
 * the same request as a real one: an answer means the path works and the refusals were about those
 * issues; a failure means an outage (or a request the provider rejects whatever the text).
 */
const PROBE: PublicIssue = {
  number: 0,
  title: 'Connectivity check',
  body: 'This is a fixed test message, not a real issue.',
  html_url: 'https://github.com/',
  user: null,
  labels: [],
  created_at: '1970-01-01T00:00:00Z',
  updated_at: '1970-01-01T00:00:00Z',
  comments: 0,
};

/**
 * One triage pass: read public data, assess changed issues, store validated results.
 * Pure orchestration; all I/O is injected so it is tested without network access.
 */
export async function runTriage(
  repo: string,
  since: string,
  deps: TriageDeps,
): Promise<TriageRunResult> {
  const startedAt = deps.now();
  const [allLabels, allCheatSheets, recent, { issues, resumeAt }] = await Promise.all([
    deps.reader.listLabels(repo),
    deps.reader.listCheatSheets(repo),
    deps.reader.listRecentIssueTitles(repo, 50),
    deps.reader.listUpdatedIssues(repo, since),
  ]);
  // Only names that pass the prompt's safe charset unchanged are offered and accepted, so the model
  // sees exactly the list it is validated against.
  const labels = allLabels.filter(isSafeName);
  const cheatSheets = allCheatSheets.filter(isSafeName);
  const ctx: TriageContext = { repo, labels, cheatSheets, recent };
  let firstFailedUpdate: string | null = null;
  const errors: string[] = [];
  let assessed = 0;
  let skipped = 0;
  let consecutiveInfra = 0;
  const infraFailed: PublicIssue[] = [];
  /** The run's last model outcome was a refused request. */
  let endedRefused = false;
  let attempted = 0;
  /** Where the run stopped at its cap: the first issue it did not get to. */
  let cutAt: string | null = null;
  for (const issue of issues) {
    if (
      deps.store.isCurrent(issue.number, issue.updated_at) ||
      deps.store.failures(issue.number, issue.updated_at) >= MAX_ATTEMPTS
    ) {
      skipped++;
      continue;
    }
    // The cap counts issues that need work, not the ones skipped above: otherwise 15 assessed
    // issues sharing one timestamp (a bulk label) would fill every run and nothing after them
    // would ever be reached.
    if (attempted >= MAX_PER_RUN) {
      cutAt = issue.updated_at;
      break;
    }
    attempted++;
    try {
      const turn = deps.turn?.(issue.number);
      const assessment = await invokeAgent(turn, async (span) => {
        const text = await deps.complete(
          SYSTEM_PROMPT,
          buildUserMessage(issue, ctx),
          issue.number,
          turn,
        );
        const raw = parseStructured(RawAssessment, text);
        const a = validateAssessment(raw, {
          issue: issue.number,
          labels,
          cheatSheets,
          recentIssues: recent.map((r) => r.number),
        });
        span.set('custodes.outcome', a.kind);
        return a;
      });
      deps.store.save(issue, assessment, deps.now());
      assessed++;
      consecutiveInfra = 0;
      endedRefused = false;
    } catch (err) {
      if (err instanceof AgentHaltedError) throw err; // a halt stops the run; the cursor is kept
      // Never include model output or issue text in the error: class, status and error type only.
      const what = describeError(err);
      if (isInputSpecific(err)) {
        consecutiveInfra = 0;
        const attempts = deps.store.recordFailure(issue.number, issue.updated_at);
        if (attempts >= MAX_ATTEMPTS) {
          errors.push(`#${issue.number}: gave up after ${attempts} attempts (${what})`);
        } else {
          firstFailedUpdate ??= issue.updated_at;
          errors.push(`#${issue.number}: ${what}`);
        }
      } else {
        firstFailedUpdate ??= issue.updated_at;
        errors.push(`#${issue.number}: ${what}`);
        if (isRequestRefused(err)) infraFailed.push(issue);
        endedRefused = isRequestRefused(err);
        if (++consecutiveInfra >= MAX_CONSECUTIVE_INFRA_FAILURES) {
          errors.push(`stopped after ${consecutiveInfra} consecutive infrastructure failures`);
          break;
        }
      }
    }
  }
  // A refused request (a 4xx that is not a timeout or a rate limit) while the model path works is
  // about that issue (a guardrail block, a provider 400 on its text), not an outage: count it, so
  // it cannot hold the cursor and cost a model call on every poll for ever. The path works when
  // another issue was assessed in this run or, failing that, when the probe gets an answer: three
  // refused issues at the front of every run would otherwise stop triage for good. In an outage
  // the probe fails too and nothing is counted; a 429, a 5xx or a timeout is never counted, or a
  // flood of issues could push real ones out of triage.
  // A success before the refusals proves nothing about now (an outage can start mid-run, and an
  // empty credit balance answers 400): then the probe decides as well.
  let pathWorks = assessed > 0 && !endedRefused;
  if (!pathWorks && infraFailed.length > 0)
    try {
      await deps.complete(SYSTEM_PROMPT, buildUserMessage(PROBE, ctx), PROBE.number);
      pathWorks = true;
    } catch (err) {
      if (err instanceof AgentHaltedError) throw err;
      // An unusable answer is still an answer.
      pathWorks = isInputSpecific(err);
      // Refused like the issues: an outage, or something every request shares (a label or a
      // recent title a guardrail blocks). The operator has to look; nothing is counted.
      if (isRequestRefused(err)) errors.push(`probe refused too (${describeError(err)})`);
    }
  if (pathWorks)
    for (const issue of infraFailed) {
      const attempts = deps.store.recordFailure(issue.number, issue.updated_at);
      if (attempts >= MAX_ATTEMPTS)
        errors.push(
          `#${issue.number}: gave up after ${attempts} attempts (refused while other requests were answered)`,
        );
    }
  // Issues arrive oldest update first. If the reader did not see everything, resume where it
  // stopped (an issue already assessed is skipped next time as current); otherwise everything up
  // to now is covered. A failed issue (model or gateway error) is retried next run: never move the
  // cursor past it.
  const nextSince = firstFailedUpdate ?? cutAt ?? resumeAt ?? startedAt.toISOString();
  return { assessed, skipped, errors, nextSince };
}
