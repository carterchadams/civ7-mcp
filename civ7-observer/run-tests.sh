#!/usr/bin/env sh
# Runs both test runners; pytest does not collect the Node payload tests.
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-../.venv/bin/python}"
"$PY" -m pytest tests -q "$@"
node --test tests/test_payload.mjs
