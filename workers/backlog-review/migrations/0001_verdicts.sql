-- backlog-review's digest (#132 v1, threat model backlog-review): written only by the
-- custodes-backlog-review Worker, read by the operator through the Cloudflare API (untrusted data,
-- ADR 0016). Ids, enums and capped, redacted model text only; rows older than 90 days are deleted.
CREATE TABLE verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue INTEGER NOT NULL,
  -- The issue's updated_at when it was selected: the selector's "changed since" key.
  issue_updated_at TEXT NOT NULL,
  at TEXT NOT NULL,
  -- 'ok': a verdict; 'stopped': the child ended without one (stop holds the enum).
  status TEXT NOT NULL CHECK (status IN ('ok', 'stopped')),
  stop TEXT,
  state TEXT,
  confidence TEXT,
  uncertain_because TEXT NOT NULL DEFAULT '[]',
  needs_human INTEGER NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL DEFAULT '[]',
  -- Model text, capped and redacted like run events.
  reason TEXT NOT NULL DEFAULT '',
  root_run_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_version TEXT NOT NULL
);
CREATE INDEX verdicts_issue ON verdicts (repo, issue, at);
CREATE INDEX verdicts_at ON verdicts (at);
-- One row per child run: the actions of a verdict find it by run_id.
CREATE UNIQUE INDEX verdicts_run_id ON verdicts (run_id);

CREATE TABLE verdict_actions (
  verdict_id INTEGER NOT NULL REFERENCES verdicts (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  -- The BrokerAction as JSON, as the dispatcher routed it.
  action TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('digest', 'drop', 'approval', 'act')),
  -- Shadow: where it would go live ('approval' or 'act'); null when dropped.
  live TEXT,
  detail TEXT NOT NULL,
  PRIMARY KEY (verdict_id, position)
);
