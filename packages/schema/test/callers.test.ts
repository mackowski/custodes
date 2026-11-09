import { describe, expect, it } from 'vitest';
import { AgentKeys } from '../src/callers.js';

const key = (keyId: string) => ({
  keyId,
  x: 'A'.repeat(43),
  addedAt: '2026-11-09',
});

describe('agent-keys.json schema (ADR 0018)', () => {
  it('accepts up to two keys per caller (a rotation)', () => {
    expect(
      AgentKeys.safeParse({
        version: 1,
        callers: {
          'custodes-pr-gate': [key('pr-gate-20261001-aaaaaaaa'), key('pr-gate-20261109-bbbbbbbb')],
        },
      }).success,
    ).toBe(true);
  });

  it('refuses a third key, a duplicate key id, an unknown caller and a malformed key', () => {
    for (const callers of [
      { 'custodes-pr-gate': [key('a-1111111'), key('b-1111111'), key('c-1111111')] },
      { 'custodes-pr-gate': [key('pr-gate-20261109-a'), key('pr-gate-20261109-a')] },
      { 'custodes-agents': [key('pr-gate-20261109-a')] },
      { 'custodes-pr-gate': [{ ...key('pr-gate-20261109-a'), x: 'short' }] },
      { 'custodes-pr-gate': [{ ...key('Bad Id'), x: 'A'.repeat(43) }] },
    ])
      expect(AgentKeys.safeParse({ version: 1, callers }).success, JSON.stringify(callers)).toBe(
        false,
      );
  });
});
