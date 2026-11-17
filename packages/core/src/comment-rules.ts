/**
 * What a comment an agent proposes may not contain (ADR 0019). One definition: triage-apply drops
 * such a comment from its bundle and the broker refuses the bundle again before asking the
 * operator. With two copies, a rule added on one side only would lose the whole one-click link.
 */
export type CommentProblem = 'character_reference' | 'comment_marker' | 'link' | 'other_repository';

/**
 * Why a bundle comment cannot be posted, or null:
 * - a character reference renders as `@` (`&#64;x`) where the mention check cannot see it;
 * - `<!--` or `-->` would hide text (or a fake trailer) on GitHub that the approval page shows;
 * - a link, or a reference to another repository (`owner/repo#N`), puts a cross-reference in
 *   someone else's timeline under the operator's name.
 */
export function commentProblem(body: string, repo: string): CommentProblem | null {
  if (/&(#|[A-Za-z][A-Za-z0-9]*;)/.test(body)) return 'character_reference';
  if (body.includes('<!--') || body.includes('-->')) return 'comment_marker';
  // No links at all: model text is link-free after sanitizeComment.
  if (/https?:|www\./i.test(body)) return 'link';
  for (const m of body.matchAll(/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#\d+/g))
    if (m[1]?.toLowerCase() !== repo.toLowerCase()) return 'other_repository';
  return null;
}

/**
 * Logins a comment may notify: `@name` not preceded by a letter or digit (so e-mail addresses do
 * not count). GitHub finds mentions in rendered text, so `_@x_`, `` `a`@x `` and `/@x` count too.
 * Over-reporting only makes the check stricter.
 */
export function mentionsIn(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/(?<![A-Za-z0-9])@([A-Za-z0-9-]{1,39})/g))
    if (m[1] !== undefined) out.add(m[1]);
  return [...out];
}
