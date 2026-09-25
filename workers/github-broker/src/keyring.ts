import { DurableObject } from 'cloudflare:workers';
import { importPrivateKey, toBase64Url, type Ed25519Jwk } from '@custodes/core';
import type { PublicKeyEntry } from '@custodes/schema';

// A type alias (not an interface) so it satisfies SqlStorage's Record<string, SqlStorageValue> constraint.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type KeyRow = {
  key_id: string;
  agent_id: string;
  public_jwk: string;
  private_jwk: string;
  created_at: string;
  retired_at: string | null;
};

/**
 * Holds one active Ed25519 signing key per agent, generated on first use. Private keys are
 * created inside this Durable Object and never leave it: callers send bytes and receive a
 * signature. Retired keys stay stored (and published) so historical attestations keep verifying.
 */
export class Keyring extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS keys (
      key_id      TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      public_jwk  TEXT NOT NULL,
      private_jwk TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      retired_at  TEXT
    )`);
    ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS keys_agent_active ON keys (agent_id, retired_at)`,
    );
  }

  /** Signs `payload` with the agent's active key, generating one if needed. */
  async sign(agentId: string, payload: string): Promise<{ keyId: string; signature: string }> {
    const row = this.active(agentId) ?? (await this.generate(agentId));
    const privateKey = await importPrivateKey(JSON.parse(row.private_jwk) as Ed25519Jwk);
    const sig = await crypto.subtle.sign(
      { name: 'Ed25519' },
      privateKey,
      new TextEncoder().encode(payload),
    );
    return { keyId: row.key_id, signature: toBase64Url(new Uint8Array(sig)) };
  }

  /** All public keys, active and retired. */
  publicKeys(): PublicKeyEntry[] {
    const rows = this.ctx.storage.sql
      .exec<KeyRow>('SELECT * FROM keys ORDER BY created_at')
      .toArray();
    return rows.map((r) => this.toEntry(r));
  }

  /** Retires the agent's active key and generates a new one. Returns the new public entry. */
  async rotate(agentId: string): Promise<PublicKeyEntry> {
    this.ctx.storage.sql.exec(
      'UPDATE keys SET retired_at = ?1 WHERE agent_id = ?2 AND retired_at IS NULL',
      new Date().toISOString(),
      agentId,
    );
    return this.toEntry(await this.generate(agentId));
  }

  private active(agentId: string): KeyRow | undefined {
    return this.ctx.storage.sql
      .exec<KeyRow>(
        'SELECT * FROM keys WHERE agent_id = ?1 AND retired_at IS NULL LIMIT 1',
        agentId,
      )
      .toArray()[0];
  }

  private async generate(agentId: string): Promise<KeyRow> {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Ed25519Jwk;
    const priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as Ed25519Jwk;
    const now = new Date();
    const row: KeyRow = {
      key_id: `${agentId}-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8)}`,
      agent_id: agentId,
      public_jwk: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: pub.x }),
      private_jwk: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: priv.x, d: priv.d }),
      created_at: now.toISOString(),
      retired_at: null,
    };
    this.ctx.storage.sql.exec(
      'INSERT INTO keys (key_id, agent_id, public_jwk, private_jwk, created_at, retired_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)',
      row.key_id,
      row.agent_id,
      row.public_jwk,
      row.private_jwk,
      row.created_at,
    );
    console.log(JSON.stringify({ event: 'keyring.generated', agentId, keyId: row.key_id }));
    return row;
  }

  private toEntry(r: KeyRow): PublicKeyEntry {
    return {
      keyId: r.key_id,
      agentId: r.agent_id,
      jwk: JSON.parse(r.public_jwk) as PublicKeyEntry['jwk'],
      createdAt: r.created_at,
      ...(r.retired_at ? { retiredAt: r.retired_at } : {}),
    };
  }
}
