#!/usr/bin/env sh
# Runs both test runners; pytest does not collect the Node payload tests.
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-../.venv/bin/python}"
# The venv holds an editable install pointing at the primary checkout, so a run from a git worktree
# would otherwise test the primary tree's sources and quietly pass on changes it never loaded.
PYTHONPATH="$(pwd)/src${PYTHONPATH:+:$PYTHONPATH}" "$PY" -m pytest tests -q "$@"
node --test tests/*.mjs
