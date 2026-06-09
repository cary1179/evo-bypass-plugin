export function normalizeHookPayload(payload, fallbackRoot = process.cwd()) {
  payload = isObject(payload) ? payload : {};
  const hook = payload.hook_event_name || payload.hook || payload.event || 'PostToolUse';
  const runtime = payload.runtime || payload.source || detectRuntime(payload);
  const sessionId = payload.session_id || payload.sessionId || payload.conversation_id || payload.thread_id || 'unknown-session';
  const toolInput = isObject(payload.tool_input) ? payload.tool_input : isObject(payload.input) ? payload.input : {};
  const toolResponse = isObject(payload.tool_response) ? payload.tool_response : isObject(payload.response) ? payload.response : {};

  const rawPrompt = payload.prompt || payload.user_prompt || payload.message || '';
  const prompt = sanitizePrompt(rawPrompt);
  const skipReason = reviewSkipReason({ runtime, hook, prompt: rawPrompt });

  return {
    runtime,
    hook,
    sessionId,
    root: payload.cwd || payload.working_directory || payload.workspace || fallbackRoot,
    prompt,
    skipReview: Boolean(skipReason),
    skipReason,
    tool: payload.tool_name || payload.tool || payload.toolName || (hook === 'UserPromptSubmit' ? 'UserPrompt' : 'Other'),
    toolInput,
    toolResponse,
    command: toolInput.command || toolInput.cmd || payload.command || payload.cmd || '',
    output: collectOutput(toolResponse, payload),
    error: stringifyOutput(toolResponse.error || payload.error),
    exitCode: normalizeExitCode(toolResponse, payload)
  };
}

function reviewSkipReason({ runtime, hook, prompt }) {
  if (runtime === 'codex' && hook === 'UserPromptSubmit' && isCodexSuggestionsPrompt(prompt)) {
    return 'codex_suggestions_prompt';
  }
  return '';
}

function isCodexSuggestionsPrompt(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return /Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project:/u.test(value);
}

function sanitizePrompt(value) {
  const text = typeof value === 'string' ? value : '';
  return stripRecentCodexThreads(text).trimStart();
}

function stripRecentCodexThreads(text) {
  const marker = 'Recent Codex threads in this project:';
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) {
    return text;
  }

  const arrayStart = text.indexOf('[', markerIndex + marker.length);
  if (arrayStart === -1) {
    return text.slice(0, markerIndex).trimEnd();
  }

  const arrayEnd = findJsonArrayEnd(text, arrayStart);
  if (arrayEnd === -1) {
    return text.slice(0, markerIndex).trimEnd();
  }

  return `${text.slice(0, markerIndex).trimEnd()}\n\n${text.slice(arrayEnd + 1).trimStart()}`.trimEnd();
}

function findJsonArrayEnd(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function collectOutput(toolResponse, payload) {
  return [
    toolResponse.stdout,
    toolResponse.stderr,
    toolResponse.output,
    toolResponse.error,
    payload.stdout,
    payload.stderr,
    payload.output,
    payload.error
  ].map(stringifyOutput).filter(Boolean).join('\n');
}

function stringifyOutput(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : String(value);
  } catch {
    return String(value);
  }
}

function normalizeExitCode(toolResponse, payload) {
  if (Number.isInteger(toolResponse.exit_code)) {
    return toolResponse.exit_code;
  }
  if (Number.isInteger(toolResponse.exitCode)) {
    return toolResponse.exitCode;
  }
  if (Number.isInteger(payload.exit_code)) {
    return payload.exit_code;
  }
  if (Number.isInteger(payload.exitCode)) {
    return payload.exitCode;
  }
  return undefined;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function detectRuntime(payload) {
  if (payload.codex || payload.thread_id || payload.conversation_id) {
    return 'codex';
  }
  return 'claude';
}
