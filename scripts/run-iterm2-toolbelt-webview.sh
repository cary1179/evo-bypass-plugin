#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="$SCRIPT_DIR/.venv/bin/python"

if [[ ! -x "$PYTHON" ]]; then
  echo "Missing Python environment: $SCRIPT_DIR/.venv" >&2
  echo "Create it with: python3 -m venv scripts/.venv && scripts/.venv/bin/python -m pip install iterm2" >&2
  exit 1
fi

exec "$PYTHON" "$SCRIPT_DIR/iterm2-toolbelt-webview.py" "$@"
