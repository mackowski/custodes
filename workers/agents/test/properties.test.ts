// Property-based (fuzz) tests: what reaches the operator's e-mail, or a comment they may paste into
// GitHub, must hold these invariants for any model output or untrusted text.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sanitizeComment, verifyEvidence } from '../src/agents/specialists/evidence.js';
import {
  validateProposalReview,
  type RawProposalReview,
} from '../src/agents/specialists/proposal.js';
import { inertNoLinks } from '../src/agents/triage/assess.js';
import { renderDigestHtml } from '../src/agents/triage/digest-html.js';

const hostile = fc.oneof(
  fc
    .array(
      fc.constantFrom(
        'http://',
        'https://',
        'HTTPS://',
        'www.',
        '//',
        'evil.example/',
        'evil.example',
        '<',
        '>',
        'script',
        '<a href="',
        '<img src=',
        '[x](',
        ')',
        '[1]: ',
        ']:',
        '@',
        'user',
        ' ',
        '\n',
        '\r\n',
        '‮',
        '​',
        '\u0000',
        'a',
        '.',
        '/',
        '-',
        'x',
      ),
      { maxLength: 60 },
    )
    .map((p) => p.join('')),
  fc.string({ unit: 'binary', maxLength: 400 }),
);

// Every Cc/Cf character except the newline, built from a string so no tool inlines the characters.
const INVISIBLE_EXCEPT_NEWLINE = new RegExp('(?![\\n])[\\p{Cc}\\p{Cf}]', 'u');
const LIVE_LINK = /https?:\/\/|www\.|\/\/|[a-z0-9-]\.[a-z0-9-]+\/\S/i;

