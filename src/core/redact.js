const SECRET_PATTERNS = [
  /\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASS|API_KEY|AUTH)[A-Z0-9_]*\s*=\s*["']?[^"'\s]+["']?/gi,
  /["']?\b(password|api_key|token|secret)\b["']?\s*:\s*["']?[^"',}\s]+["']?/gi,
  /\bsk-[A-Za-z0-9_-]{6,}\b/g
];

export function redactSecrets(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, (match) => {
      const separator = match.includes('=') ? '=' : match.includes(':') ? ':' : '';
      const key = separator ? match.split(separator)[0].trim() : 'secret';
      return `${key}${separator ? `${separator} ` : ' '}[REDACTED]`;
    }),
    value
  );
}
