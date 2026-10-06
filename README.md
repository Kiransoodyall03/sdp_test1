# Repo Analysis Tool (RAT)

A web dashboard that measures git metrics — per **file**, **directory**, **repository**, **commit set**, and **author** — across **multiple repositories**. Repositories are ingested either from a **clone URL** or an uploaded **zip** (containing the `.git` directory). Authors can be merged via `.mailmap` or manually.

Built for the COMS3011A assessment. Architecture, metric formulas and database design live in `docs/`.

## Running It

**Requirements**

- **Node 18.19.1** — pinned in `.nvmrc`; `package.json` sets `engines.node >= 18.19`.
- **git 2.23+** on `PATH` — used for cloning and for metric extraction (relies on `--use-mailmap`, added in git 2.23).

**From a clean clone**

```bash
npm install     # install dependencies
npm start       # start the server -> http://localhost:3000
npm test        # run the automated tests
```

Or use the provided script, which installs (if needed) and starts the app:

```bash
./start.sh
```

For local development with auto-reload: `npm run dev`.

**Configuration** is via environment variables — see `.env.example`. No secrets or cloud credentials are required; the SQLite database file is created automatically on first run under `data/` (git-ignored).

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

Dev dependencies: none — tests use Node's built-in `node:test` runner and `node:assert`.

> More dependencies (SQLite driver, upload handling) are introduced and documented here in later slices.

## Current status

Being built incrementally, one slice at a time.

- [x] **Slice 1 — Scaffold & design system:** Express server, static dashboard shell, `/api/health`, Google-palette CSS design tokens, test harness.
- [ ] Slice 2 — Database layer (schema + migrations)
- [ ] Slice 3 — Ingestion: clone URL
- [ ] Slice 4 — Ingestion: zip upload
- [ ] Slice 5 — Metrics engine (file / directory / repository / commit-set)
- [ ] Slice 6 — Author merging + author metrics
- [ ] Slice 7 — Dashboard: filters + metric views
- [ ] Slice 8 — Multi-repo management + archive/restore
- [ ] Slice 9 — Error handling, performance & QoL
- [ ] Slice 10 — Full documentation + final verification

## License

MIT
