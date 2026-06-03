# Session Retrospective Review Design

## Summary

Evo Bypass should evolve from a knowledge-update reviewer into a full task retrospective reviewer. The Stop hook will still run once at the end of each agent task, but its main output will become a structured retrospective that explains what happened, which failures or weaknesses appeared, and what kind of improvement is appropriate.

Knowledge updates are part of the retrospective rather than a separate top-level concept. A knowledge update is represented as a finding whose action is `update_knowledge`. Other findings may recommend creating a skill, improving project code, adjusting agent usage, fixing environment setup, or taking no action.

The system remains advisory-first. It may write reports and proposed actions automatically, but it must not update knowledge files, create skills, or change project code without explicit user approval.

## Goals

- Generate a task retrospective after every Stop hook, including sessions with no obvious problems.
- Explain failures and issues at three levels: concrete operation evidence, agent-method diagnosis, and recommended next action.
- Treat knowledge updates as one action type inside the retrospective model.
- Preserve the existing safe approval flow for knowledge-file changes.
- Make the reviewer useful even when the right answer is not a knowledge update.
- Keep Stop hook output short while writing a complete Markdown report for inspection.

## Non-Goals

- Do not automatically create or update skills.
- Do not automatically edit project code based on retrospective findings.
- Do not block task completion only because a low-severity retrospective exists.
- Do not store large raw command outputs or private data in reports.
- Do not turn the retrospective into a full project-management system.

## Recommended Architecture

Keep the current hook and session storage architecture, but upgrade `review-session` into the owner of a retrospective result.

```text
collect-event.js
  -> .bypass/sessions/<session-id>/events.jsonl

review-session.js at Stop
  -> .bypass/sessions/<session-id>/retrospective.json
  -> .bypass/sessions/<session-id>/retrospective.md
  -> ~/.bypass/retrospective/<session-id>.md

apply-approved-update.js after user approval
  -> reads approved update_knowledge actions
  -> writes approved knowledge changes
```

The collector should stay small. It continues to normalize runtime hook payloads into a stable event schema. The reviewer is responsible for interpreting those events into findings and actions.

## Data Model

`retrospective.json` is the authoritative review result.

```json
{
  "session_id": "sess_123",
  "summary": "The task completed with minor issues.",
  "retrospective": {
    "outcome": "completed",
    "quality": "minor_issues",
    "findings": [
      {
        "id": "finding_1",
        "category": "knowledge",
        "severity": "medium",
        "evidence": ["evt_1"],
        "diagnosis": "The session revealed a reusable project convention.",
        "recommendation": "Ask the user whether to save this convention for future work.",
        "action": {
          "type": "update_knowledge",
          "confidence": "high",
          "target": "/absolute/path/AGENTS.md",
          "target_reason": "The event touched repository-level behavior.",
          "proposed_text": "Project convention: use node:test for this repository.",
          "rationale": "This affects future implementation and test choices."
        }
      }
    ]
  }
}
```

Allowed `outcome` values:

- `completed`
- `partial`
- `failed`
- `unknown`

Allowed `quality` values:

- `smooth`
- `minor_issues`
- `significant_issues`

Allowed finding categories:

- `knowledge`
- `skill`
- `code`
- `agent_usage`
- `environment`

Allowed action types:

- `update_knowledge`
- `create_skill`
- `improve_code`
- `adjust_agent_usage`
- `fix_environment`
- `no_action`

Only `update_knowledge` actions are eligible for the existing approval-and-apply flow. Other action types are recommendations for the user and main agent to consider in a later task.

## Report Behavior

The reviewer writes a Markdown report for every completed review, even when there are no findings. The report should be concise and stable:

```text
# Task Retrospective

Session: <session-id>

## Task Status
Outcome: completed
Quality: smooth

## Findings
No significant failures or reusable improvements were detected.

## Recommended Actions
No action needed.
```

When findings exist, the report groups them by severity and includes:

- category
- severity
- evidence ids
- diagnosis
- recommendation
- action type
- proposed text and target for knowledge updates

The report must not include large raw outputs. It should reference event ids and use short redacted evidence snippets already stored by the collector.

## Stop Hook Output

The Stop hook should always run the retrospective reviewer. It should keep terminal or hook output short:

- If there are no findings, say that the task retrospective found no action needed.
- If there are findings but no knowledge update, tell the main agent where the retrospective report is.
- If there are `update_knowledge` actions, tell the main agent to read the report and ask the user whether to apply those specific knowledge updates.

