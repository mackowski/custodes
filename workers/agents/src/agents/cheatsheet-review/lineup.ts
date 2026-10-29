/**
 * Which model plays which role, with one explicit fallback each (ADR 0017). Changing a model here
 * is a model choice: run `/grill-plan` and the evals first. Pure.
 */
import { REVIEW_MODELS, type ReviewModel, type ReviewModelName } from '@custodes/llm';
import type { ReviewerRole } from './scope.js';

export type Role = ReviewerRole | 'scope-classifier' | 'judge';

export interface Casting {
  primary: ReviewModelName;
  fallback: ReviewModelName;
  max_tokens: number;
}

export const LINEUP: Readonly<Record<Role, Casting>> = {
  'scope-classifier': { primary: 'claudeHaiku', fallback: 'gptOss20b', max_tokens: 2_000 },
  'security-reviewer': { primary: 'claudeOpus', fallback: 'gptAstra', max_tokens: 16_000 },
  'security-second-voice': {
    primary: 'deepseekPro',
    fallback: 'deepseekProOpenRouter',
    max_tokens: 12_000,
  },
  'practicality-reviewer': { primary: 'museSpark', fallback: 'llamaMaverick', max_tokens: 8_000 },
  'duplication-checker': { primary: 'museSpark', fallback: 'llamaMaverick', max_tokens: 8_000 },
  'link-auditor': { primary: 'deepseekFlash', fallback: 'gptLuna', max_tokens: 8_000 },
  'language-reviewer': { primary: 'gptLuna', fallback: 'claudeHaiku', max_tokens: 8_000 },
  judge: { primary: 'gptSol', fallback: 'claudeSonnet', max_tokens: 16_000 },
};

export const SECURITY_ROLES: readonly Role[] = ['security-reviewer', 'security-second-voice'];

export function model(name: ReviewModelName): ReviewModel {
  return REVIEW_MODELS[name];
}

/** What happened to one role: which model answered, and which one failed first, if any. */
export type RoleOutcome =
  | { role: Role; status: 'ran'; model: ReviewModelName }
  | { role: Role; status: 'fallback'; model: ReviewModelName; failed: ReviewModelName; why: string }
  | { role: Role; status: 'unavailable'; tried: ReviewModelName[]; why: string };

/**
 * The multi-model invariant (ADR 0017), checked after fallbacks:
 * - when both security voices were asked for, both answered and come from different vendors;
 * - the judge answered and is a different model from every security voice;
 * - at least two different models answered (a light review may be one vendor's two models).
 * Returns the reason it fails, or null.
 */
export function invariantBreach(outcomes: readonly RoleOutcome[]): string | null {
  const answered = outcomes.filter(
    (o): o is Extract<RoleOutcome, { model: ReviewModelName }> => o.status !== 'unavailable',
  );
  const byRole = new Map(outcomes.map((o) => [o.role, o]));
  const judge = byRole.get('judge');
  if (!judge || judge.status === 'unavailable') return 'judge unavailable';
  const wanted = SECURITY_ROLES.filter((r) => byRole.has(r));
  if (wanted.length > 0) {
    const security = answered.filter((o) => SECURITY_ROLES.includes(o.role));
    if (security.length !== wanted.length) return 'a security reviewer is unavailable';
    const vendors = new Set(security.map((o) => model(o.model).vendor));
    if (vendors.size !== security.length) return 'security reviewers share a vendor';
    if (security.some((o) => o.model === judge.model)) return 'judge is also a security reviewer';
  }
  if (new Set(answered.map((o) => o.model)).size < 2) return 'fewer than two models answered';
  return null;
}
