export function normalizeHookPayload(payload, fallbackRoot = process.cwd()) {
  const hook = payload.hook_event_name || payload.hook || payload.event || 'PostToolUse';
  const runtime = payload.runtime || payload.source || detectRuntime(payload);
  const sessionId = payload.session_id || payload.sessionId || payload.conversation_id || payload.thread_id || 'unknown-session';
  const toolInput = payload.tool_input || payload.input || {};
  const toolResponse = payload.tool_response || payload.response || {};

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
    output: toolResponse.output || toolResponse.stderr || toolResponse.stdout || payload.output || payload.stderr || payload.stdout || '',
    exitCode: normalizeExitCode(toolResponse, payload)
  };
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

function detectRuntime(payload) {
  if (payload.codex || payload.thread_id || payload.conversation_id) {
    return 'codex';
  }
  return 'claude';
}
