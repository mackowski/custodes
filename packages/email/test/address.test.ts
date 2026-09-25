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
