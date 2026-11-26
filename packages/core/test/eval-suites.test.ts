import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { selectSuites, SHARED_PATHS, SUITE_PATHS } from '../../../evals/select-suites.js';

const all = readdirSync(new URL('../../../evals/agents/', import.meta.url), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe('eval suite selection', () => {
  it('knows every suite folder, so none is skipped when its agent changes', () => {
    expect(all.filter((s) => !(s in SUITE_PATHS))).toEqual([]);
  });

  it('runs only the suites whose agent the change touches', () => {
    expect(selectSuites(['workers/agents/src/agents/pr-gate/minor.ts'], all)).toEqual(['pr-gate']);
    expect(selectSuites(['workers/agents/src/agents/cheatsheet-review/lineup.ts'], all)).toEqual(
      all.filter((s) => s.startsWith('cheatsheet-review')),
    );
    expect(selectSuites(['evals/agents/triage/tests.yaml'], all)).toEqual(['triage']);
    expect(selectSuites(['workers/agents/src/agents/cheatsheet-review/claims.ts'], all)).toEqual([
      'cheatsheet-review-judge',
      'cheatsheet-review-verifier',
    ]);
  });

  it('gives a new shared security case to both security voices', () => {
    expect(selectSuites(['evals/agents/cheatsheet-review-security/cases.yaml'], all)).toEqual([
      'cheatsheet-review-security',
      'cheatsheet-review-security-2',
    ]);
  });

  it('starts the workflow for every path the selection knows (its `paths:` is a second list)', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/evals.yml', import.meta.url),
      'utf8',
    );
    const known = [...SHARED_PATHS, ...Object.values(SUITE_PATHS).flat()];
    // Everything under evals/ is covered by the `evals/**` entry.
    const missing = [...new Set(known)].filter(
      // A directory prefix (`…/`) is a `…/**` glob in the workflow.
      (p) =>
        !p.startsWith('evals/') &&
        !workflow.includes(`- '${p}'`) &&
        !(p.endsWith('/') && workflow.includes(`- '${p}**'`)),
    );
    expect(missing).toEqual([]);
  });

  it('runs every suite for shared plumbing and none for unrelated files', () => {
    for (const f of [
      'packages/llm/src/models.ts',
      'evals/providers/x.mjs',
      '.github/workflows/evals.yml',
    ])
      expect(selectSuites([f], all), f).toEqual(all);
    expect(selectSuites(['README.md', 'workers/gateway/src/index.ts'], all)).toEqual([]);
  });
});
