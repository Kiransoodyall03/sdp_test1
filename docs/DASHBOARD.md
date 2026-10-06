# Dashboard UI

The browser dashboard is a single-page vanilla ES module application served from `src/client/`. It uses no build step, no framework, and no CSS-in-JS. All styling lives in `src/styles/` and is mounted at `/css` by Express.

## Architecture

```
src/client/
  index.html          Shell: header, filter sidebar, metric cards, footer
  js/
    api.js            JSON fetch helper, query builder, API wrappers
    charts.js         Hand-written accessible SVG bar chart
    main.js           Dashboard controller: state, events, rendering

src/styles/
  variables.css       Design tokens (Google palette, spacing, typography)
  base.css            Reset, app-shell layout, focus states
  components.css      Cards, buttons, fields, tables, badges
  dashboard.css       Filter form, commit picker, alerts, metric list
  charts.css          SVG bar chart colours and typography
```

## New API endpoints (Slice 7)

### `GET /api/repos`

Returns all non-archived repositories with summary counts.

Query parameters:

| Parameter | Meaning |
| --- | --- |
| `includeArchived` | Set to `true` to include archived repositories |

Response:

```json
{
  "repositories": [
    {
      "id": 1,
      "name": "my-repo",
      "sourceType": "clone",
      "sourceOrigin": "https://github.com/owner/repo.git",
      "headCommit": "abc123",
      "status": "ready",
      "errorMessage": null,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "archivedAt": null,
      "commitCount": 42,
      "authorCount": 5,
      "fileChangeCount": 180
    }
  ],
  "includeArchived": false
}
```

### `GET /api/repos/:repoId/commits`

Returns a paginated, filterable list of non-merge commits for the commit picker.

Query parameters:

| Parameter | Meaning |
| --- | --- |
| `limit` | Page size (default 100) |
| `offset` | Skip count (default 0) |
| `author` | Canonical author ID; merged aliases resolve to their target |
| `from` | Inclusive committer date (UNIX seconds or ISO timestamp) |
| `to` | Exclusive committer date (UNIX seconds or ISO timestamp) |
| `search` | Substring match on hash or subject; LIKE wildcards are escaped |

Response:

```json
{
  "repository": { "id": 1, "name": "my-repo" },
  "limit": 100,
  "offset": 0,
  "total": 42,
  "commits": [
    {
      "hash": "abc123...",
      "parentHash": "def456...",
      "author": { "name": "Dev", "email": "dev@example.com" },
      "date": "2024-01-01T00:00:00.000Z",
      "unixDate": 1704067200,
      "subject": "initial commit"
    }
  ]
}
```

## Filter behaviour

- **Repository**: selects the active repository; only `ready` repositories support metric views.
- **View**: `Repository`, `Directory`, or `File`. Changing the view updates the path selector.
- **Path**: populated from `/api/repos/:repoId/objects`. Historical paths (including deleted files and both sides of renames) are listed.
- **Author**: canonical authors only; merged aliases are hidden. Selecting an author filters all metric views.
- **Date range**: inclusive `from`, exclusive `to`. The end date is advanced by one UTC day before being sent to the API.
- **Commit set**: `Time filters` (default) or `Manual commits`. Manual mode replaces the date range but retains repository, author, and path filters.

## Object metrics table

Shows immediate children of the selected scope. For a repository or directory view, children are derived from the historical file and directory listings. For a file view, the single selected file is shown. Rows are capped at 50 with a note when truncated.

## Author ownership chart

A horizontal SVG bar chart shows the top 10 canonical authors by churn in the selected scope. The chart uses `role="img"` and `aria-label`; an adjacent table provides the full data for screen readers and keyboard users.

## Accessibility

- Skip link to main content.
- All form controls have associated `<label>` elements.
- Live regions (`role="status"`, `role="alert"`) announce loading and error states.
- No inline styles; all presentation is in external stylesheets.
- Visible focus ring on all interactive elements.
- Colour contrast meets WCAG AA against the white background.
