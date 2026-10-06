# Database Design

RAT uses a local SQLite database. `src/server/db/connection.js` creates the database and its parent directory automatically on first run; the default file is `data/rat.sqlite`, which is ignored by git. `schema.sql` is the authoritative schema and migration version 1.

Foreign keys are enabled on every connection. File databases use WAL journal mode for concurrent dashboard reads during ingestion, `synchronous=NORMAL`, and a 5-second busy timeout.

## Tables

### `repositories`

One row per imported repository.

| Column | Type and constraints | Purpose |
| --- | --- | --- |
| `id` | INTEGER PRIMARY KEY | Repository identifier. |
| `name` | TEXT NOT NULL, non-empty CHECK | Display name. |
| `source_type` | TEXT NOT NULL, CHECK `zip` or `clone` | Ingestion method. |
| `source_origin` | TEXT NOT NULL, non-empty CHECK | Clone URL or original zip filename. |
| `head_commit` | TEXT nullable | Reference commit used to define reachable history. |
| `status` | TEXT NOT NULL DEFAULT `pending`, CHECK `pending`, `processing`, `ready`, or `error` | Ingestion lifecycle. |
| `error_message` | TEXT nullable; only allowed when status is `error` | Actionable ingestion failure. |
| `storage_path` | TEXT NOT NULL UNIQUE, non-empty CHECK | Local bare repository location. |
| `created_at` | TEXT NOT NULL, UTC timestamp default | Creation time. |
| `archived_at` | TEXT nullable | Soft archive timestamp; the row remains viewable. |

### `authors`

Observed author identities after git `.mailmap` resolution.

| Column | Type and constraints | Purpose |
| --- | --- | --- |
| `id` | INTEGER PRIMARY KEY | Author identity. |
| `repo_id` | INTEGER NOT NULL, FK repositories, cascade delete | Owning repository. |
| `name` | TEXT NOT NULL, non-empty CHECK | Canonicalized git author name. |
| `email` | TEXT NOT NULL, non-empty CHECK | Canonicalized git author email. |
| `created_at` | TEXT NOT NULL, UTC timestamp default | Creation time. |

`(repo_id, name, email)` is unique.

### `author_merges`

Manual alias mappings when a repository has no sufficient `.mailmap`.

| Column | Type and constraints | Purpose |
| --- | --- | --- |
| `id` | INTEGER PRIMARY KEY | Mapping identifier. |
| `repo_id` | INTEGER NOT NULL, FK repositories, cascade delete | Repository scope. |
| `source_author_id` | INTEGER NOT NULL, FK authors, cascade delete | Alias identity being merged. |
| `target_author_id` | INTEGER NOT NULL, FK authors, cascade delete | Identity that receives the metrics. |
| `created_at` | TEXT NOT NULL, UTC timestamp default | Creation time. |

A source can have one mapping per repository and cannot map to itself. Composite foreign keys ensure both authors belong to the repository; the service layer prevents chains/cycles.

### `commits`

The non-merge commits reachable from the selected reference (normally HEAD).

| Column | Type and constraints | Purpose |
| --- | --- | --- |
| `id` | INTEGER PRIMARY KEY | Internal commit identifier. |
| `repo_id` | INTEGER NOT NULL, FK repositories, cascade delete | Repository scope. |
| `hash` | TEXT NOT NULL, length 7–64 | Git object ID. |
| `parent_hash` | TEXT nullable | Previous commit; null for the initial commit. |
| `author_id` | INTEGER NOT NULL, FK authors, restrict delete | Resolved author. |
| `committer_date` | INTEGER NOT NULL, non-negative CHECK | UNIX seconds used for time commit sets. |
| `subject` | TEXT NOT NULL DEFAULT empty | Commit selector label. |

`(repo_id, hash)` is unique.

### `file_changes`

Atomic per-file numstat facts for a commit.

| Column | Type and constraints | Purpose |
| --- | --- | --- |
| `id` | INTEGER PRIMARY KEY | Change identifier. |
| `repo_id` | INTEGER NOT NULL, FK repositories, cascade delete | Repository scope for indexed aggregation. |
| `commit_id` | INTEGER NOT NULL, FK commits, cascade delete | Commit that introduced the change. |
| `path` | TEXT NOT NULL, non-empty CHECK | Current/new path; metrics on a rename use this path. |
| `added` | INTEGER NOT NULL DEFAULT 0, non-negative CHECK | Lines added. |
| `removed` | INTEGER NOT NULL DEFAULT 0, non-negative CHECK | Lines removed. |
| `is_binary` | INTEGER NOT NULL DEFAULT 0, CHECK 0/1 | Git identified binary file; added/removed must both be zero. |
| `is_rename` | INTEGER NOT NULL DEFAULT 0, CHECK 0/1 | Rename detected at the configured 50% threshold. |
| `old_path` | TEXT nullable | Previous path; required only for renames. |

`(commit_id, path)` is unique.

## Relationships and indexing

A repository has many authors, commits and file changes. A commit belongs to one resolved author in the same repository and has many file changes scoped to that repository. Manual author merges map one observed author to another within the same repository. Composite foreign keys enforce these repository boundaries.

Indexes support repository archive/status listing, time-range commit sets, author filters, exact file queries and path-prefix directory aggregation. Ingestion writes in transactions; metric requests aggregate indexed stored facts instead of re-running git.

## Derived metrics

Only `added` and `removed` atomic facts are stored. The following are calculated at read time:

- growth = added − removed
- churn = added + removed
- modifications = count of selected commits with churn greater than zero
- modification frequency = modifications / selected commit count (or zero for an empty set)
- churn rate = churn / selected commit count (or zero for an empty set)
- author ownership = author churn / total churn (or zero when total churn is zero)

Directory metrics aggregate matching descendant file paths; repository metrics are directory metrics at the root. Binary rows remain available for file listings but are excluded from line metrics.

## Archiving

Repositories are never copied to an archive table or hard-deleted through the application. Setting `repositories.archived_at` hides a repository from the default list while retaining the same row and all related history. Clearing it restores the repository.
