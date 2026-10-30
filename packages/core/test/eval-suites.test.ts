import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { selectSuites, SUITE_PATHS } from '../../../evals/select-suites.js';

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
