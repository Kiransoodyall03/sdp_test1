# Authors and Identity Merging

Git `.mailmap` identities are resolved during ingestion through `git log --use-mailmap`. RAT also supports manual mappings for aliases that the repository does not canonicalize.

## API

List observed identities and their effective canonical author:

```http
GET /api/repos/:repoId/authors
```

Each author includes its direct `observedCommitCount`, `canonicalAuthorId`, merge state, and an `effectiveCommitCount` for canonical authors. A merged alias has an effective count of zero because its commits contribute to the target.

Create a mapping:

```http
POST /api/repos/:repoId/author-merges
Content-Type: application/json

{
  "sourceAuthorId": 2,
  "targetAuthorId": 1
}
```

The source is the alias and the target is the canonical identity. A new mapping returns HTTP 201. Repeating the same mapping is idempotent and returns 200 with `created: false`.

Remove a mapping by its source author:

```http
DELETE /api/repos/:repoId/author-merges/:sourceAuthorId
```

A successful removal returns HTTP 204.

## Validation and data integrity

Both identities must exist in the requested repository, and an author cannot map to itself. Mappings remain flat: a target cannot already be an alias, and a source cannot already receive other aliases. Reassigning a source requires deleting its existing mapping first. These rules prevent chains and cycles and make canonical resolution one indexed join.

Manual merging does not update `commits.author_id`. Metrics resolve `source_author_id` to `target_author_id` at read time, preserving the original post-`.mailmap` ingestion facts and making an unmerge immediately reversible.

## Author metrics

```http
GET /api/repos/:repoId/authors/metrics
```

This endpoint accepts the file/directory scope, inclusive `from`, exclusive `to`, and manual `commits` filters described in `METRICS.md`. It returns canonical authors only. For each author:

- `commitCount` is the number of selected commits attributed to the canonical identity.
- `modifications` counts those commits with non-zero churn in the selected object scope.
- `churn` sums added and removed text lines from those commits.
- `ownership` is author churn divided by total churn in the selected scope, or zero when total churn is zero.
