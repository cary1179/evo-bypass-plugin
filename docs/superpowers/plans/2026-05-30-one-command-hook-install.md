# One Command Hook Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-command installers for Claude Code and Codex hook configuration from the project root.

**Architecture:** Add a Node ESM installer CLI that reads the existing hook templates, replaces `$EVO_BYPASS_HOME` with the current package path, and merges hook entries into the user config without removing existing hooks or duplicating Evo Bypass commands. Package scripts call the installer with the target runtime.

**Tech Stack:** Node.js >=20, built-in `fs`, `os`, `path`, `url`, and `node:test`.

---

### Task 1: Installer Merge Logic

**Files:**
- Create: `scripts/install-hooks.js`
- Test: `test/install-hooks.test.js`

- [x] **Step 1: Write tests for idempotent merge behavior**

Create tests that use temporary config paths via `EVO_BYPASS_CODEX_HOOKS_PATH` and `EVO_BYPASS_CLAUDE_HOOKS_PATH`, then assert that existing hook commands remain, Evo Bypass commands are added once, and `$EVO_BYPASS_HOME` is replaced by the repository path.

- [x] **Step 2: Implement installer CLI**

Implement `installHooks({ runtime, repoRoot, targetPath })`, `mergeHookConfig(existing, incoming)`, command replacement, JSON read/write, directory creation, and CLI argument parsing for `--runtime claude|codex`.

- [x] **Step 3: Verify tests**

Run `npm test` and confirm installer tests pass with the existing suite.

### Task 2: Package Scripts And Docs

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `test/plugin-files.test.js`

- [x] **Step 1: Add package scripts**

Add `install:claude` and `install:codex` scripts that call `node scripts/install-hooks.js --runtime claude` and `node scripts/install-hooks.js --runtime codex`.

- [x] **Step 2: Document one-command installation**

Update README installation sections to lead with `pnpm run install:claude` and `pnpm run install:codex`, while keeping manual merge notes for review and troubleshooting.

- [x] **Step 3: Verify script declarations**

Extend plugin file tests to assert both package scripts exist.

### Self-Review

- Spec coverage: The plan covers one-command installs for both runtimes, idempotent merging, path replacement, docs, and tests.
- Placeholder scan: No deferred implementation placeholders remain.
- Type consistency: Runtime names are consistently `claude` and `codex`.
