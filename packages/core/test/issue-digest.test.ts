import { describe, expect, it } from 'vitest';
import { canonicalJson, commentsDigest, sha256Hex } from '../src/index.js';

describe('commentsDigest (ADR 0019 snapshot)', () => {
  it('is sha256 of the canonical [id, updated_at] list, in thread order', async () => {
    const comments = [
      { id: 1, updated_at: '2026-11-10T10:00:00Z', body: 'ignored', user: { login: 'a' } },
      { id: 2, updated_at: '2026-11-11T10:00:00Z' },
    ];
    expect(await commentsDigest(comments)).toBe(
      await sha256Hex(
        canonicalJson([
          [1, '2026-11-10T10:00:00Z'],
          [2, '2026-11-11T10:00:00Z'],
        ]),
      ),
    );
    // No comments: sha256 of "[]".
    expect(await commentsDigest([])).toBe(
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    );
  });

  it('changes on an edit, on a delete-and-add, and on order; ignores bodies', async () => {
    const a = [
      { id: 1, updated_at: 't1' },
      { id: 2, updated_at: 't2' },
    ];
    const base = await commentsDigest(a);
    expect(await commentsDigest([a[0], { id: 2, updated_at: 't3' }])).not.toBe(base);
    expect(await commentsDigest([a[0], { id: 3, updated_at: 't2' }])).not.toBe(base);
    expect(await commentsDigest([a[1], a[0]])).not.toBe(base);
    expect(await commentsDigest(a.map((c) => ({ ...c, body: 'edited text' })))).toBe(base);
    expect(await commentsDigest([null, {}])).toBe(await sha256Hex('[[null,null],[null,null]]'));
  });
});
