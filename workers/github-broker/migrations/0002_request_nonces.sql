-- Nonces of agent-signed requests (ADR 0018). A nonce is accepted once; rows older than twice the
-- signature window plus a minute are deleted on insert, so the table stays small.
CREATE TABLE IF NOT EXISTS request_nonces (
  nonce    TEXT PRIMARY KEY,
  caller   TEXT NOT NULL,
  seen_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS request_nonces_seen ON request_nonces (seen_at);
