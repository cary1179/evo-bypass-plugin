# Session Viewer Runtime Design

## Goal

When Evo Bypass finds possible knowledge updates at the end of a main-agent session, the bypass runtime can expose a local web UI for reviewing the session. The UI should show the current session metadata, hook events, reviewer suggestions, and nearby session history. Opening the UI must be configurable so the Stop hook remains reliable in non-GUI or restricted environments.

## Current Context

Evo Bypass already writes session artifacts under `.bypass/sessions/<session-id>/`:

- `metadata.json`
- `events.jsonl`
- `suggestions.json`
- `reviewer.log`
- approval/apply artifacts when suggestions are later accepted

`scripts/review-session.js` currently runs in the Stop hook, calls `reviewSession()`, and prints a short report. It does not know about any web UI. `.bypass/config.json` currently supports `knowledgeTarget`; this design extends that config instead of adding a second config file.

The prototype UI exists at `prototype/session-reviewer/index.html`. It has two views:

- session list, keyed by `session_id`
- session detail, showing metadata, hook timeline, event fields, suggestions, and reviewer log

## Configuration

Extend `.bypass/config.json` with a `viewer` object:

```json
{
  "knowledgeTarget": ".bypass/knowledge.md",
  "viewer": {
    "enabled": true,
    "openMode": "url",
    "host": "127.0.0.1",
    "port": 8765,
    "openOnlyWhenSuggestions": true
  }
}
```

Defaults:

- `viewer.enabled`: `false`
- `viewer.openMode`: `"url"`
- `viewer.host`: `"127.0.0.1"`
- `viewer.port`: `8765`
- `viewer.openOnlyWhenSuggestions`: `true`

`openMode` values:

- `off`: do not start the viewer
- `url`: start or reuse the local viewer and include the URL in the Stop hook report
- `browser`: start or reuse the local viewer, attempt to open the URL in the system browser, and still include the URL in the report

Invalid or missing config values should fall back to defaults. Invalid JSON should not break reviewing; the runtime should behave as if the viewer is disabled and continue writing `suggestions.json` and `reviewer.log`.

## Runtime Behavior

Stop hook flow:

1. `scripts/review-session.js` reads stdin and resolves `sessionId` and `root` as it does today.
2. It calls `reviewSession({ root, sessionId })`.
3. It reads normalized config from `.bypass/config.json`.
4. It decides whether to expose the viewer:
   - disabled if `viewer.enabled` is false
   - disabled if `viewer.openMode` is `off`
   - disabled if `viewer.openOnlyWhenSuggestions` is true and `result.suggestions.length === 0`
   - enabled otherwise
5. If enabled, it starts or reuses a local HTTP server.
6. It returns the same Codex/Claude-compatible Stop hook shape as today, with the report text augmented by the viewer URL.

The hook must not fail the user task if viewer startup or browser opening fails. Failures should be written to stderr or appended to the report as a non-blocking note. The existing suggestion report path remains the source of truth for main-agent instructions.

## Server Design

Add a small Node HTTP server using built-in modules only. No framework is needed for the first version.

Proposed files:

- `src/core/config.js`
  - read `.bypass/config.json`
  - merge defaults
  - validate and normalize viewer config
  - preserve existing `knowledgeTarget` behavior
- `src/viewer/session-store.js`
  - list session directories under `.bypass/sessions`
  - read and parse session artifact files
  - parse `events.jsonl`, skipping malformed lines and returning a `malformedCount`
  - return compact list summaries and full details
- `src/viewer/server.js`
  - create an HTTP server bound to `viewer.host`
  - serve static UI assets
  - expose JSON API endpoints
  - support start/reuse behavior
- `scripts/session-viewer.js`
  - CLI entrypoint for manual startup and Stop-hook startup
  - prints the resolved URL
  - can optionally open the browser

## API

`GET /api/sessions`

Returns a list of summaries:

```json
{
  "root": "/Users/sakki/Documents/evo-bypass",
  "sessions": [
    {
      "session_id": "019e...",
      "created_at": "2026-05-30T14:03:50.256Z",
      "runtime": "codex",
      "event_count": 128,
      "failure_count": 0,
      "signals": ["project_convention"],
      "suggestion_count": 1,
      "has_suggestion_report": true,
      "working_directory": "/Users/sakki/Documents/evo-bypass",
      "prompt_preview": "..."
    }
  ]
}
```

