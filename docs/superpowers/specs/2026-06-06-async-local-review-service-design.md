# Async Local Review Service Design

## Summary

Evo Bypass should move session review out of the `Stop` hook and into a session-scoped local service. Hooks stay lightweight: `SessionStart` ensures the service is available, lifecycle hooks collect compact evidence, and `Stop` only enqueues a review job when the service health check is good.

The local service owns asynchronous review, job state, notification, and Web-based approval. It calls the same local agent runtime that produced the session: Codex sessions are reviewed with `codex exec`, and Claude Code sessions are reviewed with `claude -p`. The service does not use an OpenAI-compatible provider.

The reviewer agent only analyzes logs and returns structured JSON. It never writes files, applies knowledge updates, opens browsers, or asks the user questions. Evo Bypass validates the reviewer result, writes session artifacts, opens the browser only when knowledge updates need confirmation, and applies approved edited text through a backend endpoint.

The high-fidelity UI direction for this feature is captured in:

```text
prototype/async-review-service/index.html
```

Future implementation should reuse that Web UI direction: service health on the left, review job and evidence in the center, editable approval actions on the right.

## Goals

- Keep `Stop` hook latency low by removing inline reviewer work.
- Start the local service from `SessionStart` only when it is not already healthy.
- Enqueue background review jobs from `Stop` only when the service health endpoint is healthy.
- Skip review enqueue when the service is unhealthy rather than attempting late recovery at `Stop`.
- Use local agent CLIs as the reviewer engine: `codex exec` for Codex sessions, `claude -p` for Claude Code sessions.
- Avoid OpenAI-compatible provider configuration in this architecture.
- Preserve the advisory-first safety model: no knowledge file is changed without explicit user approval.
- Let users edit proposed knowledge text in the Web UI before applying.
- Automatically open the browser only when `update_knowledge` actions exist.
- Keep the existing `.bypass/sessions/<session-id>/` artifact model as the first version's source of truth.

## Non-Goals

- Do not introduce SQLite in the first implementation.
- Do not keep a permanent long-running daemon independent of agent sessions.
- Do not run a fallback rules reviewer when the CLI reviewer fails.
- Do not make `Stop` hook start or repair the service.
- Do not automatically merge, rewrite, supersede, or archive existing knowledge entries in the first version.
- Do not inject approved knowledge into future prompts as part of this change.

## Architecture

Use a session-scoped on-demand service:

```text
SessionStart hook
  -> collect event
  -> GET /api/health
  -> healthy: return
  -> unhealthy or not listening: detached start evo-bypassd
  -> return quickly

UserPromptSubmit / PostToolUse hooks
  -> collect compact session evidence

Stop hook
  -> GET /api/health
  -> healthy: POST /api/jobs
  -> unhealthy: write stop-hook log and skip enqueue
  -> return quickly

evo-bypassd
  -> HTTP API
  -> job store
  -> worker loop
  -> reviewer runner
  -> notification opener
  -> approval/apply service
  -> viewer static UI
```

`Stop` must not start the service. If the service is unhealthy by task end, the session review is skipped because the service may have missed session lifecycle evidence or may be in an invalid state. This is safer than attempting late startup and generating a misleading retrospective from incomplete logs.

## Components

### Hook Client

Small shared client used by `SessionStart` and `Stop`.

Responsibilities:

- Read local service URL from `.bypass/service/service-url` or default config.
- Call `GET /api/health` with a short timeout.
- Start service from `SessionStart` when health fails.
- Enqueue job from `Stop` only when health succeeds.
- Log failures to `.bypass/stop-hook.log` or `.bypass/service/service.log`.

The hook client should never throw in a way that blocks the main agent session.

### Local Service

`evo-bypassd` is a local HTTP service and worker process. It is started on demand by `SessionStart` and may exit after an idle timeout, for example 20 minutes without jobs or API requests.

Responsibilities:

- Serve health and session APIs.
- Serve the Web UI.
- Accept review jobs.
- Claim queued jobs.
- Invoke the runtime reviewer CLI.
- Validate reviewer output.
- Write retrospective artifacts.
- Open the browser when knowledge updates require approval.
- Apply edited approved actions through a backend endpoint.

### Job Store

Use file-backed jobs for the first version:

```text
.bypass/jobs/<job-id>.json
```

The job id should be stable for a session, such as `job_<session-id>`, so duplicate `Stop` fires do not create duplicate review work.

Job shape:

```json
{
  "id": "job_<session-id>",
  "session_id": "<session-id>",
  "runtime": "codex",
  "root": "/absolute/workspace/root",
  "status": "queued",
  "created_at": "2026-06-06T00:00:00.000Z",
  "started_at": "",
  "finished_at": "",
  "error": ""
}
```

Allowed statuses:

- `queued`
- `running`
- `succeeded`
- `failed`
- `skipped`

On service startup, stale `running` jobs whose lease has expired should reset to `queued`.

