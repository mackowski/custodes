-- Append-only audit log. Rows are never updated or deleted by application code.
CREATE TABLE IF NOT EXISTS audit (
  id            TEXT PRIMARY KEY,
  ts            TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  decision      TEXT NOT NULL CHECK (decision IN ('allowed', 'denied', 'halted')),
  action_type   TEXT NOT NULL,
  repo          TEXT NOT NULL,
  action_hash   TEXT NOT NULL,
  key_id        TEXT NOT NULL,
  record_json   TEXT NOT NULL,
  signature     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_agent_ts ON audit (agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_run ON audit (run_id);

-- Approval requests: created by agents (via broker), decided by humans (CLI / email / admin API).
CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  action_hash   TEXT NOT NULL,
  request_json  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  decided_by    TEXT,
  decided_at    TEXT,
  consumed_at   TEXT
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status, created_at DESC);
