# Evo Bypass

![Evo Bypass hero banner](docs/assets/readme/evo-bypass-hero.png)

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

![Evo Bypass storage blueprint](docs/assets/readme/storage-blueprint.png)

## How It Works

![From noisy session to durable memory](docs/assets/readme/noisy-session-to-memory.png)

1. `UserPromptSubmit` creates session metadata.
2. `PostToolUse` and `PostToolUseFailure` append redacted tool events.
3. `Stop` runs the reviewer and writes `suggestions.json`.
4. If the reviewer finds durable knowledge, it writes a Markdown report under the user-level bypass directory.
5. The reviewer tells the main agent to read that report and ask the user whether to apply specific suggestions.
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

![Detected knowledge types](docs/assets/readme/detected-knowledge-types.png)

## Stop Hook Reports

![Codex stop hook decision](docs/assets/readme/stop-hook-decision.png)

When a completed session has possible knowledge updates, Evo Bypass writes the detailed review report to:

```text
~/.bypass/suggestion/<session-id>.md
```

The Stop hook response only includes the path to that Markdown file, so the hook output stays short while the main agent can still inspect the full details.

For Codex, the Stop hook emits valid JSON. If suggestions exist, `continue` is `false` so the main agent does not silently finish before telling the user about the report. If there are no suggestions, no Markdown report is written and `continue` is `true`.

No-suggestion sessions return:

```text
本次任务无待更新知识。
```

## Install For Codex

From the Evo Bypass repository root, run:

```bash
pnpm run install:codex
```

The installer writes Evo Bypass hooks into:

```text
~/.codex/hooks.json
```

It preserves existing hooks and skips Evo Bypass commands that are already installed, so it is safe to run more than once.

For manual installation, merge `hooks/codex-hooks.json` into `~/.codex/hooks.json`.

Keep any existing hooks. Add Evo Bypass as an additional command under the same lifecycle events instead of replacing other tools. The included Codex hook file covers:

- `SessionStart`
- `UserPromptSubmit`
- `PostToolUse`
- `Stop`

The one-command installer replaces `$EVO_BYPASS_HOME` in hook commands with the absolute path of the current package checkout. If you install manually, make the same replacement yourself or export `EVO_BYPASS_HOME` in the hook environment.

## Install For Claude Code

From the Evo Bypass repository root, run:

```bash
pnpm run install:claude
```

The installer writes Evo Bypass hooks into:

```text
~/.claude/settings.json
```

It preserves existing hooks and skips Evo Bypass commands that are already installed, so it is safe to run more than once.

For manual installation, use `.claude-plugin/plugin.json` as the plugin manifest and `hooks/claude-hooks.json` as the hook configuration. The Claude config covers:

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

![No silent memory mutation](docs/assets/readme/no-silent-memory-mutation.png)

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
