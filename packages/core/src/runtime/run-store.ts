import { canonicalJson } from '../canonical.js';

/**
 * Run state and the run event channel of one agent, in its Durable Object's SQLite (ADR 0023).
 * Strongly consistent, so a kill is seen before the next round. Ids are made here, never taken
 * from model output or a request. Event payloads are untrusted data (ADR 0016): model text and
 * tool arguments, capped and with token-shaped strings removed; never error text.
 */

/** The subset of a Durable Object's `ctx.storage.sql` the store needs; unit tests use node:sqlite. */
export interface SqlLike {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[] };
}

export type RunStatus = 'running' | 'done' | 'stopped' | 'escalated' | 'killed';

export interface RunRecord {
  runId: string;
  parentRunId: string | null;
  agentId: string;
  status: RunStatus;
  killed: boolean;
  startedAt: string;
  spentUsd: number;
}

export interface RunEvent {
  runId: string;
  parentRunId: string | null;
  round: number;
  /** Null for a model turn that called no tool. */
  tool: string | null;
  /** Canonical JSON of the arguments, capped and redacted. */
  args: string;
  resultSize: number;
  /** Capped at MODEL_TEXT_CAP characters and redacted. */
  modelText: string;
  at: string;
}

/** ADR 0016's cap for payloads, kept for the event channel (ADR 0023). */
export const MODEL_TEXT_CAP = 8_000;
const ARGS_CAP = 2_000;
/** Events and finished runs older than this are pruned by the agent's alarm (ADR 0023). */
export const EVENT_RETENTION_MS = 14 * 24 * 3_600_000;

/**
 * Token-shaped strings are removed before anything is stored. The agent holds no GitHub token, but
 * text it read can carry one (or a fake one), and the channel must never become a place tokens
 * are kept (ADR 0016).
 */
const TOKEN_SHAPES: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-(?:ant|or)-[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
];

export function redact(text: string): string {
  return TOKEN_SHAPES.reduce((t, re) => t.replace(re, '[redacted]'), text);
}

function clip(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…[clipped]` : text;
}

interface RunRow extends Record<string, unknown> {
  run_id: string;
  parent_run_id: string | null;
  agent_id: string;
  status: RunStatus;
  killed: number;
  started_at: string;
  spent_usd: number;
}

export class RunStore {
  constructor(
    private readonly sql: SqlLike,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS runtime_runs (
      run_id TEXT PRIMARY KEY, parent_run_id TEXT, agent_id TEXT NOT NULL,
      status TEXT NOT NULL, killed INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL, spent_usd REAL NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS runtime_events (
      run_id TEXT NOT NULL, parent_run_id TEXT, round INTEGER NOT NULL, tool TEXT,
      args TEXT NOT NULL, result_size INTEGER NOT NULL, model_text TEXT NOT NULL, at TEXT NOT NULL)`);
    sql.exec('CREATE INDEX IF NOT EXISTS runtime_events_run ON runtime_events (run_id, at)');
  }

  /**
   * Starts a run. A child names its parent, which must be a running top-level run of the same
   * agent: children cannot delegate (depth 1, ADR 0023).
   */
  start(agentId: string, parentRunId?: string): string {
    if (parentRunId !== undefined) {
      const parent = this.get(parentRunId);
      if (parent?.agentId !== agentId) throw new Error('unknown parent run');
      if (parent.parentRunId !== null) throw new Error('a child run cannot delegate');
      if (parent.killed || parent.status !== 'running')
        throw new Error('parent run is not running');
    }
    const runId = this.newId();
    this.sql.exec(
      'INSERT INTO runtime_runs (run_id, parent_run_id, agent_id, status, started_at) VALUES (?, ?, ?, ?, ?)',
      runId,
      parentRunId ?? null,
      agentId,
      'running',
      this.now().toISOString(),
    );
    return runId;
  }

  get(runId: string): RunRecord | null {
    const row = this.sql
      .exec<RunRow>('SELECT * FROM runtime_runs WHERE run_id = ?', runId)
      .toArray()[0];
    return row ? toRecord(row) : null;
  }

  finish(runId: string, status: Exclude<RunStatus, 'running' | 'killed'>): void {
    this.sql.exec(
      "UPDATE runtime_runs SET status = ? WHERE run_id = ? AND status = 'running'",
      status,
      runId,
    );
  }

  addSpend(runId: string, usd: number): void {
    if (!(usd >= 0)) throw new Error('spend must be a non-negative number');
    this.sql.exec('UPDATE runtime_runs SET spent_usd = spent_usd + ? WHERE run_id = ?', usd, runId);
  }

  /** Killed itself, or its parent was: a kill takes the whole tree. Unknown runs count as killed. */
  isKilled(runId: string): boolean {
    const run = this.get(runId);
    if (!run) return true;
    if (run.killed) return true;
    return run.parentRunId !== null && this.isKilled(run.parentRunId);
  }

  /** Kills a run and its children; returns how many runs it marked. */
  kill(runId: string): number {
    const ids = [
      runId,
      ...this.sql
        .exec<{ run_id: string }>('SELECT run_id FROM runtime_runs WHERE parent_run_id = ?', runId)
        .toArray()
        .map((r) => r.run_id),
    ];
    let n = 0;
    for (const id of ids) {
      const before = this.get(id);
      if (!before || before.killed) continue;
      this.sql.exec(
        "UPDATE runtime_runs SET killed = 1, status = CASE WHEN status = 'running' THEN 'killed' ELSE status END WHERE run_id = ?",
        id,
      );
      n++;
    }
    return n;
  }

  /** Spend of every run of this agent started since `sinceIso` (the tree-wide daily budget). */
  spentSince(agentId: string, sinceIso: string): number {
    const row = this.sql
      .exec<{ total: number | null }>(
        'SELECT SUM(spent_usd) AS total FROM runtime_runs WHERE agent_id = ? AND started_at >= ?',
        agentId,
        sinceIso,
      )
      .toArray()[0];
    return row?.total ?? 0;
  }

  recordEvent(e: {
    runId: string;
    round: number;
    tool: string | null;
    args: unknown;
    resultSize: number;
    modelText: string;
  }): void {
    const run = this.get(e.runId);
    if (!run) throw new Error('unknown run');
    this.sql.exec(
      'INSERT INTO runtime_events (run_id, parent_run_id, round, tool, args, result_size, model_text, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      e.runId,
      run.parentRunId,
      e.round,
      e.tool,
      clip(redact(canonicalJson(e.args ?? null)), ARGS_CAP),
      e.resultSize,
      clip(redact(e.modelText), MODEL_TEXT_CAP),
      this.now().toISOString(),
    );
  }

  /** A run's events and its children's, oldest first. */
  listEvents(runId: string, limit = 500): RunEvent[] {
    return this.sql
      .exec<{
        run_id: string;
        parent_run_id: string | null;
        round: number;
        tool: string | null;
        args: string;
        result_size: number;
        model_text: string;
        at: string;
      }>(
        'SELECT * FROM runtime_events WHERE run_id = ? OR parent_run_id = ? ORDER BY at, rowid LIMIT ?',
        runId,
        runId,
        Math.min(Math.max(1, limit), 2_000),
      )
      .toArray()
      .map((r) => ({
        runId: r.run_id,
        parentRunId: r.parent_run_id,
        round: r.round,
        tool: r.tool,
        args: r.args,
        resultSize: r.result_size,
        modelText: r.model_text,
        at: r.at,
      }));
  }

  /** Deletes events and finished runs past the retention; called by the agent's alarm. */
  prune(): { events: number; runs: number } {
    const cutoff = new Date(this.now().getTime() - EVENT_RETENTION_MS).toISOString();
    const count = (q: string) => this.sql.exec<{ n: number }>(q, cutoff).toArray()[0]?.n ?? 0;
    const events = count('SELECT COUNT(*) AS n FROM runtime_events WHERE at < ?');
    const runs = count(
      "SELECT COUNT(*) AS n FROM runtime_runs WHERE started_at < ? AND status != 'running'",
    );
    this.sql.exec('DELETE FROM runtime_events WHERE at < ?', cutoff);
    this.sql.exec("DELETE FROM runtime_runs WHERE started_at < ? AND status != 'running'", cutoff);
    return { events, runs };
  }
}

