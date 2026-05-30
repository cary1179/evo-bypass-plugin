# Evo Bypass

Evo Bypass is an advisory-first knowledge update helper for Claude Code and Codex.

It runs beside the main agent through lifecycle hooks, records a compact log of what happened during a task, reviews that log when the task ends, and suggests local knowledge updates that may be useful for future work.

It does **not** update knowledge automatically. The main agent must show the suggestions and ask the user before running the updater.

## What It Captures

Evo Bypass stores session artifacts under the current workspace:

```text
.bypass/sessions/<session-id>/
  metadata.json
  events.jsonl
  suggestions.json
  approval.json
  applied.patch
  reviewer.log
```

The collector records summaries, paths, exit status, redacted evidence snippets, and signals such as test failures, dependency changes, and project conventions. It avoids storing large raw outputs and redacts common secret patterns before writing events.

## How It Works

1. `UserPromptSubmit` creates session metadata.
2. `PostToolUse` and `PostToolUseFailure` append redacted tool events.
3. `Stop` runs the reviewer and writes `suggestions.json`.
4. The reviewer reports possible knowledge updates back to the main agent.
5. The main agent asks the user whether to apply specific suggestions.
6. Only after approval, `scripts/apply-approved-update.js` writes approved entries.

By default, approved updates append to:

```text
.bypass/knowledge.md
```

## Suggestion Types

Reviewer suggestions use these kinds:

- `user_preference`
- `project_convention`
- `tool_learning`
- `failure_pattern`
- `environment_fact`
- `external_fact`

Each suggestion includes evidence ids, confidence, a target knowledge file, proposed text, and rationale.

## Install For Codex

Set `EVO_BYPASS_HOME` to the absolute path of this package:

```bash
export EVO_BYPASS_HOME=/absolute/path/to/evo-bypass
```

Merge `hooks/codex-hooks.json` into `~/.codex/hooks.json`.

Keep any existing hooks. Add Evo Bypass as an additional command under the same lifecycle events instead of replacing other tools. The included Codex hook file covers:

- `SessionStart`
- `UserPromptSubmit`
- `PostToolUse`
- `Stop`

If your hook environment does not inherit shell exports, replace `$EVO_BYPASS_HOME` in the hook commands with the absolute package path.

## Install For Claude Code

Set `EVO_BYPASS_HOME` before using the Claude hook config:

```bash
export EVO_BYPASS_HOME=/absolute/path/to/evo-bypass
```

Use `.claude-plugin/plugin.json` as the plugin manifest and `hooks/claude-hooks.json` as the hook configuration. The Claude config covers:

- `UserPromptSubmit`
- `PostToolUse`
- `PostToolUseFailure`
- `Stop`

The Claude `Stop` hook uses `asyncRewake` so the reviewer can send the knowledge update report back to the main agent after the task completes.

## Applying Suggestions

After a task ends, inspect:

```text
.bypass/sessions/<session-id>/suggestions.json
```

If the user approves one or more suggestion ids, run:

```bash
node scripts/apply-approved-update.js <session-id> <sug_1,sug_2> "user approved these updates"
```

The updater refuses to write unless approval is explicit. It also rejects unknown suggestion ids, duplicate approvals, unsafe target paths, malformed suggestions, and missing approval text.

## Configure Knowledge Target

By default, updates go to `.bypass/knowledge.md`.

To choose a repository-local target, create:

```json
{
  "knowledgeTarget": "docs/agent-knowledge.md"
}
```

at:

```text
.bypass/config.json
```

Targets must stay inside the workspace. Unsafe paths fall back to `.bypass/knowledge.md`.

## Development

Run the full test suite:

```bash
npm test
```
