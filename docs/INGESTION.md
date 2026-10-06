# Repository Ingestion

## Clone API

Submit a remote repository URL as JSON:

```http
POST /api/repos
Content-Type: application/json

{
  "url": "https://github.com/DaveGamble/cJSON.git",
  "name": "cJSON"
}
```

`name` is optional and defaults to the final URL path without `.git`. Accepted URL forms are HTTP(S), SSH, Git, `file://` (useful for local tests), and SCP-style `git@host:owner/repo.git`. Credentials embedded in URLs are rejected so they are not persisted. Success returns HTTP 201 with the repository status and ingestion counts. Validation errors return 400; clone or history failures return 422 and leave a repository row with `status=error` and an actionable message.

## Clone strategy

RAT runs Git through `child_process.spawn` with an argument array, never a shell. Interactive credential prompts and system-level Git configuration are disabled, and commands use the configured timeout. Clone ingestion uses:

```text
git clone --bare --quiet -- <url> <generated-storage-path>
```

The clone is deep: no `--depth`, shallow, or single-branch option is used. The generated local path prevents URL-controlled path traversal and allows the same remote to be imported more than once.

## History extraction

After resolving HEAD, RAT streams one history process:

```text
git -C <bare-repo> log HEAD
  --no-merges --use-mailmap --root --no-ext-diff
  --find-renames=50% --numstat -z
  --format=<NUL-delimited commit fields>
```

This directly implements the specification:

- `HEAD` defines the reference commit.
- `--no-merges` produces the reachable non-merge commit set.
- `--root` compares the initial commit with Git’s empty tree.
- uppercase `%aN` and `%aE` plus `--use-mailmap` resolve canonical author identities.
- `--find-renames=50%` enables the required threshold.
- `--numstat` supplies atomic added/removed line counts.
- `-z` preserves paths containing whitespace, tabs, quotes, or newlines.
- `--no-ext-diff` prevents repository-local diff drivers from changing results.

Git emits a binary file as `-` added and `-` removed. RAT stores the row with `is_binary=1` and zero line counts, so it remains discoverable but is excluded from line metrics. A NUL-delimited rename has separate old/new paths; RAT stores metrics against the new `path` and retains `old_path`. A deletion remains attributed to its deleted path with its removed-line count.

## Performance and failure behavior

Output is parsed incrementally rather than buffered in memory or collected through one Git command per commit. Database writes use bounded batches of up to 1,000 commits or roughly 2,000 file changes. This permits large histories while avoiding a long-lived SQLite transaction across asynchronous process output.

The repository row moves through `pending` → `processing` → `ready`. If cloning, parsing, or persistence fails, all partially inserted authors, commits, and file changes are removed in one cleanup transaction, the partial clone is removed, and the repository row remains as `error` for diagnosis.
