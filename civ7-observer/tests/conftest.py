import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))


@pytest.fixture(autouse=True)
def isolated_host_state(tmp_path, monkeypatch):
    """No test may touch the machine's real host state.

    The game lock, attachment generations, in-flight reservations and the unresolved barrier live
    in a shared directory that a running game depends on; a test writing there could block the
    user's own seat. Every test gets its own.
    """
    monkeypatch.setenv("CIV7_OBSERVER_STATE_DIR", str(tmp_path / "host-state"))
    yield