`GET /api/sessions/:session_id`

Returns full details:

```json
{
  "session_id": "019e...",
  "metadata": {},
  "events": [],
  "suggestions": {},
  "reviewerLog": "Found 1 possible knowledge update(s).",
  "malformedEventCount": 0
}
```

`GET /sessions`

Serves the session list web app.

`GET /sessions/:session_id`

Serves the same web app and lets the client route to the detail view.

Unknown API routes return 404 JSON. Unknown UI routes return the web app shell so browser refresh works.

## UI Integration

Move the prototype from a static mock-data file toward a small app shell:

- Keep the current two-view structure and visual language.
- Replace embedded mock sessions with API calls.
- On load:
  - `/sessions` fetches `/api/sessions`
  - `/sessions/:session_id` fetches `/api/sessions/:session_id`
- Show loading, empty, and malformed-event states.
- Preserve long-text behavior: prompts and evidence default to collapsed or scrollable.
- Do not add direct "apply suggestion" buttons in the first version.

The first version is read-only. Approval still goes through the main agent and `scripts/apply-approved-update.js`, preserving the current explicit-user-approval boundary.

## Browser Opening

For `openMode: "browser"`, the runtime may use the platform browser opener:

- macOS: `open <url>`
- Linux: `xdg-open <url>`
- Windows: `cmd /c start <url>`

Opening should be best-effort and detached. A failure to open the browser must not change the review result or suppress the URL in the report.

Because Stop hooks can run in restricted environments, `openMode: "url"` is the recommended default for shared configuration. Users who want automatic browser opening can opt into `"browser"` locally.

## Server Lifecycle

First version:

- Start a server when the Stop hook needs the viewer or when `scripts/session-viewer.js` is run manually.
- Bind to `127.0.0.1` by default.
- If the configured port is busy, probe whether it is already an Evo Bypass viewer by calling a health endpoint.
- If it is already the viewer for the same root, reuse it.
- If the port is occupied by something else, try the next available port in a small range.
- Print the final URL in all cases where a viewer is available.

Add `GET /api/health`:

```json
{
  "name": "evo-bypass-session-viewer",
  "root": "/Users/sakki/Documents/evo-bypass",
  "version": "0.1.0"
}
```

Longer-running daemon behavior is explicitly out of scope for the first version. If it becomes necessary, it can build on the same server module.

## Security And Safety

- Bind to localhost by default.
- Validate `session_id` using the existing safe path segment rule.
- Never serve files outside the project root or the packaged UI directory.
- Treat session artifacts as local sensitive data because prompts and evidence snippets may contain project context.
- Preserve existing redaction at collection time.
- Do not expose write endpoints in the first version.
- Do not auto-open the browser unless explicitly configured.

## Error Handling

- Missing `metadata.json`: include the session with a degraded summary if other files exist.
- Missing `events.jsonl`: return an empty event list.
- Malformed event lines: skip them and return `malformedEventCount`.
- Missing `suggestions.json`: return an empty suggestions object with a clear summary.
- Invalid config: fall back to defaults and keep review working.
- Viewer startup failure: keep Stop hook output valid and include a short non-blocking note.

## Testing

Unit tests:

- config defaults and invalid config fallback
- session store list/detail parsing
- malformed JSONL handling
- safe `session_id` rejection
- Stop hook report behavior for `off`, `url`, and no-suggestion sessions

Integration tests:

- start viewer server against a temporary `.bypass/sessions` tree
- fetch `/api/sessions`
- fetch `/api/sessions/:session_id`
- verify unknown API route returns JSON 404
- verify UI routes return HTML

Manual verification:

- create a session with suggestions
- set `viewer.openMode` to `url`
- run `scripts/review-session.js` with Codex-style stdin
- confirm Stop output includes the detail URL
- open the URL and confirm list/detail data matches artifacts

## Out Of Scope

- Applying suggestions directly from the web UI
- Authentication beyond localhost binding
- A persistent daemon installer
- Remote access
- Editing session artifacts from the UI
- Replacing the existing Markdown suggestion report