### Reviewer Runner

The reviewer runner loads session artifacts and candidate targets, then invokes the runtime-specific CLI.

Inputs:

```text
.bypass/sessions/<session-id>/metadata.json
.bypass/sessions/<session-id>/events.jsonl
candidate knowledge targets
target file previews
.bypass/config.json
```

Runtime selection:

- `runtime === "codex"` -> `codex exec`
- `runtime === "claude"` -> `claude -p`

The reviewer subprocess must run with an internal guard environment:

```text
EVO_BYPASS_INTERNAL=1
CLAUDE_CODE_ENTRYPOINT=evo-bypass-reviewer
```

All Evo Bypass hooks must skip collection when `EVO_BYPASS_INTERNAL=1`, preventing recursive capture of review sessions.

Codex invocation:

```bash
codex exec \
  --sandbox read-only \
  --skip-git-repo-check \
  --ephemeral \
  --ignore-rules \
  --output-last-message "$tmp_output" \
  -
```

Claude Code invocation:

```bash
claude -p \
  --output-format json \
  --append-system-prompt "$system_prompt"
```

The runner should use a bounded timeout, initially 180 seconds. It does not fall back to the rules reviewer. CLI missing, timeout, bad JSON, or invalid schema all mark the job as `failed`.

### Web UI

The Web UI should reuse the prototype direction:

```text
prototype/async-review-service/index.html
```

Primary layout:

- Left rail: service health, worker lease, reviewer CLI, workspace, navigation.
- Main area: review status metrics, job timeline, evidence snapshot, runner contract, generated artifacts.
- Right approval drawer: editable knowledge actions, target paths, confidence, apply button.

Core interaction:

1. Service opens browser only when review succeeds and at least one `update_knowledge` action exists.
2. User edits proposed text in a textarea.
3. User selects approved actions.
4. User clicks apply.
5. UI calls the backend apply endpoint.
6. Backend validates and writes approved knowledge entries.

Do not open the browser for smooth reviews, non-knowledge advisory findings, skipped jobs, or failed jobs.

## API

Recommended endpoints:

```text
GET  /api/health
POST /api/jobs
GET  /api/jobs/:jobId
GET  /api/sessions
GET  /api/sessions/:sessionId
POST /api/sessions/:sessionId/apply
```

`POST /api/jobs` accepts only small trusted identifiers:

```json
{
  "session_id": "<session-id>",
  "runtime": "codex",
  "root": "/absolute/workspace/root"
}
```

The service reads actual session facts from `.bypass/sessions`. It does not trust hook-supplied review content.

`POST /api/sessions/:sessionId/apply` accepts:

```json
{
  "approved_action_ids": ["finding_evt_19"],
  "approval_text": "Approved from Evo Bypass web UI",
  "edited_actions": {
    "finding_evt_19": {
      "proposed_text": "Project convention: use `node --test` for this repository."
    }
  }
}
```

The backend writes `approval.json`, applies the selected edited actions, and writes `applied.patch`.

## Reviewer Prompt

The reviewer prompt should be split into a fixed system prompt and a structured JSON payload.

System prompt:

```md
# Evo Bypass Async Session Reviewer

You are a background reviewer for Evo Bypass. Review one completed coding-agent session and produce a structured retrospective.

You are not the main agent. Do not continue the user's task. Do not write files. Do not run tools. Do not ask the user questions. Your only job is to analyze the provided session artifacts and return JSON.

Return JSON only.

## Output Shape

{
  "summary": "Brief summary of the session review.",
  "retrospective": {
    "outcome": "completed | partial | failed | unknown",
    "quality": "smooth | minor_issues | significant_issues",
    "findings": [
      {
        "id": "finding_short_stable_id",
        "category": "knowledge | skill | code | agent_usage | environment",
        "severity": "low | medium | high",
        "evidence": ["evt_id"],
        "diagnosis": "What happened and why it matters.",
        "recommendation": "What should happen next.",
        "action": {
          "type": "update_knowledge | create_skill | improve_code | adjust_agent_usage | fix_environment | no_action",
          "confidence": "low | medium | high",
          "target": "/absolute/path/from/candidates/AGENTS.md",
          "target_reason": "Why this target is appropriate.",
          "proposed_text": "Exact text to add or update.",
          "rationale": "Why this action is durable and useful."
        }
      }
    ]
  }
}

## Rules

Use only evidence ids present in `events`.

For `update_knowledge`, use only target paths present in `candidates`.

Recommend `update_knowledge` only for durable future-useful knowledge, such as:
- explicit project conventions
- user preferences relevant to future agent behavior
- verified tool or environment behavior
- repeated failure patterns
- stable setup or workflow facts

Do not create knowledge updates for:
- one-off implementation details
- temporary task state
- secrets, tokens, private personal data
- large raw command output
- uncertain guesses
- facts not grounded in evidence

Prefer no findings over weak findings.
```

