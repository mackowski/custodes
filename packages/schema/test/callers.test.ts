import { describe, expect, it } from 'vitest';
import { AgentKeys, isWeakEd25519PublicKey, PinnedAgentKey } from '../src/callers.js';

/** Real Ed25519 public keys: RFC 8032 section 7.1, tests 1 and 2 (public test vectors). */
const REAL_X = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const key = (kid: string, x = REAL_X) => ({ kid, x, addedAt: '2026-11-09' });

/**
 * The eight small-order encodings (libsodium blocklist, with and without the sign bit). Each one
 * was checked to accept a forged signature (R = identity, S = 0) in Node's and workerd's Ed25519.
 */
const SMALL_ORDER = [
  'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  '7P_______________________________________38',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIA',
  'JuiVj8KyJ7BFw_SJ8u-Y8NXfrAXTxjM5sTgCiG1T_AU',
  'JuiVj8KyJ7BFw_SJ8u-Y8NXfrAXTxjM5sTgCiG1T_IU',
  'xxdqcD1N2E-6PAt2DRBnDyogU_osOczGTsf9d5KsA3o',
  'xxdqcD1N2E-6PAt2DRBnDyogU_osOczGTsf9d5KsA_o',
];

describe('agent-keys.json schema (ADR 0018)', () => {
  it('accepts up to two real keys per caller (a rotation)', () => {
    const second = 'PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw';
    expect(isWeakEd25519PublicKey(second)).toBe(false);
    expect(
      AgentKeys.safeParse({
        version: 1,
        callers: {
          'custodes-pr-gate': [
            key('pr-gate-20261001-aaaaaaaa'),
            key('pr-gate-20261109-bbbbbbbb', second),
          ],
        },
      }).success,
    ).toBe(true);
  });

  it('refuses every small-order public key, and a non-canonical one', () => {
    for (const x of SMALL_ORDER) {
      expect(isWeakEd25519PublicKey(x), x).toBe(true);
      expect(PinnedAgentKey.safeParse(key('pr-gate-20261109-a1b2c3d4', x)).success, x).toBe(false);
    }
    // y = p (0x7fff…ffed): non-canonical encoding of 0.
    expect(isWeakEd25519PublicKey('7f_______________________________________38')).toBe(true);
    expect(isWeakEd25519PublicKey(REAL_X)).toBe(false);
  });

  it('refuses a third key, a duplicate kid, an unknown caller and a malformed key', () => {
    for (const callers of [
      { 'custodes-pr-gate': [key('a-1111111'), key('b-1111111'), key('c-1111111')] },
      { 'custodes-pr-gate': [key('pr-gate-20261109-a'), key('pr-gate-20261109-a')] },
      { 'custodes-agents': [key('pr-gate-20261109-a')] },
      { 'custodes-pr-gate': [key('pr-gate-20261109-a', 'short')] },
      { 'custodes-pr-gate': [key('Bad Id')] },
    ])
      expect(AgentKeys.safeParse({ version: 1, callers }).success, JSON.stringify(callers)).toBe(
        false,
      );
  });

  it('refuses the same public key under two callers (one Worker could sign as the other)', () => {
    expect(
      AgentKeys.safeParse({
        version: 1,
        callers: {
          'custodes-pr-gate': [key('pr-gate-20261109-a1b2c3d4')],
          'custodes-triage': [key('triage-20261109-a1b2c3d4')],
        },
      }).success,
    ).toBe(false);
  });

  it('refuses a kid that is both active and retired (old records would stop verifying)', () => {
    expect(
      AgentKeys.safeParse({
        version: 1,
        callers: { 'custodes-pr-gate': [key('pr-gate-20261109-a1b2c3d4')] },
        retired: { 'custodes-pr-gate': [key('pr-gate-20261109-a1b2c3d4')] },
      }).success,
    ).toBe(false);
  });
});
