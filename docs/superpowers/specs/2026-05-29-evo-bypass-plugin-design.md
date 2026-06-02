# Evo Bypass Plugin Design

## Summary

`evo-bypass` is a cross-runtime agent hook package for Claude Code and Codex that observes a main agent's task execution from the side, identifies knowledge that may need to be added or changed, and reports suggested updates at the end of the task. It does not directly update the local knowledge base during review. Knowledge updates require explicit user confirmation before any file is changed.

The design follows the same broad pattern as Claude's `security-guidance` plugin: hook into the session lifecycle, record useful context while the agent works, run a separate review pass at task completion, then feed results back into the main agent. Claude uses plugin hooks and `asyncRewake`; Codex uses the user's Codex hooks configuration with the same shared collector and reviewer scripts.

## Goals

- Capture structured evidence from the main agent's behavior without interrupting the main task.
- Detect knowledge-worthy changes from the current session, including new project conventions, user preferences, verified tool behavior, failure patterns, environment facts, and external facts.
- Present concise, evidence-backed suggestions to the main agent at task completion.
- Require the main agent to ask the user for confirmation before applying suggested knowledge updates.
- Keep all event logs, suggestions, approvals, and applied patches auditable per session.

## Non-Goals

- The plugin will not autonomously edit the knowledge base from the `Stop` hook.
- The plugin will not block the main agent's tool use.
- The plugin will not act as a second decision-maker during implementation.
- The first version will not run a persistent daemon or continuously stream advice back to the main agent.

## Recommended Architecture

Use the selected "Hook + local event store + reviewer" architecture.

```text
evo-bypass/
  .claude-plugin/
    plugin.json
  hooks/
    claude-hooks.json
    codex-hooks.json
  prompts/
    reviewer.md
  schemas/
    session-event.schema.json
    suggestion.schema.json
  scripts/
    collect-event.js
    review-session.js
    apply-approved-update.js
  docs/
    superpowers/
      specs/
        2026-05-29-evo-bypass-plugin-design.md
```

The hook layer records structured events. The reviewer layer runs once at task completion and produces suggestions. The updater layer is dormant unless the user explicitly confirms suggested updates.

## Runtime Support

The package has one shared core and thin runtime adapters.

- Claude Code: installed as a Claude plugin with `.claude-plugin/plugin.json` and `hooks/claude-hooks.json`.
- Codex: installed by merging `hooks/codex-hooks.json` into `~/.codex/hooks.json` or the Codex project hook configuration when project-level hooks are available.

Both runtimes call the same scripts:

- `node scripts/collect-event.js` for `UserPromptSubmit` and `PostToolUse`
- `node scripts/review-session.js <session-id>` for `Stop`
- `node scripts/apply-approved-update.js <session-id> <suggestion-ids> <approval text>` after user confirmation

The collector must normalize both Claude-style and Codex-style hook payload fields into the stable event schema. Codex-specific hook names such as `SessionStart` and `PermissionRequest` may be collected as supplemental events, but v1 only requires `UserPromptSubmit`, `PostToolUse`, and `Stop` for the knowledge review flow.

## Hook Lifecycle

### UserPromptSubmit

Creates a new bypass session record.

Captured fields:

- session id
- timestamp
- working directory
- original user prompt
- plugin version
- current git branch and short status when available
- configured knowledge base targets, if any

The prompt should be stored as session evidence but not treated as a knowledge update by itself.

### PostToolUse

Appends one event per observed tool invocation.

Captured fields:

- event id
- timestamp
- tool name
- operation summary
- relevant file paths
- command or API name when applicable
- exit status when applicable
- concise output summary
- detected signals, such as test failure, build failure, dependency install, config discovery, external documentation lookup, or user preference evidence

The collector should avoid storing large raw command output. It should prefer summaries, file paths, exit codes, and short evidence snippets.

### Stop

Runs `scripts/review-session.js` against the current session directory.

The reviewer reads:

- session events
- git diff summary
- knowledge base index or configured target files
- reviewer prompt

It writes `suggestions.json` and returns a short report through `asyncRewake`. The report tells the main agent to ask the user whether to apply suggested knowledge updates.

## Session Storage

Session artifacts live under:

```text
.bypass/sessions/<session-id>/
  events.jsonl
  metadata.json
  suggestions.json
  approval.json
  applied.patch
  reviewer.log
```

`events.jsonl` is append-only. `suggestions.json` is generated at `Stop`. `approval.json` exists only after explicit confirmation. `applied.patch` records the actual knowledge base changes.

## Event Schema

Each event is a small JSON object:

