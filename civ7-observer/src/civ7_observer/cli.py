"""Command-line entry point. stdout carries only the report; logs go to stderr."""

from __future__ import annotations

import argparse
import logging
import sys

from civ7_observer import __version__
from civ7_observer.doctor import run_doctor

DEFAULT_PORT = 9444
DEFAULT_TIMEOUT = 5.0
_STUBS = ("probe", "snapshot", "serve")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="civ7-observer", description="Read-only Civilization VII observer.")
    parser.add_argument("--version", action="version", version=f"civ7-observer {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    d = sub.add_parser("doctor", help="check the local UI debugger connection and identify the in-game realm")
    d.add_argument("--port", type=int, default=DEFAULT_PORT, help="loopback debugger port (default 9444)")
    d.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="seconds allowed per network step (default 5)")
    d.add_argument("--target-id", default=None, help="restrict to one discovered target id (for the ambiguous case)")
    d.add_argument("--json", action="store_true", help="print the machine-readable report")
    d.add_argument("-v", "--verbose", action="store_true", help="debug logging on stderr")

    for name in _STUBS:
        s = sub.add_parser(name, help=f"{name} (not implemented in Change 1)")
        s.add_argument("args", nargs=argparse.REMAINDER)
    return parser


def _print_human(result) -> None:
    print(f"status: {result.status}")
    print(f"summary: {result.summary}")
    print(f"discovery: {result.discovery['url']} ({result.discovery['targetCount']} targets)")
    if result.discovery["error"]:
        print(f"  error: {result.discovery['error']['code']}: {result.discovery['error']['message']}")
    for t in result.targets:
        line = f"  [{t['index']}] id={t['id']} kind={t['kind']} title={t['title']!r} url={t['url']!r}"
        if t["error"]:
            line += f" error={t['error']['code']}: {t['error']['message']}"
        elif t["probe"]:
            p = t["probe"]
            line += f" inGame={p['inGame']} turn={p['turn']} localPlayerId={p['localPlayerId']} localObserverId={p['localObserverId']}"
        print(line)
    if result.context:
        print(f"context: {result.context}")
    print(f"game process: {result.game_process}; adapter {result.adapter_version}; {result.duration_ms} ms")


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command in _STUBS:
        print(f"civ7-observer {args.command}: not implemented in Change 1 (see plans/civ7-local-observer-poc-plan.md)", file=sys.stderr)
        return 2
    logging.basicConfig(stream=sys.stderr, level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(levelname)s %(name)s: %(message)s")
    result = run_doctor(port=args.port, timeout=args.timeout, target_id=args.target_id)
    if args.json:
        print(result.to_json())
    else:
        _print_human(result)
    return result.exit_code()
