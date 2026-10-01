// Property-based (fuzz) tests for the broker's path builder and trailer parsing.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BrokerReadRequest, CheatSheetFile } from '@custodes/schema';
import { buildReadPath } from '../src/read.js';
import { parseTrailers } from '../src/trailers.js';

const pathy = fc.oneof(
  fc
    .array(
      fc.constantFrom(
        '..',
        '/',
        '\\',
        '%2e',
        '%2f',
        '.',
        'md',
        '.md',
        'A',
        '_',
        '-',
        '?',
        '#',
        ' ',
        '\u0000',
      ),
      {
        maxLength: 20,
      },
    )
    .map((p) => p.join('')),
  fc.string({ unit: 'binary', maxLength: 140 }),
);

const request = fc.record({
  agentId: fc.constant('triage'),
  runId: fc.constant('9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44'),
  repo: fc.constant('OWASP/CheatSheetSeries'),
  resource: fc.constantFrom(
    'issues',
    'labels',
    'cheatsheets',
    'issue',
    'timeline',
    'comments',
    'pull_files',
    'cheatsheet',
  ),
  query: fc.record(
    {
      labels: pathy,
      since: fc.constantFrom('2026-09-01T00:00:00Z', '../x', 'x&per_page=1'),
      per_page: fc.integer({ min: -5, max: 200 }),
      page: fc.integer({ min: -5, max: 20 }),
    },
    { requiredKeys: [] },
  ),
  number: fc.option(fc.integer({ min: -10, max: 2_000_000 }), { nil: undefined }),
  file: fc.option(pathy, { nil: undefined }),
});

describe('buildReadPath() properties', () => {
  it('every request the schema accepts maps to a path inside the repository allow-list', () => {
    fc.assert(
      fc.property(request, (raw) => {
        const parsed = BrokerReadRequest.safeParse(
          Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)),
        );
        if (!parsed.success) return;
        const path = buildReadPath(parsed.data);
        const [route = '', query = ''] = path.split('?');
        expect(route).toMatch(
          /^\/repos\/OWASP\/CheatSheetSeries\/(issues(\/\d+(\/(timeline|comments))?)?|labels|contents\/cheatsheets(\/[A-Za-z0-9_.-]+\.md)?|pulls\/\d+\/files)$/,
        );
        expect(route).not.toContain('..');
        expect(path).not.toMatch(/[#\s\\]/);
        expect(
          query
            .split('&')
            .filter(Boolean)
            .every((kv) => /^[a-z_]+=[^&]*$/.test(kv)),
        ).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('cheat sheet names never contain a path separator or start with a dot', () => {
    fc.assert(
      fc.property(pathy, (name) => {
        if (CheatSheetFile.safeParse(name).success)
          expect(name).toMatch(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.md$/);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('parseTrailers() properties', () => {
  it('never throws and returns only string values', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc
            .array(fc.constantFrom('<!--\n', '\n-->', 'a: b', 'Custodes-Agent: x', '\n', '-->'), {
              maxLength: 30,
            })
            .map((p) => p.join('')),
          fc.string({ unit: 'binary', maxLength: 300 }),
        ),
        (body) => {
          for (const v of Object.values(parseTrailers(body))) expect(typeof v).toBe('string');
        },
      ),
    );
  });
});
