import type { ApprovalRequest, Attestation, BrokerRequest } from '@custodes/schema';
import { Attestation as AttestationSchema } from '@custodes/schema';

export class AuditStore {
  constructor(private readonly db: D1Database) {}

  async insert(att: Attestation): Promise<void> {
    const r = att.record;
    await this.db
      .prepare(
        `INSERT INTO audit (id, ts, agent_id, agent_version, run_id, decision, action_type, repo, action_hash, key_id, record_json, signature)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .bind(
        r.id,
        r.ts,
        r.agentId,
        r.agentVersion,
        r.runId,
        r.decision,
        r.action.type,
        r.action.repo,
        r.actionHash,
        att.keyId,
        JSON.stringify(r),
        att.signature,
      )
      .run();
  }

  async get(id: string): Promise<Attestation | null> {
    const row = await this.db
      .prepare('SELECT record_json, key_id, signature FROM audit WHERE id = ?1')
      .bind(id)
      .first<{ record_json: string; key_id: string; signature: string }>();
    if (!row) return null;
    return AttestationSchema.parse({
      record: JSON.parse(row.record_json) as unknown,
      keyId: row.key_id,
      signature: row.signature,
    });
  }

  async list(agentId: string | undefined, limit: number): Promise<Attestation[]> {
    const stmt = agentId
      ? this.db
          .prepare(
            'SELECT record_json, key_id, signature FROM audit WHERE agent_id = ?1 ORDER BY ts DESC LIMIT ?2',
          )
          .bind(agentId, limit)
      : this.db
          .prepare('SELECT record_json, key_id, signature FROM audit ORDER BY ts DESC LIMIT ?1')
          .bind(limit);
    const { results } = await stmt.all<{
      record_json: string;
      key_id: string;
      signature: string;
    }>();
    return results.map((row) =>
      AttestationSchema.parse({
        record: JSON.parse(row.record_json) as unknown,
        keyId: row.key_id,
        signature: row.signature,
      }),
    );
  }

  async countAllowedSince(agentId: string, sinceIso: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit WHERE agent_id = ?1 AND decision = 'allowed' AND ts >= ?2`,
      )
      .bind(agentId, sinceIso)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
}

interface ApprovalRow {
  id: string;
  agent_id: string;
  run_id: string;
  action_hash: string;
  request_json: string;
  status: ApprovalRequest['status'];
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  consumed_at: string | null;
}

export class ApprovalStore {
  constructor(private readonly db: D1Database) {}

  async create(
    req: BrokerRequest,
    rationale: string,
    actionHash: string,
    ttlSeconds: number,
    now = new Date(),
  ): Promise<ApprovalRequest> {
    const approval: ApprovalRequest = {
      id: crypto.randomUUID(),
      agentId: req.agentId,
      runId: req.runId,
      action: req.action,
      rationale,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      status: 'pending',
    };
    await this.db
      .prepare(
        `INSERT INTO approvals (id, agent_id, run_id, action_hash, request_json, status, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)`,
      )
      .bind(
        approval.id,
        approval.agentId,
        approval.runId,
        actionHash,
        JSON.stringify(approval),
        approval.createdAt,
        approval.expiresAt,
      )
      .run();
    return approval;
  }

  async get(
    id: string,
  ): Promise<(ApprovalRequest & { actionHash: string; consumedAt: string | null }) | null> {
    const row = await this.db
      .prepare('SELECT * FROM approvals WHERE id = ?1')
      .bind(id)
      .first<ApprovalRow>();
    return row ? toApproval(row) : null;
  }

  async listPending(limit: number): Promise<ApprovalRequest[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?1`)
      .bind(limit)
      .all<ApprovalRow>();
    return results.map(toApproval);
  }

  /** Records a human decision. Only pending, unexpired requests can be decided. */
  async decide(
    id: string,
    decision: 'approved' | 'rejected',
    by: string,
    now = new Date(),
  ): Promise<'ok' | 'not_found' | 'not_pending' | 'expired'> {
    const cur = await this.get(id);
    if (!cur) return 'not_found';
    if (cur.status !== 'pending') return 'not_pending';
    if (new Date(cur.expiresAt) < now) {
      await this.db.prepare(`UPDATE approvals SET status = 'expired' WHERE id = ?1`).bind(id).run();
      return 'expired';
    }
    await this.db
      .prepare(
        `UPDATE approvals SET status = ?2, decided_by = ?3, decided_at = ?4 WHERE id = ?1 AND status = 'pending'`,
      )
      .bind(id, decision, by, now.toISOString())
      .run();
    return 'ok';
  }

  /** Marks an approved request as used so it cannot authorise a second action. */
  async consume(id: string, now = new Date()): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE approvals SET consumed_at = ?2 WHERE id = ?1 AND status = 'approved' AND consumed_at IS NULL`,
      )
      .bind(id, now.toISOString())
      .run();
    return res.meta.changes === 1;
  }
}

function toApproval(
  row: ApprovalRow,
): ApprovalRequest & { actionHash: string; consumedAt: string | null } {
  const base = JSON.parse(row.request_json) as ApprovalRequest;
  return {
    ...base,
    status: row.status,
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    actionHash: row.action_hash,
    consumedAt: row.consumed_at,
  };
}
