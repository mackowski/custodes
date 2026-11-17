import { describe, expect, it } from 'vitest';
import triageConfig from '../../../evals/agents/triage/promptfooconfig.yaml?raw';
import implementationConfig from '../../../evals/agents/implementation-check/promptfooconfig.yaml?raw';
import proposalConfig from '../../../evals/agents/proposal-review/promptfooconfig.yaml?raw';
import minorConfig from '../../../evals/agents/pr-gate/promptfooconfig.yaml?raw';
import approvalConfig from '../../../evals/agents/pr-gate-approval/promptfooconfig.yaml?raw';
import linkCases from '../../../evals/agents/cheatsheet-review-links/cases.yaml?raw';
import { linkMessage } from '../src/agents/cheatsheet-review/input.js';
import { APPROVAL_BAND } from '../src/agents/pr-gate/approval.js';
import { MINOR_BAND } from '../src/agents/pr-gate/minor.js';
import { assessRequest } from '../src/agents/specialists/model.js';
import { triageRequest } from '../src/agents/triage/model.js';

/**
 * The eval configs copy what the agents send (model, token budget) and the bands that turn a Jev
 * probability into a decision. System prompts and questions already have such tests; without
 * these, a model or threshold change would get a green eval that tested the old setting.
 */
const meta = { agentId: 'triage', runId: 'r' };

describe('eval configs match what the agents send', () => {
  it('triage: model and token budget', () => {
    const req = triageRequest('s', 'u', meta);
    expect(triageConfig).toContain(`model: ${req.model}`);
    expect(triageConfig).toContain(`max_tokens: ${req.max_tokens}`);
  });

  it('implementation-check and proposal-review: model and token budget', () => {
    const req = assessRequest('s', 'u', meta);
    for (const config of [implementationConfig, proposalConfig]) {
      expect(config).toContain(`model: ${req.model}`);
      expect(config).toContain(`max_tokens: ${req.max_tokens}`);
    }
  });

  it('pr-gate: the bands the assertions grade with', () => {
    expect(minorConfig).toContain(`o.p >= ${MINOR_BAND.yes} `);
    expect(minorConfig).toContain(`o.p <= ${MINOR_BAND.no} `);
    expect(approvalConfig).toContain(`o.p >= ${APPROVAL_BAND.yes} `);
    expect(approvalConfig).toContain(`o.p <= ${APPROVAL_BAND.no} `);
  });
});

describe('eval inputs have the shape the agent builds', () => {
  it('link auditor: every case starts like linkMessage()', () => {
    // What the agent sends for one new link, up to the sentence.
    const built = linkMessage([
      { url: 'https://a.example/x', file: 'f.md', line: 1, context: 'c', title: 't', excerpt: 'e' },
    ]);
    expect(built.startsWith('Link 1 (new):\n<untrusted source="pr-claim">\nURL: ')).toBe(true);
    // In the YAML the same text is inside a double-quoted scalar, so quotes and newlines are escaped.
    const starts = [...linkCases.matchAll(/'user': "(Link 1[^\\]*)\\n(.{0,60})/g)];
    expect(starts.length).toBeGreaterThan(0);
    for (const m of starts) {
      expect(m[1], m[0]).toMatch(/^Link 1 \((new|moved: only its target changed)\):$/);
      expect(m[2], m[0]).toContain('<untrusted source=\\"pr-claim\\">\\nURL: ');
    }
  });
});
