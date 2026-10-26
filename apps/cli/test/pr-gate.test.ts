import { describe, expect, it } from 'vitest';
import { toCsv, type ComparisonRow } from '../src/commands/pr-gate.js';

const row: ComparisonRow = {
  id: 1,
  pr: 2801,
  head_sha: 'abc',
  state_sha256: 'f'.repeat(64),
  question: 'minor',
  jev_model: 'typesafe/jev-1.14',
  jev_p: 0.95,
  jev_choice: 'link',
  jev_ms: 500,
  jev_tokens: 120,
  jev_error: null,
  clef_model: 'clef',
  clef_p: null,
  clef_choice: null,
  clef_ms: 10000,
  clef_tokens: null,
  clef_error: 'ClefTimeoutError',
  outcome: 'skip',
  human_verdict: 'merged',
  decided_at: '2026-10-26T10:00:00.000Z',
};

describe('pr-gate compare --csv', () => {
  it('writes a header and one line per row, empty cells for null', () => {
    const [header, line] = toCsv([row]).split('\n');
    expect(header?.split(',')).toEqual(Object.keys(row));
    expect(line).toBe(
      `1,2801,abc,${'f'.repeat(64)},minor,typesafe/jev-1.14,0.95,link,500,120,,clef,,,10000,,ClefTimeoutError,skip,merged,2026-10-26T10:00:00.000Z`,
    );
  });

  it('keeps a would-be formula as text, but not a negative number', () => {
    const line = toCsv([{ ...row, clef_model: '=HYPERLINK("x")', jev_p: -1 }]).split('\n')[1];
    expect(line).toContain(`,"'=HYPERLINK(""x"")",`);
    expect(line).toContain(',-1,');
  });

  it('quotes a cell holding a comma or a quote', () => {
    const line = toCsv([{ ...row, jev_error: 'a,"b"' }]).split('\n')[1];
    expect(line).toContain(',"a,""b""",');
  });
});
