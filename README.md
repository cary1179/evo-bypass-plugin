# Evo Bypass

Evo Bypass is an advisory-first hook package for Claude Code and Codex. It records structured session events, reviews them at task completion, and suggests local knowledge updates.

It never updates the knowledge base from the review hook. The main agent must ask the user for confirmation before running `scripts/apply-approved-update.js`.

## Flow

1. `UserPromptSubmit` creates `.bypass/sessions/<session-id>/metadata.json`.
2. `PostToolUse` appends redacted events to `events.jsonl`.
3. `Stop` runs the reviewer and writes `suggestions.json`.
4. The async rewake report asks the main agent to request user approval.
5. After approval, run:

```bash
node scripts/apply-approved-update.js <session-id> <sug_1,sug_2> "user approved these updates"
```

By default, approved updates append to `.bypass/knowledge.md`.

## Codex Installation

Set `EVO_BYPASS_HOME` to this package path before using the hook files:

```bash
export EVO_BYPASS_HOME=/absolute/path/to/evo-bypass
```

Merge `hooks/codex-hooks.json` into `~/.codex/hooks.json`. Existing hooks should stay in place; add Evo Bypass as an additional command hook under the same lifecycle events.

Codex supports `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop` hook entries in the local hooks file. Evo Bypass uses the same collector and reviewer scripts as Claude.

## Claude Plugin Installation

For Claude plugin installation, ensure `EVO_BYPASS_HOME` is available to hook commands, or replace `$EVO_BYPASS_HOME` in `hooks/claude-hooks.json` with the absolute path to this package before installing.

## Development

Run the full test suite:

```bash
npm test
```
