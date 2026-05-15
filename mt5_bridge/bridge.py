#!/usr/bin/env python3
"""
MT5 FTMO bridge

Reads live ticks + closed candles from a local MetaTrader 5 terminal and writes
them to a JSON cache file for the Node backend to consume.

Environment variables:
  MT5_LOGIN                  Optional MT5 account login
  MT5_PASSWORD               Optional MT5 account password
  MT5_SERVER                 Optional MT5 server name
  MT5_PATH                   Optional terminal64.exe path
  MT5_ASSETS                 Comma-separated asset map, e.g. xauusd:XAUUSD,eurusd:EURUSD
  MT5_CANDLE_COUNT           Number of candles per timeframe (default: 300)
  MT5_POLL_SECONDS           Loop interval in seconds (default: 1)
  MT5_BRIDGE_MODE            "loop" or "once" (default: loop)
  MT5_BRIDGE_OUTPUT          Output JSON path (default: data/mt5_feed.json)
  MT5_BRIDGE_PUSH_URL        Optional backend URL for direct push, e.g. https://app.com/api/internal/mt5/feed
  MT5_BRIDGE_PUSH_TOKEN      Optional shared token sent as x-mt5-token
  MT5_BRIDGE_PUSH_TIMEOUT_MS Push timeout in milliseconds (default: 4000)
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

try:
    import MetaTrader5 as mt5
except ImportError as exc:  # pragma: no cover - import failure is the whole point here
    raise SystemExit(
        "MetaTrader5 package not installed. Run: pip install -r mt5_bridge/requirements.txt"
    ) from exc


ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT_DIR / "data" / "mt5_feed.json"

DEFAULT_ASSET_MAP = {
    "xauusd": "XAUUSD",
    "eurusd": "EURUSD",
    "usdjpy": "USDJPY",
}

TIMEFRAMES = {
    "15m": mt5.TIMEFRAME_M15,
    "1h": mt5.TIMEFRAME_H1,
    "4h": mt5.TIMEFRAME_H4,
    "daily": mt5.TIMEFRAME_D1,
}


@dataclass
class AssetConfig:
    asset_key: str
    requested_symbol: str


def log(message: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {message}", flush=True)


def getenv_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        log(f"{name} invalido ({raw!r}); usando {default}")
        return default


def parse_assets(raw: str) -> Dict[str, str]:
    if not raw.strip():
        return dict(DEFAULT_ASSET_MAP)

    parsed: Dict[str, str] = {}
    for part in raw.split(","):
        item = part.strip()
        if not item:
            continue
        if ":" in item:
            asset_key, symbol = item.split(":", 1)
        else:
            symbol = item
            asset_key = item.lower().replace("/", "").replace(".", "")
        parsed[asset_key.strip().lower()] = symbol.strip()

    return parsed or dict(DEFAULT_ASSET_MAP)


def initialize_mt5() -> None:
    login = os.getenv("MT5_LOGIN", "").strip()
    password = os.getenv("MT5_PASSWORD", "").strip()
    server = os.getenv("MT5_SERVER", "").strip()
    path = os.getenv("MT5_PATH", "").strip()

    kwargs = {}
    if path:
        kwargs["path"] = path
    if login:
        kwargs["login"] = int(login)
    if password:
        kwargs["password"] = password
    if server:
        kwargs["server"] = server

    ok = mt5.initialize(**kwargs)
    if not ok:
        code, message = mt5.last_error()
        raise RuntimeError(f"Falha ao inicializar MetaTrader5: {code} {message}")

    term = mt5.terminal_info()
    acc = mt5.account_info()
    log(
        "MT5 conectado"
        + (f" | terminal={term.name}" if term else "")
        + (f" | conta={acc.login}" if acc else "")
        + (f" | servidor={acc.server}" if acc else "")
    )


def build_symbol_candidates(base_symbol: str) -> List[str]:
    clean = base_symbol.strip()
    lower = clean.lower()
    upper = clean.upper()
    return [
        clean,
        upper,
        lower,
        f"{upper}.",
        f"{upper}.a",
        f"{upper}.m",
        f"{upper}m",
        f"{upper}_",
        f"{upper}-",
        f"{upper}pro",
        f"{upper}cash",
    ]


def resolve_symbol(base_symbol: str) -> Optional[str]:
    symbols = mt5.symbols_get()
    if not symbols:
        return None

    available_names = [s.name for s in symbols]
    by_upper = {name.upper(): name for name in available_names}

    for candidate in build_symbol_candidates(base_symbol):
        if candidate.upper() in by_upper:
            return by_upper[candidate.upper()]

    normalized = base_symbol.upper()
    contains = [
        name
        for name in available_names
        if name.upper().startswith(normalized) or normalized in name.upper()
    ]
    if contains:
        contains.sort(key=len)
        return contains[0]
    return None


def ensure_symbol_selected(symbol: str) -> None:
    info = mt5.symbol_info(symbol)
    if info is None:
        raise RuntimeError(f"Simbolo nao encontrado no terminal: {symbol}")
    if info.visible:
        return
    if not mt5.symbol_select(symbol, True):
        raise RuntimeError(f"Nao foi possivel ativar o simbolo: {symbol}")


def convert_candles(raw_rates: Iterable[dict]) -> List[dict]:
    candles: List[dict] = []
    for row in raw_rates:
        candles.append(
            {
                "time": int(row["time"]),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "tickVolume": int(row["tick_volume"]),
                "spreadPoints": int(row["spread"]),
                "realVolume": int(row["real_volume"]),
            }
        )
    return candles


def fetch_candles(symbol: str, candle_count: int) -> Dict[str, List[dict]]:
    result: Dict[str, List[dict]] = {}
    for tf_key, tf_value in TIMEFRAMES.items():
        rates = mt5.copy_rates_from_pos(symbol, tf_value, 0, candle_count)
        if rates is None:
            raise RuntimeError(f"copy_rates_from_pos falhou para {symbol} {tf_key}")
        candles = convert_candles(rates)
        if len(candles) >= 2:
            # Keep only closed candles; the last one may still be forming.
            candles = candles[:-1]
        result[tf_key] = candles
    return result


def normalize_tick(symbol: str) -> Tuple[dict, float]:
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise RuntimeError(f"symbol_info_tick falhou para {symbol}")

    bid = float(getattr(tick, "bid", 0.0) or 0.0)
    ask = float(getattr(tick, "ask", 0.0) or 0.0)
    last = float(getattr(tick, "last", 0.0) or 0.0)
    price = last if last > 0 else ((bid + ask) / 2 if bid > 0 and ask > 0 else bid or ask)
    spread = ask - bid if ask > 0 and bid > 0 else 0.0
    server_time = int(getattr(tick, "time", 0) or time.time())

    payload = {
        "bid": bid,
        "ask": ask,
        "last": last if last > 0 else None,
        "time": server_time,
        "timeMsc": int(getattr(tick, "time_msc", 0) or 0),
        "flags": int(getattr(tick, "flags", 0) or 0),
        "volume": int(getattr(tick, "volume", 0) or 0),
    }
    return payload, float(price)


def build_asset_payload(
    cfg: AssetConfig,
    broker_name: str,
    candle_count: int,
) -> dict:
    resolved_symbol = resolve_symbol(cfg.requested_symbol)
    if not resolved_symbol:
        raise RuntimeError(
            f"Nao encontrei simbolo no broker para {cfg.asset_key} ({cfg.requested_symbol})"
        )

    ensure_symbol_selected(resolved_symbol)

    tick, price = normalize_tick(resolved_symbol)
    candles = fetch_candles(resolved_symbol, candle_count)

    server_time = tick["time"]
    updated_at = int(time.time())

    return {
        "asset": cfg.asset_key,
        "source": "MT5_FTMO",
        "mode": "FTMO_SYNCED",
        "broker": broker_name or "FTMO",
        "symbol": resolved_symbol,
        "requestedSymbol": cfg.requested_symbol,
        "isLive": True,
        "serverTime": server_time,
        "updatedAt": updated_at,
        "price": price,
        "bid": tick["bid"],
        "ask": tick["ask"],
        "spread": round((tick["ask"] - tick["bid"]), 10) if tick["ask"] and tick["bid"] else 0.0,
        "tick": tick,
        "candles": candles,
    }


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    data = json.dumps(payload, indent=2)
    last_error = None
    for attempt in range(5):
        try:
            tmp_path.write_text(data, encoding="utf-8")
            tmp_path.replace(path)
            return
        except PermissionError as exc:
            last_error = exc
            time.sleep(0.15 * (attempt + 1))
    fallback_path = path.with_suffix(path.suffix + ".latest.json")
    try:
        fallback_path.write_text(data, encoding="utf-8")
        log(f"Aviso: lock no arquivo principal, snapshot salvo em fallback {fallback_path}")
        return
    except PermissionError:
        pass
    raise last_error if last_error else PermissionError(f"Falha ao gravar snapshot em {path}")


def push_snapshot(snapshot: dict) -> None:
    push_url = os.getenv("MT5_BRIDGE_PUSH_URL", "").strip()
    if not push_url:
        return

    timeout_ms = max(1000, getenv_int("MT5_BRIDGE_PUSH_TIMEOUT_MS", 4000))
    token = os.getenv("MT5_BRIDGE_PUSH_TOKEN", "").strip()
    payload = json.dumps(snapshot).encode("utf-8")
    request = urllib.request.Request(
        push_url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(payload)),
        },
    )
    if token:
        request.add_header("x-mt5-token", token)

    try:
        with urllib.request.urlopen(request, timeout=timeout_ms / 1000) as response:
            status = getattr(response, "status", 200)
            if status >= 400:
                raise RuntimeError(f"bridge push HTTP {status}")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"bridge push HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"bridge push URL error: {exc.reason}") from exc


def collect_snapshot(asset_map: Dict[str, str], candle_count: int) -> dict:
    terminal = mt5.terminal_info()
    account = mt5.account_info()

    broker_name = "FTMO"
    if account and getattr(account, "company", None):
        broker_name = str(account.company)

    assets_payload: Dict[str, dict] = {}
    errors: Dict[str, str] = {}

    for asset_key, requested_symbol in asset_map.items():
        try:
            assets_payload[asset_key] = build_asset_payload(
                AssetConfig(asset_key=asset_key, requested_symbol=requested_symbol),
                broker_name=broker_name,
                candle_count=candle_count,
            )
        except Exception as exc:
            errors[asset_key] = str(exc)
            log(f"{asset_key}: erro ao coletar dados - {exc}")

    now = int(time.time())
    return {
        "success": len(assets_payload) > 0,
        "source": "MT5_FTMO_BRIDGE",
        "mode": "FTMO_SYNCED" if assets_payload else "ANALYSIS_ONLY",
        "generatedAt": now,
        "generatedAtIso": datetime.now(timezone.utc).isoformat(),
        "terminal": {
            "name": getattr(terminal, "name", None) if terminal else None,
            "company": getattr(terminal, "company", None) if terminal else None,
            "connected": getattr(terminal, "connected", None) if terminal else None,
            "path": getattr(terminal, "path", None) if terminal else None,
        },
        "account": {
            "login": getattr(account, "login", None) if account else None,
            "server": getattr(account, "server", None) if account else None,
            "company": getattr(account, "company", None) if account else None,
            "name": getattr(account, "name", None) if account else None,
        },
        "assets": assets_payload,
        "errors": errors,
    }


def main() -> int:
    asset_map = parse_assets(os.getenv("MT5_ASSETS", ""))
    candle_count = getenv_int("MT5_CANDLE_COUNT", 300)
    poll_seconds = max(1, getenv_int("MT5_POLL_SECONDS", 1))
    mode = os.getenv("MT5_BRIDGE_MODE", "loop").strip().lower() or "loop"
    output_path = Path(os.getenv("MT5_BRIDGE_OUTPUT", str(DEFAULT_OUTPUT))).resolve()

    initialize_mt5()

    try:
        while True:
            snapshot = collect_snapshot(asset_map, candle_count)
            write_json_atomic(output_path, snapshot)
            push_snapshot(snapshot)
            ok_count = len(snapshot.get("assets", {}))
            err_count = len(snapshot.get("errors", {}))
            log(f"Snapshot salvo em {output_path} | ativos={ok_count} | erros={err_count}")

            if mode == "once":
                break
            time.sleep(poll_seconds)
    except KeyboardInterrupt:
        log("Bridge interrompida pelo usuario")
        return 0
    finally:
        mt5.shutdown()

    return 0


if __name__ == "__main__":
    sys.exit(main())
