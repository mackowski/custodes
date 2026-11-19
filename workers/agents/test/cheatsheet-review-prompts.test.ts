import { describe, expect, it } from 'vitest';
import judgeEval from '../../../evals/agents/cheatsheet-review-judge/system.txt?raw';
import linksEval from '../../../evals/agents/cheatsheet-review-links/system.txt?raw';
import scopeEval from '../../../evals/agents/cheatsheet-review-scope/system.txt?raw';
import security2Eval from '../../../evals/agents/cheatsheet-review-security-2/system.txt?raw';
import securityEval from '../../../evals/agents/cheatsheet-review-security/system.txt?raw';
import sourcesEval from '../../../evals/agents/cheatsheet-review-sources/system.txt?raw';
import verifierEval from '../../../evals/agents/cheatsheet-review-verifier/system.txt?raw';
import {
  JUDGE_PROMPT,
  LINK_PROMPT,
  reviewerPrompt,
  SCOPE_PROMPT,
  SOURCES_PROMPT,
  VERIFIER_PROMPT,
} from '../src/agents/cheatsheet-review/prompts.js';

describe('cheatsheet-review prompts', () => {
  it('are exactly what the evals test (regenerate with scripts/print-review-prompts.ts)', () => {
    expect(scopeEval).toBe(SCOPE_PROMPT);
    expect(securityEval).toBe(reviewerPrompt('security-reviewer'));
    expect(security2Eval).toBe(reviewerPrompt('security-second-voice'));
    expect(linksEval).toBe(LINK_PROMPT);
    expect(judgeEval).toBe(JUDGE_PROMPT);
    expect(verifierEval).toBe(VERIFIER_PROMPT);
    expect(sourcesEval).toBe(SOURCES_PROMPT);
  });

  it('all carry the untrusted-data rules and ask for JSON only', () => {
    for (const p of [
      SCOPE_PROMPT,
      LINK_PROMPT,
      JUDGE_PROMPT,
      VERIFIER_PROMPT,
      SOURCES_PROMPT,
      reviewerPrompt('security-reviewer'),
      reviewerPrompt('security-second-voice'),
      reviewerPrompt('practicality-reviewer'),
      reviewerPrompt('duplication-checker'),
      reviewerPrompt('language-reviewer'),
    ]) {
      expect(p).toContain('<untrusted source="...">');
      expect(p).toMatch(/JSON object and nothing else/);
    }
  });
});
