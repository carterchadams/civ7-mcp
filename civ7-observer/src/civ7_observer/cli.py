"""Command-line entry point. stdout carries only the report; logs go to stderr."""

from __future__ import annotations

import argparse
import logging
import sys

import json
from pathlib import Path

from civ7_observer import __version__, cdp
from civ7_observer.doctor import run_doctor
from civ7_observer.probe import run_probe
from civ7_observer.schema import MODES
from civ7_observer.actions import ActionRegistry
from civ7_observer.service import ObserverError, open_game_session
from civ7_observer.snapshot import run_snapshot

DEFAULT_PORT = 9444
DEFAULT_TIMEOUT = 5.0
_STUBS: tuple[str, ...] = ()


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

    p = sub.add_parser("probe", help="developer-only capability diagnostics for the local seat, written to a file")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    p.add_argument("--target-id", default=None)
    p.add_argument("--player", type=int, default=None, help="engine player id to bind (default: the local seat)")
    p.add_argument("--out", type=Path, default=Path("runs/capabilities.json"))
    p.add_argument("--json", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")

    sn = sub.add_parser("snapshot", help="write one validated observation of the bound player")
    sn.add_argument("--port", type=int, default=DEFAULT_PORT)
    sn.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    sn.add_argument("--target-id", default=None)
    sn.add_argument("--player", type=int, default=None, help="engine player id to bind (default: the local seat)")
    sn.add_argument("--mode", choices=MODES, default="singleplayer", help="session type the capture is allowed in")
    sn.add_argument("--out", type=Path, default=Path("runs/observation.json"))
    sn.add_argument("--json", action="store_true")
    sn.add_argument("-v", "--verbose", action="store_true")

    sv = sub.add_parser("serve", help="run the stdio MCP server (get_observation, get_status) for one bound player")
    sv.add_argument("--player", type=int, required=True, help="engine player id to bind for the whole server lifetime")
    sv.add_argument("--mode", choices=MODES, required=True, help="session type captures are allowed in")
    sv.add_argument("--port", type=int, default=DEFAULT_PORT)
    sv.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    sv.add_argument("--target-id", default=None)
    sv.add_argument("-v", "--verbose", action="store_true")

    act = sub.add_parser("act", help="constrained actions for one bound seat (research/civic selection, end turn)")
    act.add_argument("verb", choices=["list", "perform", "result", "reconcile", "rebind"])
    act.add_argument("--player", type=int, required=True)
    act.add_argument("--mode", choices=MODES, required=True)
    act.add_argument("--port", type=int, default=DEFAULT_PORT)
    act.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    act.add_argument("--target-id", default=None)
    act.add_argument("--journal", type=Path, default=Path("runs/actions.jsonl"))
    act.add_argument("--action-id", default=None)
    act.add_argument("--request-id", default=None)
    act.add_argument("--status", choices=["confirmed", "rejected"], default=None, help="reconcile: the human-verified outcome")
    act.add_argument("--note", default="", help="reconcile: how the outcome was verified")
    act.add_argument("--json", action="store_true")
    act.add_argument("-v", "--verbose", action="store_true")

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


def _run_probe(args) -> int:
    try:
        result = run_probe(port=args.port, timeout=args.timeout, out=args.out, player=args.player, target_id=args.target_id)
    except (ObserverError, cdp.CdpError) as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": exc.to_dict()}, indent=2))
        else:
            print(f"probe failed: {exc.code}: {exc.message}")
        return 1
    if args.json:
        print(json.dumps({"ok": True, **result.to_dict()}, indent=2))
    else:
        print(f"probe written: {result.path} (player {result.bound_player_id}, turn {result.turn}, "
              f"{result.error_count} payload errors, {result.size_bytes} bytes)")
    return 0


def _run_snapshot(args) -> int:
    try:
        result = run_snapshot(port=args.port, timeout=args.timeout, out=args.out, player=args.player, mode=args.mode, target_id=args.target_id)
    except (ObserverError, cdp.CdpError) as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": exc.to_dict()}, indent=2))
        else:
            print(f"snapshot failed: {exc.code}: {exc.message}")
        return 1
    if args.json:
        print(json.dumps({"ok": True, **result.to_dict()}, indent=2))
    else:
        print(f"observation written: {result.path} (player {result.player_id}, turn {result.turn}, "
              f"{result.settlement_count} settlements, {result.unit_count} units, id {result.observation_id})")
    return 0


def _emit(args, payload: dict, code: int) -> int:
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(json.dumps(payload, indent=2) if code == 0 else f"failed: {payload.get('error', {}).get('code')}: {payload.get('error', {}).get('message')}")
    return code


def _run_act(args) -> int:
    reg = ActionRegistry(journal_path=args.journal)
    try:
        if args.verb == "result":
            if not args.request_id:
                raise SystemExit("act result requires --request-id")
            res = reg.get_result(args.request_id)
            return _emit(args, {"ok": res is not None, "result": res}, 0 if res else 1)
        if args.verb == "reconcile":
            if not (args.request_id and args.status):
                raise SystemExit("act reconcile requires --request-id and --status")
            reg.reconcile(args.request_id, args.status, note=args.note)
            return _emit(args, {"ok": True, "result": reg.get_result(args.request_id)}, 0)
        if args.verb == "perform" and not (args.action_id and args.request_id):
            raise SystemExit("act perform requires --action-id and --request-id")
        if args.verb == "rebind" and not args.note:
            raise SystemExit("act rebind requires --note describing why (e.g. 'loaded save X at the same turn')")
        with open_game_session(port=args.port, timeout=args.timeout, target_id=args.target_id) as gs:
            if args.verb == "rebind":
                gen = reg.rebind(match=str(gs.context.game_guid), note=args.note)
                return _emit(args, {"ok": True, "match": gs.context.game_guid, "generation": gen}, 0)
            if args.verb == "list":
                return _emit(args, {"ok": True, **reg.list_offers(gs, player=args.player, mode=args.mode)}, 0)
            res = reg.perform(gs, action_id=args.action_id, request_id=args.request_id, player=args.player, mode=args.mode)
            return _emit(args, {"ok": res["status"] == "confirmed", "result": res}, 0 if res["status"] == "confirmed" else 1)
    except (ObserverError, cdp.CdpError) as exc:
        return _emit(args, {"ok": False, "error": exc.to_dict()}, 1)
    except ValueError as exc:
        return _emit(args, {"ok": False, "error": {"code": "INVALID_ARGUMENT", "message": str(exc)}}, 1)


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command in _STUBS:
        print(f"civ7-observer {args.command}: not implemented in Change 1 (see plans/civ7-local-observer-poc-plan.md)", file=sys.stderr)
        return 2
    logging.basicConfig(stream=sys.stderr, level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(levelname)s %(name)s: %(message)s")
    if args.command == "probe":
        return _run_probe(args)
    if args.command == "snapshot":
        return _run_snapshot(args)
    if args.command == "act":
        return _run_act(args)
    if args.command == "serve":
        from civ7_observer.server import serve
        return serve(port=args.port, timeout=args.timeout, player=args.player, mode=args.mode, target_id=args.target_id)
    result = run_doctor(port=args.port, timeout=args.timeout, target_id=args.target_id)
    if args.json:
        print(result.to_json())
    else:
        _print_human(result)
    return result.exit_code()
