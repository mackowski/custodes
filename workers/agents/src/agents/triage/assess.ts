import { z } from 'zod';
import { inertText } from '@custodes/llm';

export const TriageKind = z.enum(['bug', 'new_cheat_sheet', 'update', 'question', 'spam', 'other']);

/** What the model must return. Anything else is rejected before it reaches storage or e-mail. */
export const RawAssessment = z.object({
  labels: z.array(z.string().max(60)).max(8),
  cheatSheet: z.string().max(150).nullable(),
  possibleDuplicates: z.array(z.number().int().positive()).max(5),
  kind: TriageKind,
  needsMaintainer: z.boolean(),
  summary: z.string().max(1000),
  injectionDetected: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type RawAssessment = z.infer<typeof RawAssessment>;

export const Assessment = RawAssessment.extend({
  /** Suggestions the model made that did not match real repo data and were dropped. */
  dropped: z.array(z.string()),
});
export type Assessment = z.infer<typeof Assessment>;

export interface KnownData {
  issue: number;
  labels: string[];
  cheatSheets: string[];
  recentIssues: number[];
}

/** Untrusted or model text for the digest: no links, no hidden characters, one line, bounded. */
export function inertNoLinks(s: string, maxChars: number): string {
  const unlinked = s
    .replace(/\bhttps?:\/\/\S+/gi, '[link removed]')
    .replace(/\bwww\.\S+/gi, '[link removed]')
    .replace(/(^|[\s("'<])\/\/\S+/g, '$1[link removed]')
    // Bare domain with a path: mail clients turn it into a link.
    .replace(/\b[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*/gi, '[link removed]');
  return inertText(unlinked, maxChars);
}

/** Model summary for the digest. */
export function sanitizeSummary(s: string): string {
  return inertNoLinks(s, 300);
}

/** Keeps only suggestions that refer to things that actually exist in the repository. */
export function validateAssessment(raw: RawAssessment, known: KnownData): Assessment {
  const dropped: string[] = [];
  const labelMap = new Map(known.labels.map((l) => [l.toLowerCase(), l]));
  const labels: string[] = [];
  for (const l of raw.labels) {
    const canonical = labelMap.get(l.toLowerCase());
    if (canonical && !labels.includes(canonical)) labels.push(canonical);
    else if (!canonical) dropped.push(`label "${inertNoLinks(l, 40)}"`);
  }
  let cheatSheet = raw.cheatSheet;
  if (cheatSheet !== null && !known.cheatSheets.includes(cheatSheet)) {
    dropped.push(`cheat sheet "${inertNoLinks(cheatSheet, 60)}"`);
    cheatSheet = null;
  }
  const possibleDuplicates: number[] = [];
  for (const n of raw.possibleDuplicates) {
    if (n !== known.issue && known.recentIssues.includes(n) && !possibleDuplicates.includes(n)) {
      possibleDuplicates.push(n);
    } else if (n !== known.issue && !known.recentIssues.includes(n)) {
      dropped.push(`duplicate #${n}`);
    }
  }
  return {
    ...raw,
    labels,
    cheatSheet,
    possibleDuplicates,
    summary: sanitizeSummary(raw.summary),
    dropped,
  };
}