function toRecord(r: RunRow): RunRecord {
  return {
    runId: r.run_id,
    parentRunId: r.parent_run_id,
    agentId: r.agent_id,
    status: r.status,
    killed: r.killed === 1,
    startedAt: r.started_at,
    spentUsd: r.spent_usd,
  };
}

/**
 * The guard the loop calls before every round and every dispatch (ADR 0023): this run (or its
 * parent) killed in the store, or the agent or fleet halted (the broker's `/v1/state`, via
 * `brokerGuard`, which throws). Fails closed: an error reading either counts as halted.
 */
export function runGuard(
  store: Pick<RunStore, 'isKilled'>,
  runId: string,
  brokerGuard: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    if (store.isKilled(runId)) throw new Error('run killed');
    await brokerGuard();
  };
}

/** What the gateway and the supervisor may call on an agent's runtime (ADR 0023; routes: slice 3). */
export interface RuntimeHost {
  kill(runId: string): Promise<{ killed: number }>;
  listEvents(runId: string, limit?: number): Promise<RunEvent[]>;
}

/** The host over one agent's store; the Durable Object exposes these as RPC methods. */
export function runtimeHost(store: RunStore): RuntimeHost {
  return {
    kill: (runId) => Promise.resolve({ killed: store.kill(runId) }),
    listEvents: (runId, limit) => Promise.resolve(store.listEvents(runId, limit)),
  };
}

/** The daily spend of an agent's whole run tree, for the loop's budget check. */
export interface SpendLedger {
  spentToday(): Promise<number>;
  add(usd: number): Promise<void>;
}

/** A ledger over the store for one run: spend is added to that run, read across the agent. */
export function storeLedger(
  store: RunStore,
  agentId: string,
  runId: string,
  now: () => Date,
): SpendLedger {
  return {
    spentToday: () =>
      Promise.resolve(
        store.spentSince(agentId, new Date(now().getTime() - 24 * 3_600_000).toISOString()),
      ),
    add: (usd) => {
      store.addSpend(runId, usd);
      return Promise.resolve();
    },
  };
}
