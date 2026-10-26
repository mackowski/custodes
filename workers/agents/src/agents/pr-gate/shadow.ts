// Clef as a shadow of Jev (ADR 0015): asked the same questions about the same state, never
// deciding. Only Jev's answer reaches the ladder; both are reduced to numbers for the
// model_comparisons table, so nothing from the state or the models is stored.
import type { JevAnswer } from '@custodes/llm';
import { describeError } from '../triage/errors.js';

export type ShadowQuestion = 'minor' | 'approval';

/** The yes/no and the choice question of each set (MINOR_QUESTIONS, APPROVAL_QUESTIONS). */
const KEYS: Record<ShadowQuestion, { yes: string; choice: string }> = {
  minor: { yes: 'minor', choice: 'kind' },
  approval: { yes: 'approved', choice: 'stance' },
};

/** What one model said, or how it failed. Ids, numbers and error classes only. */
export interface ModelCall {
  model?: string;
  /** The yes/no question's probability of yes. */
  p?: number;
  /** The choice question's chosen option, when it looks like an option id. */
  choice?: string;
  ms: number;
  tokens?: number;
  error?: string;
}

export interface Comparison {
  question: ShadowQuestion;
  stateSha256: string;
  jev: ModelCall;
  clef: ModelCall;
}

interface Answered {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens: number };
}

/** Reduces an answer set to the yes/no probability and the choice; anything else is dropped. */
export function reduce(question: ShadowQuestion, res: Answered, ms: number): ModelCall {
  const out: ModelCall = { model: /^[\w@./:-]{1,60}$/.test(res.model) ? res.model : 'other', ms };
  const yes = res.answers[KEYS[question].yes];
  const choice = res.answers[KEYS[question].choice];
  if (yes?.type === 'noul') out.p = Math.round(yes.noul * 1000) / 1000;
  if (choice?.type === 'choice')
    out.choice = /^[a-z_]{1,20}$/.test(choice.choice) ? choice.choice : 'other';
  if (res.usage) out.tokens = res.usage.input_tokens;
  return out;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Calls Jev and, when there is a shadow, Clef at the same time. Returns Jev's result or throws
 * its error, exactly as without a shadow; Clef's failure is only recorded.
 */
export async function shadowed<R extends Answered>(
  question: ShadowQuestion,
  state: string,
  jev: () => Promise<R>,
  clef: (() => Promise<Answered>) | undefined,
  record: (c: Comparison) => void,
  now: () => number = Date.now,
): Promise<R> {
  const timed = async <T extends Answered>(f: () => Promise<T>) => {
    const t0 = now();
    try {
      const r = await f();
      return { r, call: reduce(question, r, now() - t0) };
    } catch (err) {
      return { err, call: { ms: now() - t0, error: describeError(err).slice(0, 60) } };
    }
  };
  if (!clef) {
    return jev();
  }
  const [j, c, sha] = await Promise.all([timed(jev), timed(clef), sha256Hex(state)]);
  record({ question, stateSha256: sha, jev: j.call, clef: c.call });
  if ('err' in j) throw j.err;
  return j.r;
}

/** Both answered, and on the same side of 0.5 with the same choice. */
export function agree(c: {
  jev_p: number | null;
  clef_p: number | null;
  jev_choice: string | null;
  clef_choice: string | null;
}): boolean | undefined {
  if (c.jev_p === null || c.clef_p === null) return undefined;
  return c.jev_p >= 0.5 === c.clef_p >= 0.5 && c.jev_choice === c.clef_choice;
}
