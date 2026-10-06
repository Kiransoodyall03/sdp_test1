-- Repo Analysis Tool schema, version 1.
--
-- Only atomic facts from git are stored. Growth, churn, modifications,
-- modification frequency, churn rate, and author ownership are derived by
-- queries so stored data cannot drift from their definitions.

CREATE TABLE repositories (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  source_type   TEXT    NOT NULL CHECK (source_type IN ('zip', 'clone')),
  source_origin TEXT    NOT NULL CHECK (length(trim(source_origin)) > 0),
  head_commit   TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'ready', 'error')),
  error_message TEXT,
  storage_path  TEXT    NOT NULL UNIQUE CHECK (length(trim(storage_path)) > 0),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at   TEXT,
  CHECK (status = 'error' OR error_message IS NULL)
);

CREATE TABLE authors (
  id         INTEGER PRIMARY KEY,
  repo_id    INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  email      TEXT    NOT NULL CHECK (length(trim(email)) > 0),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (repo_id, name, email),
  UNIQUE (id, repo_id)
);

-- A manual merge maps an observed identity to another existing identity in
-- the same repository. Composite foreign keys enforce repository scope; the
-- service layer prevents chains/cycles. Git .mailmap aliases are resolved
-- during ingestion and therefore do not need rows here.
CREATE TABLE author_merges (
  id               INTEGER PRIMARY KEY,
  repo_id          INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  source_author_id INTEGER NOT NULL,
  target_author_id INTEGER NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (repo_id, source_author_id),
  CHECK (source_author_id <> target_author_id),
  FOREIGN KEY (source_author_id, repo_id)
    REFERENCES authors(id, repo_id) ON DELETE CASCADE,
  FOREIGN KEY (target_author_id, repo_id)
    REFERENCES authors(id, repo_id) ON DELETE CASCADE
);

-- Only non-merge commits reachable from the selected reference (normally
-- HEAD) are ingested. parent_hash is NULL for the initial commit.
CREATE TABLE commits (
  id             INTEGER PRIMARY KEY,
  repo_id        INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  hash           TEXT    NOT NULL CHECK (length(hash) BETWEEN 7 AND 64),
  parent_hash    TEXT,
  author_id      INTEGER NOT NULL,
  committer_date INTEGER NOT NULL CHECK (committer_date >= 0),
  subject        TEXT    NOT NULL DEFAULT '',
  UNIQUE (repo_id, hash),
  UNIQUE (id, repo_id),
  FOREIGN KEY (author_id, repo_id)
    REFERENCES authors(id, repo_id) ON DELETE RESTRICT
);

-- One row is an atomic per-commit file diff. For a rename, path is the new
-- path and old_path records its previous name. Git reports binary numstat as
-- '- -'; such rows are marked and excluded from metric sums.
CREATE TABLE file_changes (
  id         INTEGER PRIMARY KEY,
  repo_id    INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commit_id  INTEGER NOT NULL,
  path       TEXT    NOT NULL CHECK (length(path) > 0),
  added      INTEGER NOT NULL DEFAULT 0 CHECK (added >= 0),
  removed    INTEGER NOT NULL DEFAULT 0 CHECK (removed >= 0),
  is_binary  INTEGER NOT NULL DEFAULT 0 CHECK (is_binary IN (0, 1)),
  is_rename  INTEGER NOT NULL DEFAULT 0 CHECK (is_rename IN (0, 1)),
  old_path   TEXT,
  UNIQUE (commit_id, path),
  CHECK (is_binary = 0 OR (added = 0 AND removed = 0)),
  CHECK (
    (is_rename = 0 AND old_path IS NULL) OR
    (is_rename = 1 AND old_path IS NOT NULL AND length(old_path) > 0)
  ),
  FOREIGN KEY (commit_id, repo_id)
    REFERENCES commits(id, repo_id) ON DELETE CASCADE
);

-- Listing and archive queries.
CREATE INDEX idx_repositories_archived_status
  ON repositories (archived_at, status);

-- Author lookup and filtered author metrics.
CREATE INDEX idx_authors_repo
  ON authors (repo_id);
CREATE INDEX idx_author_merges_target
  ON author_merges (repo_id, target_author_id);

-- Commit-set filters H_t and H_i,j, plus author filters.
CREATE INDEX idx_commits_repo_date
  ON commits (repo_id, committer_date);
CREATE INDEX idx_commits_repo_author_date
  ON commits (repo_id, author_id, committer_date);

-- Exact file and directory-prefix metric aggregation.
CREATE INDEX idx_file_changes_commit
  ON file_changes (commit_id);
CREATE INDEX idx_file_changes_repo_path
  ON file_changes (repo_id, path);
CREATE INDEX idx_file_changes_repo_path_commit
  ON file_changes (repo_id, path, commit_id);