```json
{
  "id": "evt_001",
  "session_id": "session-id",
  "timestamp": "2026-05-29T09:00:00.000Z",
  "hook": "SessionStart | UserPromptSubmit | PostToolUse | PermissionRequest | Stop",
  "tool": "Bash | Read | Edit | WebFetch | Skill | Other",
  "summary": "Concise description of what happened",
  "paths": ["optional/file/path.ts"],
  "status": "success | failure | unknown",
  "signals": ["test_failure", "project_convention", "user_preference"],
  "evidence": ["Short snippet or observation"]
}
```

The collector may include additional tool-specific fields, but downstream reviewer logic must only depend on this stable core schema. `SessionStart` and `PermissionRequest` are primarily for Codex support and are supplemental evidence; the required review path still depends on `UserPromptSubmit`, `PostToolUse`, and `Stop`.

## Suggestion Schema

Reviewer output uses this structure:

```json
{
  "session_id": "session-id",
  "summary": "Brief explanation of whether knowledge updates are suggested",
  "suggestions": [
    {
      "id": "sug_001",
      "kind": "user_preference | project_convention | tool_learning | failure_pattern | environment_fact | external_fact",
      "confidence": "low | medium | high",
      "target": "knowledge file or section",
      "evidence": ["evt_002", "evt_006"],
      "proposed_text": "Text proposed for the knowledge base",
      "rationale": "Why this should be remembered"
    }
  ]
}
```

Suggestions should be conservative. Low-confidence suggestions should usually be reported as observations rather than proposed writes.

## Reviewer Prompt Requirements

The reviewer prompt must instruct the bypass agent to:

- identify only durable, reusable knowledge
- distinguish confirmed facts from inference
- include evidence for every suggestion
- avoid saving secrets, credentials, tokens, private personal data, or large raw outputs
- prefer updating existing knowledge entries over creating duplicates
- produce no suggestions when the session did not create reusable knowledge
- return machine-readable JSON plus a concise human-readable report

## Confirmation And Apply Flow

At task completion, the plugin rewakes the main agent with a report like:

```text
Knowledge Update Suggestions

I found 2 possible knowledge updates from this task.
Ask the user whether they want to apply them before running the updater.
```

The main agent then asks the user for confirmation. Only after an explicit yes should `scripts/apply-approved-update.js` run.

The updater requires:

- session id
- suggestion ids approved by the user
- target knowledge base path
- approval text or structured approval file

If approval is missing, stale, or ambiguous, the updater exits without changing files.

## Knowledge Targets

The plugin should support automatic knowledge routing and configurable override targets. Examples:

- repository-local agent notes
- a personal Codex or Claude knowledge file
- skill-specific notes
- project conventions documents

The reviewer first uses path evidence to route suggestions to the nearest relevant `AGENTS.md`. If a matching directory-level file exists, it should be preferred. If no scoped file exists, the reviewer may propose creating one. If no path evidence is available, the repository root `AGENTS.md` is the fallback. `.bypass/config.json` may still provide an explicit repository-local `knowledgeTarget`; unsafe targets are ignored and automatic routing is used instead.

## Error Handling

- If event collection fails, the hook should log the failure and allow the main agent to continue.
- If review fails, the `Stop` hook should return a short failure notice through `asyncRewake` with the session path for debugging.
- If the knowledge base target is missing, suggestions should still be generated but not applied.
- If approval is absent, the updater must refuse to write.
- If applying a patch fails, the updater should write an error report and leave existing knowledge files unchanged.

## Privacy And Security

The plugin is intentionally conservative because it observes agent behavior.

- Store summaries by default, not complete outputs.
- Redact obvious secret patterns before writing events.
- Do not record environment variable values unless explicitly configured.
- Do not persist full external documents.
- Include an allowlist or ignore list for paths that should never be logged.

## Test Plan

Unit-level tests:

- `collect-event.js` creates valid `metadata.json` for `UserPromptSubmit`.
- `collect-event.js` appends valid JSONL events for `PostToolUse`.
- collector redacts obvious secrets from evidence snippets.
- `review-session.js` turns a mock event log into valid `suggestions.json`.
- reviewer emits no suggestions for sessions with no durable knowledge.
- `apply-approved-update.js` refuses to write without approval.
- `apply-approved-update.js` writes only approved suggestion ids.

Integration-level tests:

- simulate a full session: prompt event, tool events, stop review, user approval, apply update.
- verify all artifacts are written under `.bypass/sessions/<session-id>/`.
- verify failed review does not block or modify the main task.

## Implementation Notes

- Hook payload adapters should tolerate missing fields and normalize available Claude and Codex hook input into the stable event schema.
- The v1 reviewer should combine deterministic prefiltering with `prompts/reviewer.md`. Deterministic logic finds candidate signals and redacts sensitive values; the reviewer prompt decides whether those candidates are durable knowledge.
- A future version may replace the reviewer prompt with a dedicated subagent or model call if the runtime supports it cleanly, but the event schema and suggestion schema should remain stable.
