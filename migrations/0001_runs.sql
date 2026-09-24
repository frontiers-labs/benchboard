CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  branch TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('nightly', 'candidate')),
  timestamp TEXT NOT NULL,
  machine TEXT NOT NULL,
  config TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS runs_latest ON runs(project, branch, kind, machine, config, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS runs_project_time ON runs(project, timestamp DESC, id DESC);