Payload shape:

```json
{
  "session_id": "<session-id>",
  "runtime": "codex",
  "workspace_root": "/absolute/workspace/root",
  "metadata": {
    "original_prompt": "...",
    "created_at": "..."
  },
  "events": [
    {
      "id": "evt_1",
      "hook": "PostToolUse",
      "tool": "Bash",
      "summary": "Bash ran command: node --test",
      "paths": [],
      "status": "success",
      "signals": ["project_convention"],
      "evidence": ["short redacted snippet"]
    }
  ],
  "candidates": [
    {
      "event_id": "evt_1",
      "target": "/absolute/workspace/root/AGENTS.md",
      "target_reason": "Repository-level fallback",
      "target_exists": true,
      "relative_target": "AGENTS.md",
      "target_preview": "short preview"
    }
  ]
}
```

## Validation

The service validates reviewer output before writing artifacts:

- Response must be valid JSON.
- `retrospective.findings` must be an array.
- `outcome`, `quality`, `category`, `severity`, `action.type`, and `confidence` must be allowed enum values.
- Each finding must reference at least one existing event id.
- `update_knowledge` actions must include non-empty `target` and `proposed_text`.
- `update_knowledge.target` must exactly match one candidate target.
- Target must stay inside the workspace root.
- Secrets and very large raw outputs should be rejected or redacted if detected.

Invalid output fails the job. There is no rules fallback.

## Artifacts

Session artifacts remain compatible with the current storage model:

```text
.bypass/sessions/<session-id>/
  metadata.json
  events.jsonl
  retrospective.json
  retrospective.md
  approval.json
  applied.patch
  reviewer.log
```

Service artifacts:

```text
.bypass/service/
  service.pid
  service-url
  service.log

.bypass/jobs/
  <job-id>.json
```

`reviewer.log` should include:

- command kind (`codex exec` or `claude -p`)
- start and finish timestamps
- timeout value
- truncated stdout/stderr on failure
- schema validation errors

## Apply Flow

The first implementation can remain append-only.

Apply sequence:

1. UI posts selected action ids, approval text, and edited proposed text.
2. Backend loads `retrospective.json`.
3. Backend validates all selected ids exist.
4. Backend validates targets are safe and inside the workspace.
5. Backend writes `approval.json`.
6. Backend appends edited text to each target.
7. Backend writes `applied.patch`.

`approval.json` should include edited action overrides:

```json
{
  "approved_at": "2026-06-06T00:00:00.000Z",
  "approved_suggestion_ids": ["finding_evt_19"],
  "approval_text": "Approved from Evo Bypass web UI",
  "edited_actions": {
    "finding_evt_19": {
      "proposed_text": "Project convention: use `node --test` for this repository."
    }
  }
}
```

The apply service should use edited text when present and non-empty. It must not allow edited text to change the target path.

## Error Handling

- Service not healthy at `SessionStart`: attempt detached start, log failure, return.
- Service not healthy at `Stop`: skip enqueue, log only.
- Duplicate job enqueue: keep existing queued/running/succeeded job and return success.
- Incomplete session artifacts: mark job `skipped`.
- CLI missing: mark job `failed`.
- CLI timeout: mark job `failed`.
- Bad JSON: mark job `failed`.
- Invalid schema or unsafe target: mark job `failed`.
- Browser open failure: keep review succeeded, log notification error.
- Apply validation failure: return 400 and do not write approval or target files.

## Testing

Unit tests:

- service health client handles healthy, unhealthy, timeout.
- `SessionStart` starts service only when unhealthy.
- `Stop` enqueues only when healthy.
- `Stop` skips when unhealthy.
- job store creates, claims, completes, fails, and resets stale running jobs.
- reviewer runner maps runtime to the correct CLI command.
- reviewer runner sets `EVO_BYPASS_INTERNAL=1`.
- invalid reviewer JSON fails without fallback.
- validation rejects unknown evidence ids and unsafe targets.
- apply endpoint uses edited proposed text.
- apply endpoint rejects unknown action ids and target path changes.

Integration tests:

- enqueue a fake session and run worker with a stub CLI returning valid JSON.
- verify retrospective files are written.
- verify browser notifier is called only for `update_knowledge` actions.
- verify smooth review does not open browser.
- verify failed review does not open browser.

UI tests:

- session detail shows job status.
- editable knowledge actions render from retrospective findings.
- apply button posts edited text.
- mobile layout stacks without text overflow.

## Migration Notes

The current synchronous `scripts/review-session.js` should be split rather than deleted immediately:

- Keep core review artifact formatting and schema helpers.
- Move CLI reviewer orchestration into the service worker.
- Replace Stop hook command with an enqueue client.
- Keep legacy direct review command available for tests or manual debugging during migration.

The existing viewer can evolve into the service Web UI. The prototype should guide the new layout and interaction model, but production implementation should connect to real APIs rather than hard-coded sample data.
