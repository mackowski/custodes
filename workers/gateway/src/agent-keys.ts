/**
 * The operator's page for agent Worker keys (ADR 0018): what each Worker's Keyholder holds next to
 * what is pinned in the repository, and a Rotate button. Reached only through the gateway, behind
 * Access; each agent Worker is bound with its `KeyAdmin` entrypoint, which returns public keys and
 * rotates, nothing else. A Worker not bound yet (before its cutover) is listed as such.
 */
import { type AgentKeys, CallerName, PINNED_AGENT_KEYS, verificationKeys } from '@custodes/schema';
import { escapeHtml, layout } from './approval-page.js';

/** Public key info as a Keyholder reports it. */
export interface HeldKey {
  kid: string;
  x: string;
  state: 'active' | 'next';
  createdAt: string;
}

/** The part of a Worker's `KeyAdmin` entrypoint the gateway uses. */
export interface KeyAdminLike {
  publicKeys(): Promise<HeldKey[]>;
  rotate(): Promise<HeldKey>;
}

/** Caller → the gateway binding of its KeyAdmin entrypoint (added once the Worker exists). */
export const KEY_ADMIN_BINDINGS: Readonly<Record<CallerName, string>> = {
  'custodes-pr-gate': 'KEYS_PR_GATE',
  'custodes-cheatsheet-review': 'KEYS_CHEATSHEET_REVIEW',
  'custodes-triage': 'KEYS_TRIAGE',
  'custodes-triage-apply': 'KEYS_TRIAGE_APPLY',
};

export type PinState = 'pinned' | 'retired' | 'not pinned' | 'pinned, different key';

export interface AgentKeyRow {
  caller: CallerName;
  bound: boolean;
  keys: (HeldKey & { pin: PinState; fingerprint: string })[];
  /** Pinned kids the Keyholder no longer holds (rotated out): candidates to move to `retired`. */
  pinnedNotHeld: string[];
  error?: string;
}

/** First 16 hex of SHA-256 over the public `x`: easy to compare by eye with the log and the PR. */
export async function fingerprint(x: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x));
  return Array.from(new Uint8Array(d).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function keyAdminOf(env: object, caller: CallerName): KeyAdminLike | undefined {
  const b = (env as Record<string, unknown>)[KEY_ADMIN_BINDINGS[caller]];
  return b !== undefined && b !== null ? (b as KeyAdminLike) : undefined;
}

export async function listAgentKeys(
  env: object,
  pinned: AgentKeys = PINNED_AGENT_KEYS,
): Promise<AgentKeyRow[]> {
  const rows: AgentKeyRow[] = [];
  for (const caller of CallerName.options) {
    const active = pinned.callers[caller] ?? [];
    const all = verificationKeys(pinned, caller);
    const admin = keyAdminOf(env, caller);
    if (!admin) {
      rows.push({ caller, bound: false, keys: [], pinnedNotHeld: active.map((k) => k.kid) });
      continue;
    }
    try {
      const held = await admin.publicKeys();
      const keys = await Promise.all(
        held.map(async (k) => {
          const p = all.find((q) => q.kid === k.kid);
          const pin: PinState =
            p === undefined
              ? 'not pinned'
              : p.x !== k.x
                ? 'pinned, different key'
                : active.some((q) => q.kid === k.kid)
                  ? 'pinned'
                  : 'retired';
          return { ...k, pin, fingerprint: await fingerprint(k.x) };
        }),
      );
      const heldKids = new Set(held.map((k) => k.kid));
      rows.push({
        caller,
        bound: true,
        keys,
        pinnedNotHeld: active.filter((k) => !heldKids.has(k.kid)).map((k) => k.kid),
      });
    } catch {
      // No error text: it could come from another Worker. The operator sees which one failed.
      rows.push({ caller, bound: true, keys: [], pinnedNotHeld: [], error: 'unavailable' });
    }
  }
  return rows;
}

export function agentKeysPage(rows: AgentKeyRow[]): string {
  const section = (r: AgentKeyRow) => {
    const head = `<h2>${escapeHtml(r.caller)}</h2>`;
    if (!r.bound)
      return `${head}<p class="note">Not reachable from the gateway yet (bound after its cutover).</p>`;
    if (r.error) return `${head}<p><strong>Keyholder unavailable.</strong></p>`;
    const keys = r.keys.length
      ? `<dl>${r.keys
          .map(
            (k) =>
              `<dt>${escapeHtml(k.state)} · ${escapeHtml(k.kid)} · ${escapeHtml(k.pin)}</dt><dd>fingerprint ${escapeHtml(k.fingerprint)}<br>x <code>${escapeHtml(k.x)}</code><br>created ${escapeHtml(k.createdAt)}</dd>`,
          )
          .join('')}</dl>`
      : '<p class="note">No key yet: it is made on the first broker call.</p>';
    const stale = r.pinnedNotHeld.length
      ? `<p class="note">Pinned but no longer held (move to <code>retired</code>): ${r.pinnedNotHeld.map(escapeHtml).join(', ')}</p>`
      : '';
    const rotate = r.keys.some((k) => k.state === 'next')
      ? '<p class="note">A next key is pending: pin it next to the active one; the Worker switches once the broker accepts it.</p>'
      : `<form method="post" action="/admin/agent-keys/${encodeURIComponent(r.caller)}/rotate"><button>Rotate</button></form>`;
    return head + keys + stale + rotate;
  };
  return layout(
    'Agent keys',
    `<h1>Agent Worker keys</h1><p class="note">Public keys only. Pinning happens in a pull request (<code>packages/schema/src/agent-keys.json</code>); the key workflow prepares the branch.</p>${rows.map(section).join('')}`,
  );
}
