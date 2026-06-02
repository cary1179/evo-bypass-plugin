# Evo Bypass
![Evo Bypass hero banner](./docs/assets/readme/evo-bypass-hero.png)

![license](https://img.shields.io/badge/license-MIT-blue.svg) ![tests](https://img.shields.io/badge/tests-node%20--test-2ea44f)

Evo Bypass is an advisory-first knowledge update helper for Claude Code and Codex.

It runs beside the main agent through lifecycle hooks, records a compact log of what happened during a task, reviews that log when the task ends, and recommends follow-up actions that may be useful for future work.

It does **not** update knowledge automatically. The main agent must show the retrospective and ask the user before running the updater.
## What It Captures
Evo Bypass stores session artifacts under the current workspace:

```text
.bypass/sessions/<session-id>/
  metadata.json          – session start time, workspace root, agent type
  events.jsonl           – redacted tool-use events collected during the task
  retrospective.json     – reviewer output: task status, findings, and actions
  retrospective.md       – readable task retrospective report
  approval.json          – user-approved update_knowledge action ids and approval message
  applied.patch          – diff of changes written by the updater
  reviewer.log           – full reviewer run log for debugging
```

The collector records summaries, paths, exit status, redacted evidence snippets, and signals such as test failures, dependency changes, and project conventions. It avoids storing large raw outputs and redacts common secret patterns before writing events.

![Evo Bypass storage blueprint](./docs/assets/readme/storage-blueprint.png)
## How It Works
![From noisy session to durable memory](./docs/assets/readme/noisy-session-to-memory.png)

1. `UserPromptSubmit` creates session metadata.
  
2. `PostToolUse` and `PostToolUseFailure` append redacted tool events.
  
3. `Stop` runs the reviewer and writes `retrospective.json`.
  
4. If the reviewer finds durable knowledge, it writes a Markdown report under the user-level bypass directory.
  
5. The reviewer tells the main agent to read that report and ask the user whether to apply specific `update_knowledge` actions.
  
6. Only after approval, `scripts/apply-approved-update.js` writes approved entries.
  

By default, approved updates are routed to the most relevant `AGENTS.md`.
## Task Retrospectives

Every Stop hook writes a task retrospective. The retrospective explains whether the task completed smoothly, which concrete failures or workflow issues appeared, and what action is recommended. Knowledge updates are represented as `update_knowledge` actions inside retrospective findings. Other actions, such as `create_skill`, `improve_code`, or `adjust_agent_usage`, are advisory and are not applied automatically.
## Knowledge Update Kinds
Legacy knowledge suggestions use these kinds:

- `user_preference`
  
- `project_convention`
  
- `tool_learning`
  
- `failure_pattern`
  
- `environment_fact`
  
- `external_fact`
  

Each `update_knowledge` action includes evidence ids, confidence, a target knowledge file, proposed text, and rationale.

![Detected knowledge types](./docs/assets/readme/detected-knowledge-types.png)
## Stop Hook Reports
![Codex stop hook decision](./docs/assets/readme/stop-hook-decision.png)

When a completed session has possible knowledge updates, Evo Bypass writes the detailed review report to:

```text
~/.bypass/retrospective/<session-id>.md
```

The Stop hook response only includes the path to that Markdown file, so the hook output stays short while the main agent can still inspect the full details.

For Codex, the Stop hook emits valid JSON. If `update_knowledge` actions exist, `continue` is `false` so the main agent does not silently finish before telling the user about the report. If there are no knowledge updates, `continue` is `true`.

No-update sessions return:

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
## Applying Approved Updates
After a task ends, inspect:

```text
.bypass/sessions/<session-id>/retrospective.json
```

If the user approves one or more `update_knowledge` action ids, run:

```bash
node scripts/apply-approved-update.js <session-id> <action_1,action_2> "user approved these updates"
```

The updater refuses to write unless approval is explicit. It also rejects unknown action ids, duplicate approvals, unsafe target paths, malformed retrospective findings, and missing approval text.

Legacy sessions may still have `suggestions.json`; the apply command supports that fallback for old sessions.

![No silent memory mutation](./docs/assets/readme/no-silent-memory-mutation.png)
## Configure Knowledge Routing
By default, Evo Bypass routes knowledge updates to `AGENTS.md` files. If an event includes a scoped path, the reviewer prefers the nearest existing directory-level `AGENTS.md`; if none exists, it may recommend creating a scoped `AGENTS.md` for that directory. If no scoped path is available, it uses the repository root `AGENTS.md`.

To force a repository-local target, create:

```json
{
  "knowledgeTarget": "docs/agent-knowledge.md"
}
```

at:

```text
.bypass/config.json
```

Targets must stay inside the workspace. Unsafe paths are ignored and the automatic `AGENTS.md` router is used instead.
## Configure AI Review
By default, Evo Bypass uses the local rules reviewer. To enable an OpenAI-compatible AI reviewer, add `reviewer.provider` to `.bypass/config.json`:

```json
{
  "reviewer": {
    "mode": "ai",
    "fallback": "rules",
    "timeoutMs": 120000,
    "provider": {
      "type": "openai-compatible",
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "EVO_BYPASS_AI_API_KEY",
      "model": "gpt-4.1-mini"
    }
  }
}
```

`apiKey` is also supported inside `provider`, but `apiKeyEnv` is recommended so secrets do not live in the repository. If the AI request fails and `fallback` is `rules`, Evo Bypass falls back to the deterministic rules reviewer.