describe('sanitizeComment() properties', () => {
  it('never contains tags, links, mentions or hidden characters, and is bounded', () => {
    fc.assert(
      fc.property(hostile, (s) => {
        const out = sanitizeComment(s);
        expect(out).not.toMatch(/[<>]/);
        expect(out).not.toMatch(LIVE_LINK);
        expect(out).not.toMatch(/\]\([^)]*\)/); // an unclosed `](` is not a link
        expect(out).not.toMatch(/@[A-Za-z0-9]/);
        expect(INVISIBLE_EXCEPT_NEWLINE.test(out)).toBe(false);
        expect(out.length).toBeLessThanOrEqual(1500);
        expect(out.split('\n').length).toBeLessThanOrEqual(20);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('inertNoLinks() properties', () => {
  it('yields one bounded line without links or hidden characters', () => {
    fc.assert(
      fc.property(hostile, fc.integer({ min: 0, max: 300 }), (s, max) => {
        const out = inertNoLinks(s, max);
        expect(out.length).toBeLessThanOrEqual(max);
        expect(out).not.toMatch(/[\p{Cc}\p{Cf}]/u);
        // A cut at `max` may leave a harmless fragment such as "http"; test the unclipped form.
        expect(inertNoLinks(s, 10_000)).not.toMatch(LIVE_LINK);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('verifyEvidence() properties', () => {
  const repo = 'OWASP/CheatSheetSeries';
  const lines = fc.array(fc.string({ maxLength: 80 }), { minLength: 1, maxLength: 20 });

  it('returns only quotes found on the reported line of a file it was given, with a rebuilt link', () => {
    fc.assert(
      fc.property(
        lines,
        fc.array(
          fc.record({
            file: fc.constantFrom('A_Cheat_Sheet.md', 'Other.md', 'https://evil.example/x.md'),
            quote: fc.oneof(hostile, fc.string({ minLength: 12, maxLength: 60 })),
          }),
          { maxLength: 6 },
        ),
        (content, claims) => {
          const files = new Map([['A_Cheat_Sheet.md', content.join('\n')]]);
          const dropped: string[] = [];
          const out = verifyEvidence(repo, claims, files, dropped);
          expect(out.length).toBeLessThanOrEqual(5);
          for (const e of out) {
            expect(e.file).toBe('A_Cheat_Sheet.md');
            const line = (content[e.line - 1] ?? '')
              .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
              .replace(/\s+/g, ' ');
            expect(line.length).toBeGreaterThanOrEqual(12);
            expect(e.url).toBe(
              `https://github.com/${repo}/blob/HEAD/cheatsheets/A_Cheat_Sheet.md#L${e.line}`,
            );
          }
          expect(dropped.join(' ')).not.toMatch(LIVE_LINK);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('validateProposalReview() properties', () => {
  const labels = ['ACK_OBTAINED', 'ACK_WAITING', 'HELP_WANTED', 'NEW_CS'];
  const name = fc.oneof(
    fc.constantFrom(...labels, 'ack_obtained', 'security-critical', 'https://evil.example'),
    hostile,
  );

  it('recommends only real labels, removals the issue has, and assignees from the thread', () => {
    fc.assert(
      fc.property(
        fc.record({
          addLabels: fc.array(name, { maxLength: 6 }),
          removeLabels: fc.array(name, { maxLength: 6 }),
          assignTo: fc.option(
            fc.oneof(fc.constantFrom('gqlwriter', '@gqlwriter', 'attacker'), hostile),
            { nil: null },
          ),
          helpWanted: fc.boolean(),
          explanation: hostile,
          suggestedComment: hostile,
        }),
        fc.subarray(labels),
        (r, current) => {
          const raw: RawProposalReview = {
            verdict: 'real_gap',
            makesSense: true,
            evidence: [],
            injectionDetected: false,
            confidence: 0.5,
            ...r,
          };
          const out = validateProposalReview(raw, {
            repo: 'OWASP/CheatSheetSeries',
            title: 't',
            labels,
            current,
            people: ['gqlwriter', 'maint1'],
            files: new Map(),
          });
          for (const l of out.addLabels) expect(labels).toContain(l);
          for (const l of out.removeLabels) expect(current).toContain(l);
          if (out.assignTo !== null) expect(['gqlwriter', 'maint1']).toContain(out.assignTo);
          if (out.assignTo !== null) expect(out.addLabels).not.toContain('HELP_WANTED');
          expect(out.explanation).not.toMatch(LIVE_LINK);
          expect(out.suggestedComment).not.toMatch(LIVE_LINK);
          expect(out.dropped.join(' ')).not.toMatch(LIVE_LINK);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('renderDigestHtml() properties', () => {
  it('never lets issue or model text add tags, attributes or links', () => {
    fc.assert(
      fc.property(hostile, hostile, hostile, (title, summary, comment) => {
        const assessment = {
          labels: [],
          cheatSheet: null,
          possibleDuplicates: [],
          kind: 'update' as const,
          needsMaintainer: true,
          summary,
          injectionDetected: false,
          confidence: 0.5,
          dropped: [title],
        };
        const review = validateProposalReview(
          {
            verdict: 'real_gap',
            makesSense: true,
            evidence: [],
            addLabels: [],
            removeLabels: [],
            assignTo: null,
            helpWanted: false,
            explanation: summary,
            suggestedComment: comment,
            injectionDetected: false,
            confidence: 0.5,
          },
          {
            repo: 'OWASP/CheatSheetSeries',
            title,
            labels: [],
            current: [],
            people: [],
            files: new Map(),
          },
        );
        const html = renderDigestHtml({
          repo: 'OWASP/CheatSheetSeries',
          items: [{ issue: 1, title, url: 'https://evil.example', assessment }],
          implementation: [],
          proposals: [{ issue: 2, result: review }],
          omittedAck: 0,
          errors: [title],
          since: null,
          now: new Date('2026-10-05T07:00:00Z'),
        });
        const tags = html.match(/<\/?([a-z0-9]+)/gi) ?? [];
        const allowed = new Set([
          '!doctype',
          'html',
          'head',
          'meta',
          'title',
          'body',
          'div',
          'h1',
          'h2',
          'p',
          'span',
          'a',
          'ul',
          'li',
        ]);
        for (const t of tags) expect(allowed.has(t.replace(/^<\/?/, '').toLowerCase())).toBe(true);
        for (const m of html.matchAll(/href="([^"]*)"/g))
          expect(m[1]).toMatch(/^https:\/\/github\.com\//);
        expect(html).not.toMatch(/\son[a-z]+=|javascript:/i);
      }),
      { numRuns: 500 },
    );
  });
});