For Codex, the Stop hook must continue to emit valid JSON. `continue` should be `false` only when there are user-visible actions that the main agent should mention before finishing, especially approval-needed `update_knowledge` actions. A clean retrospective with no action can keep `continue: true`.

## AI Reviewer

The AI reviewer prompt should change from "identify durable knowledge only" to "review the completed task and classify improvements." It should return JSON only, using the retrospective schema.

The prompt must instruct the reviewer to:

- ground every finding in event evidence
- distinguish concrete failures from inferred process improvements
- classify each finding into exactly one category and one action type
- use `update_knowledge` only for durable reusable knowledge
- use `create_skill` only when the task revealed a repeatable workflow worth packaging
- use `improve_code` only when evidence points to project code or test design needing change
- use `adjust_agent_usage` for agent workflow issues such as missing clarification, poor verification, or inefficient tool use
- use `no_action` when an observation is not worth acting on
- avoid secrets, credentials, private data, and one-off details

The AI reviewer should receive compact events and knowledge target candidates, similar to the current provider flow. Candidate targets still apply only to `update_knowledge` actions.

## Rules Fallback

The deterministic rules reviewer should stay conservative:

- explicit project convention or preference evidence becomes a `knowledge` finding with `update_knowledge`
- test failures become a low- or medium-severity `code` or `agent_usage` finding depending on evidence
- dependency installs become an `environment` finding only when the output shows a setup issue or convention
- repeated failed commands can become an `agent_usage` finding
- sessions with no meaningful signals produce a smooth retrospective with no findings

Rules should prefer fewer findings over noisy reports.

## Knowledge Apply Flow

`apply-approved-update.js` should read approved `update_knowledge` actions from `retrospective.json`.

For migration safety, it may temporarily support old `suggestions.json` files as a fallback:

1. Prefer `retrospective.json` if present.
2. Extract findings where `action.type === "update_knowledge"`.
3. Match approved ids against finding ids or stable action ids.
4. Apply only approved actions with valid targets and non-empty proposed text.
5. If no retrospective exists, read legacy `suggestions.json` using the current behavior.

New reviewer runs should not write `suggestions.json` as the primary model. If a compatibility view is needed for existing UI or tests, it should be clearly derived from retrospective findings.

## Storage

Session artifacts should become:

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

A user-level copy of the Markdown report should be written to:

```text
~/.bypass/retrospective/<session-id>.md
```

The existing `~/.bypass/suggestion/<session-id>.md` path can remain readable for old sessions but should not be used for new retrospective reports.

## Error Handling

- Event collection failures should not interrupt the main task.
- Review failures should write a short error to `reviewer.log` and return a concise Stop hook notice with the session path.
- Invalid AI responses should fall back to rules when configured to do so.
- Invalid findings should be dropped rather than written.
- Invalid knowledge targets should prevent only that action, not the whole retrospective.
- Apply must refuse ambiguous or missing approval.

## Privacy And Security

Retrospective review observes task behavior, so it should remain privacy-conscious:

- store summaries and short snippets, not complete raw outputs
- keep secret redaction before event storage
- avoid recording environment variable values
- avoid persisting external documents
- do not include private personal data in proposed knowledge or report text
- keep all action application user-approved

## Test Plan

- `reviewSession` writes `retrospective.json` and Markdown for a session with no findings.
- `reviewSession` converts explicit convention evidence into a `knowledge` finding with `update_knowledge`.
- `reviewSession` converts test failures into a non-knowledge retrospective finding when no durable knowledge is present.
- AI reviewer validation rejects findings with unknown evidence ids or unsafe knowledge targets.
- Stop CLI emits valid Codex JSON for clean, non-knowledge, and knowledge-update retrospectives.
- Stop CLI does not force `continue: false` for a clean retrospective.
- `apply-approved-update.js` applies approved `update_knowledge` findings from `retrospective.json`.
- Legacy `suggestions.json` sessions still apply through the fallback path.
- Markdown reports do not include large raw outputs or unredacted secrets.

## V1 Decisions

- Codex completion should be interrupted only for approval-needed knowledge updates. Other findings are written to the report and can be mentioned without forcing a confirmation step.
- `create_skill` actions should include a recommendation sentence only. Suggested skill names and outlines can be added after the retrospective schema proves useful.
- The session viewer should keep its current event-first behavior in v1. Retrospective-first viewer changes can follow after the new schema is stable.
