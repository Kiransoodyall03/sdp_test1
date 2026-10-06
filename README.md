# Repo Analysis Tool (RAT)

A web dashboard that measures git metrics — per **file**, **directory**, **repository**, **commit set**, and **author** — across **multiple repositories**. Repositories are ingested either from a **clone URL** or an uploaded **zip** (containing the `.git` directory). Authors can be merged via `.mailmap` or manually.

Built for the COMS3011A assessment. Architecture, metric formulas and database design live in `docs/`.

## Running It

**Requirements**

- **Node 18.19.1** — pinned in `.nvmrc`; `package.json` sets `engines.node >= 18.19`.
- **git 2.23+** on `PATH` — used for cloning and for metric extraction (relies on `--use-mailmap`, added in git 2.23).

**From a clean clone**

```bash
PYTHON=/usr/bin/python3 npm ci  # install the exact lockfile (Ubuntu)
npm start                       # start -> http://localhost:3000
npm test                        # run all automated tests
```

Or use the recommended portable script, which selects a suitable Python for native dependencies, installs the exact lockfile if needed, and starts the app:

```bash
./start.sh
```

For local development with auto-reload: `npm run dev`.

**Configuration** is via environment variables — see `.env.example`. No secrets or cloud credentials are required; the SQLite database file is created automatically on first run under `data/` (git-ignored).

Clone a repository through the API:

```bash
curl -X POST http://localhost:3000/api/repos \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/DaveGamble/cJSON.git","name":"cJSON"}'
```

Upload a repository archive and query its metrics:

```bash
curl -X POST http://localhost:3000/api/repos/upload \
  -F 'repository=@repository.zip' -F 'name=Uploaded repository'
curl 'http://localhost:3000/api/repos/1/metrics?type=directory&path=src'
```

The clone and zip extraction design is documented in [`docs/INGESTION.md`](docs/INGESTION.md). Metric definitions, filters, and API responses are documented in [`docs/METRICS.md`](docs/METRICS.md). Manual identity merging is documented in [`docs/AUTHORS.md`](docs/AUTHORS.md).

## Project layout

```
config/            app configuration (env-driven, no secrets)
src/server/        Express app: routes, controllers, services, db
src/client/        HTML + client-side JS
src/styles/        CSS (design tokens, base, components) - no inline styles
tests/             automated tests (node:test)
docs/              architecture / metrics / database documentation
```

## Third-Party Code

Runtime dependencies (each kept minimal and justifiable):

- **express** — minimal, widely-used HTTP server and router for the JSON API and static assets.
- **better-sqlite3** — fast transactional SQLite access for bulk ingestion and indexed synchronous metric queries.
- **multer** — bounded multipart parsing with temporary disk storage for repository zip uploads.
- **adm-zip** — archive inspection and entry-by-entry extraction after RAT applies its safety checks.

Dev dependencies: none — tests use Node's built-in `node:test` runner and `node:assert`.

## Database Design

The authoritative schema is [`src/server/db/schema.sql`](src/server/db/schema.sql). Every table, column, constraint, relationship, index, derived metric and archive rule is documented in [`docs/DATABASE.md`](docs/DATABASE.md); the documentation matches migration version 1.

## Current status

Being built incrementally, one slice at a time.

- [x] **Slice 1 — Scaffold & design system:** Express server, static dashboard shell, `/api/health`, Google-palette CSS design tokens, test harness.
- [x] **Slice 2 — Database layer:** committed schema, versioned migration, constraints/indexes, automatic first-run creation and isolated DB tests.
- [x] **Slice 3 — Ingestion: clone URL:** deep bare clone, streaming NUL-safe history parser, mailmap resolution, 50% renames, binary detection and transactional batch storage.
- [x] **Slice 4 — Ingestion: zip upload:** bounded multipart upload, guarded extraction, nested `.git` directory/pointer discovery, and reuse of the streaming ingestion pipeline.
- [x] **Slice 5 — Metrics engine:** read-time file, directory, repository, and commit-set metrics with intersecting author, date, path, and manual-commit filters.
- [x] **Slice 6 — Author merging + author metrics:** flat, validated manual identity mappings; merge-aware filtering; and per-author modifications, churn, and ownership.
- [ ] Slice 7 — Dashboard: filters + metric views
- [ ] Slice 8 — Multi-repo management + archive/restore
- [ ] Slice 9 — Error handling, performance & QoL
- [ ] Slice 10 — Full documentation + final verification

## License

MIT
