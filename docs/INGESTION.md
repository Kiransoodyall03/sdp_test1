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

## Zip upload API

Submit one `.zip` file in the `repository` field of a multipart request. The optional `name` field defaults to the archive filename without `.zip`.

```http
POST /api/repos/upload
Content-Type: multipart/form-data

repository=@repository.zip
name=Uploaded repository
```

The archive may contain the working tree at any nesting depth within the configured limit. Its repository marker may be a normal `.git` directory or a `.git` pointer file whose relative target is also inside the archive. Successful uploads return the same HTTP 201 repository shape and enter the same ingestion pipeline as clone URLs.

Multer streams uploads to generated temporary filenames and enforces upload, file, field, and part limits. Before extraction, RAT validates the ZIP signature and rejects empty archives, path traversal, absolute paths, duplicate output paths, symbolic links, encrypted entries, excessive entry counts, excessive nesting, and declared or actual extracted content above the configured limit. Temporary uploads and extracted files are removed after both success and failure. The retained repository is a generated bare clone, never the untrusted working tree.

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

The repository row moves through `pending` → `processing` → `ready`. If cloning, parsing, or persistence fails, all partially inserted authors, commits, and file changes are removed in one cleanup transaction, the partial clone is removed, and the repository row remains as `error` for diagnosis. Zip validation occurs before creating that row, so rejected archives do not create repository records.
