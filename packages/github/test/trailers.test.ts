import { describe, expect, it } from 'vitest';
import { appendTrailers } from '../src/trailers.js';

describe('trailers', () => {
  it('appends the machine-readable trailer', () => {
    const body = appendTrailers('Thanks for the report.', {
      agentId: 'triage',
      agentVersion: '0.1.0',
      attestationId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
      onBehalfOf: 'jakub',
    });
    expect(body).toContain('Custodes-Agent: triage@0.1.0');
    expect(body).toContain(
      '<!--\nCustodes-Agent: triage@0.1.0\nCustodes-Attestation: 9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44\nOn-Behalf-Of: @jakub\n-->',
    );
  });
});

describe('hidden trailers', () => {
  const input = {
    agentId: 'triage-apply',
    agentVersion: '0.1.0',
    attestationId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
    verifyUrl: 'https://example.test/verify',
  };
  it('has no visible footer but keeps the HTML comment', () => {
    const body = appendTrailers('Hello.', { ...input, visibility: 'hidden' });
    expect(body).not.toContain('<sub>');
    expect(body).not.toContain('---');
    expect(body).not.toContain('verify');
    expect(body).toContain('<!--\nCustodes-Agent: triage-apply@0.1.0');
    expect(body).toContain(`Custodes-Attestation: ${input.attestationId}\n-->`);
  });
  it('is visible by default', () => {
    const body = appendTrailers('Hello.', input);
    expect(body).toContain('<sub>');
    expect(body).toContain(`[verify](https://example.test/verify/${input.attestationId})`);
  });
});
