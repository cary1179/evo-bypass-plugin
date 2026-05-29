export function normalizeHookPayload(payload, fallbackRoot = process.cwd()) {
  payload = isObject(payload) ? payload : {};
  const hook = payload.hook_event_name || payload.hook || payload.event || 'PostToolUse';
  const runtime = payload.runtime || payload.source || detectRuntime(payload);
  const sessionId = payload.session_id || payload.sessionId || payload.conversation_id || payload.thread_id || 'unknown-session';
  const toolInput = isObject(payload.tool_input) ? payload.tool_input : isObject(payload.input) ? payload.input : {};
  const toolResponse = isObject(payload.tool_response) ? payload.tool_response : isObject(payload.response) ? payload.response : {};

  return {
    runtime,
    hook,
    sessionId,
    root: payload.cwd || payload.working_directory || payload.workspace || fallbackRoot,
    prompt: payload.prompt || payload.user_prompt || payload.message || '',
    tool: payload.tool_name || payload.tool || payload.toolName || (hook === 'UserPromptSubmit' ? 'UserPrompt' : 'Other'),
    toolInput,
    toolResponse,
    command: toolInput.command || toolInput.cmd || payload.command || payload.cmd || '',
    output: collectOutput(toolResponse, payload),
    error: stringifyOutput(toolResponse.error || payload.error),
    exitCode: normalizeExitCode(toolResponse, payload)
  };
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
