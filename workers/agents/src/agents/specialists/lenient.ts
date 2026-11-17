import { z } from 'zod';

/**
 * Tolerant model-output fields. A reasoning model sometimes writes a longer explanation, one more
 * evidence item or "#123" instead of 123; rejecting the whole answer for that wasted reasoning
 * calls (four StructuredOutputErrors in a row on 2026-10-07/08). Shape and types still have to
 * match, and everything is validated against repository data afterwards; only sizes are forgiven.
 */
export const text = (max: number) => z.string().transform((s) => s.slice(0, max));

export const list = <T extends z.ZodType>(item: T, max: number) =>
  z.array(item).transform((a) => a.slice(0, max));

/** 0..1, clamped. */
export const unit = z.number().transform((n) => Math.min(1, Math.max(0, n)));

/** An issue or PR number given as 123 or "#123", or null. One definition of the accepted range. */
export function toIssueNumber(v: number | string): number | null {
  const n = typeof v === 'number' ? v : Number(v.replace(/^#/, ''));
  return Number.isInteger(n) && n > 0 && n <= 1_000_000 ? n : null;
}

/** Issue or PR numbers given as 123 or "#123"; anything else is dropped. */
export const numbers = (max: number) =>
  z.array(z.union([z.number(), z.string()])).transform((a) =>
    a
      .map(toIssueNumber)
      .filter((n): n is number => n !== null)
      .slice(0, max),
  );
