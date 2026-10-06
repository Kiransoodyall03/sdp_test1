# Metrics Engine

RAT calculates metrics from the atomic `added`, `removed`, and `is_binary` facts stored during ingestion. Derived values are not persisted, so every filtered response is calculated from the same source data.

## API

```http
GET /api/repos/:repoId/metrics
GET /api/repos/:repoId/objects?type=file|directory
```

A metrics request without `path` returns repository metrics. Object-scoped requests require both `type` and `path`:

```text
/api/repos/1/metrics?type=file&path=src/main.js
/api/repos/1/metrics?type=directory&path=src
```

Directory metrics recursively include descendant files. The repository scope is the root-directory aggregate. `/objects` returns historical paths, including deleted files and both sides of a rename; directory results include the root as an empty string.

## Commit-set filters

The following optional query parameters intersect to define the selected commit set `H`:

| Parameter | Meaning |
| --- | --- |
| `author` | Positive repository-local author ID |
| `from` | Inclusive committer date, as UNIX seconds or an ISO timestamp |
| `to` | Exclusive committer date, as UNIX seconds or an ISO timestamp |
| `commits` | Comma-separated hashes, or repeated query parameters, limited to 500 unique hashes |

For example:

```text
/api/repos/1/metrics?author=2&from=2024-01-01T00:00:00Z&to=2024-02-01T00:00:00Z
/api/repos/1/metrics?commits=<hash-1>,<hash-2>
```

An explicitly empty `commits` value selects the empty set and returns zero metrics. Unknown repositories, authors, paths, or commit hashes return HTTP 404. Invalid input returns 400, and repositories that are not ready return 409.

## Definitions

For the selected commit set and object scope:

- `added` is the sum of added text lines.
- `removed` is the sum of removed text lines.
- `growth = added - removed`.
- `churn = added + removed`.
- `modifications` is the number of selected commits with non-zero line churn in the scope.
- `modificationFrequency = modifications / selected commit count`.
- `churnRate = churn / selected commit count`.

An empty commit set gives both rates as zero. Binary rows remain available in file listings but contribute zero to line metrics. Pure renames contribute no line changes, while changes accompanying a rename are attributed only to the new path. Deleted files retain their removed-line contribution on their final path.

## Query strategy

The service first selects commit IDs through indexed repository, author, date, and hash predicates. One joined aggregation then groups matching file changes per commit, allowing modification counts and line totals to be calculated without loading commit history into application memory. File scopes use exact indexed paths; directory scopes use repository-relative path prefixes.
