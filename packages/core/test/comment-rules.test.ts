import { describe, expect, it } from 'vitest';
import { commentProblem, mentionsIn } from '../src/comment-rules.js';

const REPO = 'mackowski/custodes-sandbox';

describe('commentProblem', () => {
  it('accepts plain text, issue numbers and references to its own repository', () => {
    expect(commentProblem('Thanks, see #12 and mackowski/custodes-sandbox#3.', REPO)).toBeNull();
    expect(commentProblem('See MACKOWSKI/Custodes-Sandbox#3', REPO)).toBeNull();
    expect(commentProblem('a/b without a number, and # 5', REPO)).toBeNull();
  });

  it('names what a comment may not contain', () => {
    expect(commentProblem('x &#64;y', REPO)).toBe('character_reference');
    expect(commentProblem('hidden <!-- rest', REPO)).toBe('comment_marker');
    expect(commentProblem('see https://example.org', REPO)).toBe('link');
    expect(commentProblem('see OWASP/CheatSheetSeries#1', REPO)).toBe('other_repository');
    expect(commentProblem('see x/mackowski/custodes-sandbox#1', REPO)).toBeNull();
    expect(commentProblem('other/custodes-sandbox#1 and #2', REPO)).toBe('other_repository');
  });

  // CodeQL js/polynomial-redos: the text is written by a model from an author's issue.
  it('stays linear on long runs of name characters', () => {
    const started = performance.now();
    for (const body of ['-'.repeat(200_000), `${'a-'.repeat(100_000)}#1`, '#1'.repeat(100_000)])
      commentProblem(body, REPO);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('mentionsIn', () => {
  it('finds the logins GitHub would notify, each once', () => {
    expect(mentionsIn('hi @alice and (@Bob-1), again @alice, not a@example.org')).toEqual([
      'alice',
      'Bob-1',
    ]);
  });
});
