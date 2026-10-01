import { describe, expect, it } from 'vitest';
import { isTrustedSender, parseAuthenticationResults } from '../src/auth.js';

const allow = ['jakub@example.org'];

describe('inbound email trust', () => {
  it('parses Authentication-Results', () => {
    expect(
      parseAuthenticationResults(
        'mx.cloudflare.net; dkim=pass header.d=example.org; spf=pass; dmarc=pass',
      ),
    ).toEqual({ dkim: 'pass', spf: 'pass', dmarc: 'pass' });
    expect(parseAuthenticationResults('x; dkim=fail; spf=softfail; dmarc=none')).toEqual({
      dkim: 'fail',
      spf: 'fail',
      dmarc: 'none',
    });
  });
  it('requires allow-list and authentication', () => {
    expect(isTrustedSender('Jakub <jakub@example.org>', 'x; dmarc=pass', allow).trusted).toBe(true);
    expect(isTrustedSender('jakub@example.org', 'x; dkim=pass; dmarc=none', allow).trusted).toBe(
      true,
    );
    expect(isTrustedSender('jakub@example.org', 'x; dkim=fail; dmarc=fail', allow).trusted).toBe(
      false,
    );
    expect(isTrustedSender('mallory@example.org', 'x; dmarc=pass', allow).trusted).toBe(false);
    expect(isTrustedSender('jakub@example.org', null, allow).trusted).toBe(false);
  });
});

// Regression for CodeQL js/polynomial-redos: hostile input must stay linear.
const fast = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('inbound email trust (hostile input)', () => {
  it('is linear on many < characters in From', () => {
    expect(fast(() => isTrustedSender('<'.repeat(100_000), null, allow))).toBeLessThan(200);
    expect(isTrustedSender('Jakub <JAKUB@example.org>', 'dmarc=pass', allow).trusted).toBe(true);
  });
});
