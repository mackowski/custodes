import { describe, expect, it } from 'vitest';
import { approvalReplyAddress, parseApprovalAddress } from '../src/address.js';

describe('approval addresses', () => {
  it('round-trips', () => {
    const addr = approvalReplyAddress('abc.123.xyz_-', 'custodes.example');
    expect(addr).toBe('approve+abc.123.xyz_-@custodes.example');
    expect(parseApprovalAddress(`Custodes <${addr}>`)).toEqual({
      verb: 'approve',
      token: 'abc.123.xyz_-',
    });
    expect(parseApprovalAddress('reject+t@custodes.example')).toEqual({
      verb: 'reject',
      token: 't',
    });
    expect(parseApprovalAddress('hello@custodes.example')).toBeNull();
  });
});

// Regression for CodeQL js/polynomial-redos: hostile input must stay linear.
const fast = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('approval addresses (hostile input)', () => {
  it('takes the address inside the last angle brackets', () => {
    expect(parseApprovalAddress('"x <y>" <approve+tok@custodes.example>')).toEqual({
      verb: 'approve',
      token: 'tok',
    });
  });

  it('is linear on many > characters', () => {
    expect(fast(() => parseApprovalAddress('>'.repeat(100_000)))).toBeLessThan(200);
    expect(fast(() => parseApprovalAddress('<'.repeat(100_000)))).toBeLessThan(200);
  });
});
