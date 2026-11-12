-- Bundle approval requests per agent (ADR 0019), recorded before the broker reads GitHub, refused
-- ones included: the hourly cap must count asks that never became an approval. Rows older than a
-- day are deleted on insert, so the table stays small.
CREATE TABLE IF NOT EXISTS bundle_asks (
  agent_id TEXT NOT NULL,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bundle_asks_agent_at ON bundle_asks (agent_id, at);
