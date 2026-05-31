# Session Viewer Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable local session viewer runtime that exposes Evo Bypass session artifacts through a read-only web UI after Stop hooks.

**Architecture:** Keep the reviewer and collector small, then add separate config, session-store, and viewer-server modules. The Stop hook reads normalized config after review, starts or reuses the viewer only when configured, and augments the existing report with the local URL without making viewer startup critical.

**Tech Stack:** Node.js ESM, built-in `fs`, `path`, `http`, `child_process`, `node:test`, existing `.bypass/sessions` JSON/JSONL artifacts, vanilla browser JavaScript.

---

## File Map

- Create `src/core/config.js`: repository config reader with normalized `knowledgeTarget` and `viewer` defaults.
- Create `src/viewer/session-store.js`: read-only parser for `.bypass/sessions` list and detail data.
- Create `src/viewer/server.js`: local HTTP server and API route handler.
- Create `scripts/session-viewer.js`: manual/Stop-hook CLI for starting the viewer.
- Modify `scripts/review-session.js`: consult config and include viewer URL when configured.
- Modify `prototype/session-reviewer/index.html`: replace embedded mock data with `/api` calls while keeping the current visual shell.
- Add `test/config.test.js`, `test/session-store.test.js`, `test/viewer-server.test.js`, `test/session-viewer-cli.test.js`; extend `test/review-session.test.js`.

---

### Task 1: Normalized Config Reader

