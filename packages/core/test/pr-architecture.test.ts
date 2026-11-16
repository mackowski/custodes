import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkPrBody } from '../../../scripts/pr-architecture.js';

const ROOT = new URL('../../../', import.meta.url);
const template = readFileSync(new URL('.github/pull_request_template.md', ROOT), 'utf8');

const filled = (over: { verdict?: string; effect?: string; diagram?: string } = {}) => `
## What and why

Something.

<!-- architecture:start -->
## Architecture and data flow

### Before

\`\`\`mermaid
${over.diagram ?? 'flowchart LR\n  GW["custodes-gateway"] --> REG["custodes-agents"]\n  GW --> BR["broker"]'}
\`\`\`

### After

\`\`\`mermaid
flowchart LR
  GW["custodes-gateway"] --> REG["custodes-agents"]
  GW -. "- removed" .-> BR["broker"]
\`\`\`

${over.verdict ?? 'Data flow: unchanged: only tests and docs change here'}

### Security

| Aspect | Change | Effect | Control |
| --- | --- | --- | --- |
| Trust boundaries | none | same | n/a |
| Credentials and secrets | none | same | n/a |
| Untrusted input and models | none | same | n/a |
| Authority (policy, actions, repos) | none | same | n/a |
| Approvals and kill switch | none | same | n/a |
| CI, supply chain, deploy | none | ${over.effect ?? 'same'} | n/a |
| Access and public routes | none | same | n/a |

### Documentation

- [x] docs/architecture/data-flow.md: not affected, only tests
<!-- architecture:end -->
`;

describe('PR architecture section check (/ship)', () => {
  it('passes a filled-in section', () => {
    expect(checkPrBody(filled(), ['packages/core/test/x.test.ts']).errors).toEqual([]);
  });

  it('fails an empty body and the untouched template', () => {
    expect(checkPrBody('', []).errors).toHaveLength(1);
    const errors = checkPrBody(template, []).errors;
    expect(errors.join('\n')).toMatch(/template placeholder/);
    expect(errors.join('\n')).toMatch(/Data flow: changed/);
    expect(errors.join('\n')).toMatch(/needs its change and effect/);
  });

  it('wants data-flow.md updated when the section says the flow changed', () => {
    const body = filled({ verdict: 'Data flow: changed (data-flow.md updated)' });
    expect(checkPrBody(body, ['workers/gateway/wrangler.jsonc']).errors.join()).toMatch(
      /data-flow\.md is not updated/,
    );
    expect(
      checkPrBody(body, ['workers/gateway/wrangler.jsonc', 'docs/architecture/data-flow.md'])
        .errors,
    ).toEqual([]);
  });

  it('wants a reason for "unchanged", and reports files that usually change the flow', () => {
    const v = checkPrBody(filled({ verdict: 'Data flow: unchanged: no' }), [
      'workers/github-broker/policy/policy.json',
      'README.md',
    ]);
    expect(v.errors.join()).toMatch(/needs a reason/);
    expect(v.flowFiles).toEqual(['workers/github-broker/policy/policy.json']);
  });

  it('wants every security row filled in', () => {
    expect(checkPrBody(filled({ effect: '' }), []).errors.join()).toMatch(
      /"CI, supply chain, deploy" needs its change and effect/,
    );
  });

  it('wants a real diagram', () => {
    const errors = checkPrBody(filled({ diagram: 'flowchart LR' }), []).errors;
    // The After diagram is still real, so one real diagram is enough.
    expect(errors).toEqual([]);
  });
});
