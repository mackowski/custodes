import { describe, expect, it } from 'vitest';
import { pinKeys, type KeysFile, type Row } from '../../../scripts/pin-agent-keys-rules.js';

/**
 * The rules that decide which agent keys the broker accepts (ADR 0018). The workflow's result is
 * reviewed by a person, and a wrong retire is still a valid file, so the rules need their own test.
 */
const CALLER = 'custodes-pr-gate';
const x = (c: string) => `${c.repeat(42)}A`;
const key = (kid: string, c: string, state: 'active' | 'next') => ({
  kid,
  x: x(c),
  state,
  pin: 'unpinned',
});
const row = (keys: Row['keys'], caller = CALLER): Row => ({
  caller,
  bound: true,
  keys,
  pinnedNotHeld: [],
});
const file = (callers: KeysFile['callers'] = {}, retired: KeysFile['retired'] = {}): KeysFile => ({
  version: 1,
  callers,
  retired,
});
const pinned = (kid: string, c: string) => ({ kid, x: x(c), addedAt: '2026-11-01' });
const TODAY = '2026-11-17';

describe('pin-agent-keys', () => {
  it('pins a new key and changes nothing when everything is pinned', () => {
    const f = file();
    expect(pinKeys(f, [row([key('pr-gate-20261117-aaaaaaaa', 'a', 'active')])], TODAY)).toEqual([
      `pin ${CALLER} active pr-gate-20261117-aaaaaaaa x=${x('a')}`,
    ]);
    expect(f.callers[CALLER]).toEqual([
      { kid: 'pr-gate-20261117-aaaaaaaa', x: x('a'), addedAt: TODAY },
    ]);
    expect(pinKeys(f, [row([key('pr-gate-20261117-aaaaaaaa', 'a', 'active')])], TODAY)).toEqual([]);
  });

  it('pins the next key of a rotation and keeps the old one until the new one is active and pinned', () => {
    const f = file({ [CALLER]: [pinned('pr-gate-old-aaaaaaaa', 'a')] });
    // Step 1: the Keyholder holds old (active) and new (next): the new one is pinned, nothing retires.
    pinKeys(
      f,
      [row([key('pr-gate-old-aaaaaaaa', 'a', 'active'), key('pr-gate-new-bbbbbbbb', 'b', 'next')])],
      TODAY,
    );
    expect(f.callers[CALLER]?.map((k) => k.kid)).toEqual([
      'pr-gate-old-aaaaaaaa',
      'pr-gate-new-bbbbbbbb',
    ]);
    expect(f.retired[CALLER]).toBeUndefined();
    // Step 2: the new key is active and was pinned before this run: now the old one retires.
    const changes = pinKeys(f, [row([key('pr-gate-new-bbbbbbbb', 'b', 'active')])], TODAY);
    expect(changes).toEqual([`retire ${CALLER} pr-gate-old-aaaaaaaa`]);
    expect(f.callers[CALLER]?.map((k) => k.kid)).toEqual(['pr-gate-new-bbbbbbbb']);
    expect(f.retired[CALLER]?.map((k) => k.kid)).toEqual(['pr-gate-old-aaaaaaaa']);
  });

  it('never pins a new key and retires the old one from a single answer', () => {
    const f = file({ [CALLER]: [pinned('pr-gate-old-aaaaaaaa', 'a')] });
    // A gateway that shows only an unknown active key: it is pinned, but the old key stays.
    pinKeys(f, [row([key('pr-gate-new-bbbbbbbb', 'b', 'active')])], TODAY);
    expect(f.callers[CALLER]?.map((k) => k.kid)).toEqual([
      'pr-gate-old-aaaaaaaa',
      'pr-gate-new-bbbbbbbb',
    ]);
    expect(f.retired[CALLER]).toBeUndefined();
  });

  it('refuses a pinned kid whose key differs, a key already pinned under another kid, and the same key twice', () => {
    const f = file({ [CALLER]: [pinned('pr-gate-old-aaaaaaaa', 'a')] });
    expect(() => pinKeys(f, [row([key('pr-gate-old-aaaaaaaa', 'z', 'active')])], TODAY)).toThrow(
      'differs from the held key',
    );
    expect(() => pinKeys(f, [row([key('pr-gate-other-cccccccc', 'a', 'active')])], TODAY)).toThrow(
      'already pinned for another kid',
    );
    expect(() =>
      pinKeys(
        file({}),
        [
          row([
            key('pr-gate-new-bbbbbbbb', 'b', 'active'),
            key('pr-gate-new-bbbbbbbb', 'c', 'next'),
          ]),
        ],
        TODAY,
      ),
    ).toThrow('the same key id twice');
    expect(() =>
      pinKeys(
        file(),
        [
          row([
            key('pr-gate-one-dddddddd', 'd', 'active'),
            key('pr-gate-two-eeeeeeee', 'd', 'next'),
          ]),
        ],
        TODAY,
      ),
    ).toThrow('already pinned for another kid');
  });

  it('refuses a caller listed twice, an odd caller name and a malformed key', () => {
    const k = key('pr-gate-20261117-aaaaaaaa', 'a', 'active');
    expect(() => pinKeys(file(), [row([k]), row([k])], TODAY)).toThrow('appears twice');
    expect(() => pinKeys(file(), [row([k], 'evil')], TODAY)).toThrow('unexpected caller name');
    expect(() => pinKeys(file(), [row([{ ...k, x: 'short' }])], TODAY)).toThrow('malformed key');
  });
});