**Files:**
- Create: `src/core/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: Write failing config tests**

Create `test/config.test.js` with tests for default config, valid viewer config, invalid JSON fallback, and unsafe `knowledgeTarget` fallback.

Run: `npm test -- test/config.test.js`
Expected: FAIL because `src/core/config.js` does not exist.

- [ ] **Step 2: Implement config reader**

Add `readBypassConfig({ root })` returning:

```js
{
  knowledgeTarget,
  viewer: {
    enabled: false,
    openMode: 'url',
    host: '127.0.0.1',
    port: 8765,
    openOnlyWhenSuggestions: true
  },
  configError: undefined
}
```

Rules:
- missing config uses defaults
- invalid JSON sets `configError` and uses defaults
- `viewer.openMode` accepts only `off`, `url`, `browser`
- `viewer.port` accepts integer `1..65535`
- `knowledgeTarget` must stay inside root, otherwise use `.bypass/knowledge.md`

- [ ] **Step 3: Verify config tests pass**

Run: `npm test -- test/config.test.js`
Expected: PASS.

---

### Task 2: Read Session Artifacts

**Files:**
- Create: `src/viewer/session-store.js`
- Test: `test/session-store.test.js`

- [ ] **Step 1: Write failing session store tests**

Create tests that build a temporary `.bypass/sessions/<id>/` tree with `metadata.json`, `events.jsonl`, `suggestions.json`, and `reviewer.log`, then assert:
- `listSessions({ root })` returns compact summaries sorted newest first
- `getSessionDetail({ root, sessionId })` returns full metadata, events, suggestions, reviewer log, and malformed count
- malformed JSONL lines are skipped
- unsafe `sessionId` is rejected
- missing optional files degrade to empty structures

Run: `npm test -- test/session-store.test.js`
Expected: FAIL because `src/viewer/session-store.js` does not exist.

- [ ] **Step 2: Implement session store**

Add:

```js
export async function listSessions({ root = process.cwd() }) {}
export async function getSessionDetail({ root = process.cwd(), sessionId }) {}
```

Use existing `resolveSessionPaths()` for detail paths and the same safe path rule for IDs. Summaries include `session_id`, `created_at`, `runtime`, `event_count`, `failure_count`, `signals`, `suggestion_count`, `has_suggestion_report`, `working_directory`, and `prompt_preview`.

- [ ] **Step 3: Verify session store tests pass**

Run: `npm test -- test/session-store.test.js`
Expected: PASS.

---

### Task 3: HTTP Viewer Server And CLI

**Files:**
- Create: `src/viewer/server.js`
- Create: `scripts/session-viewer.js`
- Test: `test/viewer-server.test.js`
- Test: `test/session-viewer-cli.test.js`

- [ ] **Step 1: Write failing server tests**

Create tests that start the server on port `0` with a temp root and assert:
- `GET /api/health` returns viewer name, root, and package version
- `GET /api/sessions` returns JSON summaries
- `GET /api/sessions/:id` returns JSON details
- unknown `/api/nope` returns JSON 404
- `/sessions` and `/sessions/<id>` return HTML

Run: `npm test -- test/viewer-server.test.js`
Expected: FAIL because server module does not exist.

- [ ] **Step 2: Implement server module**

Add:

```js
export async function createViewerServer({ root, host = '127.0.0.1', port = 8765 } = {}) {}
export async function startViewerServer(options) {}
export function viewerUrl({ host, port, sessionId }) {}
```

Serve `prototype/session-reviewer/index.html` for UI routes. Return JSON with correct content type for API routes.

- [ ] **Step 3: Write and implement CLI smoke behavior**

Create `test/session-viewer-cli.test.js` that runs:

```bash
node scripts/session-viewer.js --root <tmp> --port 0 --once
```

Expected stdout contains a URL and process exits after a successful health check.

Implement `scripts/session-viewer.js` with `--root`, `--host`, `--port`, `--session`, `--openMode`, and `--once`.

- [ ] **Step 4: Verify server and CLI tests pass**

Run: `npm test -- test/viewer-server.test.js test/session-viewer-cli.test.js`
Expected: PASS.

---

### Task 4: Stop Hook Integration

**Files:**
- Modify: `scripts/review-session.js`
- Test: `test/review-session.test.js`

- [ ] **Step 1: Write failing Stop hook tests**

Extend `test/review-session.test.js` with Codex-style CLI tests:
- viewer disabled by default keeps current output
- viewer enabled with suggestions includes `/sessions/<session-id>` URL
- viewer enabled with `openOnlyWhenSuggestions: true` and no suggestions does not include a URL
- viewer startup failure still returns valid Codex JSON with a non-blocking note

Run: `npm test -- test/review-session.test.js`
Expected: FAIL because review script does not start or report viewer URLs.

- [ ] **Step 2: Implement integration**

In `scripts/review-session.js`:
- read normalized config after `reviewSession`
- decide whether viewer should start
- start viewer with configured host/port/openMode
- append URL text to `formatReport`
- catch viewer errors and keep output valid

- [ ] **Step 3: Verify review tests pass**

Run: `npm test -- test/review-session.test.js`
Expected: PASS.

---

### Task 5: Frontend API Wiring

**Files:**
- Modify: `prototype/session-reviewer/index.html`
- Test: covered by `test/viewer-server.test.js` UI-route assertions and manual screenshot

- [ ] **Step 1: Replace mock data with API calls**

Update browser code to:
- fetch `/api/sessions` on list route
- fetch `/api/sessions/:session_id` on detail route
- show loading and empty states
- keep the current layout, filters, metrics, timeline, selected-event inspector, and suggestions panel

- [ ] **Step 2: Verify UI routes still serve**

Run: `npm test -- test/viewer-server.test.js`
Expected: PASS.

- [ ] **Step 3: Manual screenshot check**

Start the viewer against the repo root, open `/sessions`, and capture a Playwright screenshot.

Expected: list and detail pages render with real `.bypass/sessions` data.

---

### Task 6: Full Verification

**Files:**
- All touched files

- [ ] **Step 1: Run full tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Inspect git diff**

Run: `git diff --stat`
Expected: only planned implementation files plus existing prototype UI are changed.

- [ ] **Step 3: Commit implementation**

Run:

```bash
git add src/core/config.js src/viewer/session-store.js src/viewer/server.js scripts/session-viewer.js scripts/review-session.js prototype/session-reviewer/index.html test/config.test.js test/session-store.test.js test/viewer-server.test.js test/session-viewer-cli.test.js test/review-session.test.js docs/superpowers/plans/2026-05-31-session-viewer-runtime.md
git commit -m "feat: add session viewer runtime"
```
