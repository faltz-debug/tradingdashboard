#!/usr/bin/env python3
"""
BOT WEBHOOK RECEIVER - Recebe sinais do dashboard e abre posições no MT5
Integração com webhook para automação de trading
"""

from flask import Flask, request, jsonify
import MetaTrader5 as mt5
import threading
import time
from datetime import datetime, timedelta, timezone
import logging
import os
import requests as http_requests
from dotenv import load_dotenv

# ─── CONFIG ───────────────────────────────────────────────────────────
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# MT5 CONFIG
MT5_LOGIN = int(os.getenv('MT5_LOGIN', '12345'))
MT5_PASSWORD = os.getenv('MT5_PASSWORD', '')
MT5_SERVER = os.getenv('MT5_SERVER', 'ICMarketsSC-Demo')

# WEBHOOK CONFIG
WEBHOOK_TOKEN = os.getenv('BOT_WEBHOOK_TOKEN', '')
BOT_PORT = int(os.getenv('BOT_PORT', '5000'))

# RISK CONFIG
MAX_POSITION_SIZE = float(os.getenv('MAX_POSITION_SIZE', '1.0'))
EQUITY_RISK_PERCENT = float(os.getenv('EQUITY_RISK_PERCENT', '2.0'))

# DASHBOARD CONFIG (para reportar fechamentos reais)
DASHBOARD_URL = os.getenv('DASHBOARD_URL', 'http://localhost:3000')
MONITOR_INTERVAL_S = int(os.getenv('MONITOR_INTERVAL_S', '15'))  # checa posições a cada 15s
PROFIT_LOCK_ENABLED = os.getenv('PROFIT_LOCK_ENABLED', 'false').lower() == 'true'
PROFIT_LOCK_TRIGGER_PCT = float(os.getenv('PROFIT_LOCK_TRIGGER_PCT', '0.80'))
PROFIT_LOCK_SECURE_PCT = float(os.getenv('PROFIT_LOCK_SECURE_PCT', '0.20'))
CLOSE_DEAL_RETRY_LIMIT = int(os.getenv('CLOSE_DEAL_RETRY_LIMIT', '8'))

# Mapeamento ticket MT5 -> trade_id do dashboard (em memória)
# { ticket_int: {'trade_id': str, 'asset': str, 'direction': str, 'entry': float} }
_ticket_map = {}
_ticket_map_lock = threading.Lock()
_profit_lock_state = {
    'enabled': PROFIT_LOCK_ENABLED,
    'trigger_pct': max(0.05, min(PROFIT_LOCK_TRIGGER_PCT, 0.99)),
    'secure_pct': max(0.01, min(PROFIT_LOCK_SECURE_PCT, 0.95)),
}
_profit_lock_lock = threading.Lock()

# ─── INICIALIZAR MT5 ───────────────────────────────────────────────────
def init_mt5():
    try:
        if not mt5.initialize(login=MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER):
            logger.error(f"MT5 init failed: {mt5.last_error()}")
            return False

        logger.info(f"✅ MT5 conectado: {MT5_LOGIN} @ {MT5_SERVER}")
        return True
    except Exception as e:
        logger.error(f"MT5 exception: {str(e)}")
        return False


def _is_authorized(req):
    token = req.headers.get('x-webhook-token', '')
    return (not WEBHOOK_TOKEN) or token == WEBHOOK_TOKEN


def _get_profit_lock_config():
    with _profit_lock_lock:
        return dict(_profit_lock_state)


def _update_profit_lock_config(*, enabled=None):
    with _profit_lock_lock:
        if enabled is not None:
            _profit_lock_state['enabled'] = bool(enabled)
        return dict(_profit_lock_state)


def _round_price(symbol: str, price: float) -> float:
    symbol_info = mt5.symbol_info(symbol)
    digits = getattr(symbol_info, 'digits', 5) if symbol_info else 5
    return round(float(price), digits)


def _move_position_sl(position, new_sl: float):
    request_order = {
        'action': mt5.TRADE_ACTION_SLTP,
        'symbol': position.symbol,
        'position': position.ticket,
        'sl': float(new_sl),
        'tp': float(position.tp) if getattr(position, 'tp', 0) else 0.0,
    }
    result = mt5.order_send(request_order)
    if result and result.retcode == mt5.TRADE_RETCODE_DONE:
        return True, None
    err_msg = result.comment if result else str(mt5.last_error())
    return False, err_msg


def _maybe_apply_profit_lock(position, tracked_info):
    cfg = _get_profit_lock_config()
    if not cfg.get('enabled'):
        return

    if tracked_info.get('profit_lock_applied'):
        return

    entry = tracked_info.get('entry')
    tp = tracked_info.get('tp')
    direction = tracked_info.get('direction')
    current_sl = getattr(position, 'sl', 0.0) or 0.0

    if not entry or not tp or direction not in ('BUY', 'SELL'):
        return

    total_target = (tp - entry) if direction == 'BUY' else (entry - tp)
    if total_target <= 0:
        return

    current_price = getattr(position, 'price_current', 0.0) or 0.0
    if current_price <= 0:
        tick = mt5.symbol_info_tick(position.symbol)
        if tick:
            current_price = tick.bid if direction == 'BUY' else tick.ask
    if current_price <= 0:
        return

    progress = ((current_price - entry) / total_target) if direction == 'BUY' else ((entry - current_price) / total_target)
    if progress < cfg['trigger_pct']:
        return

    locked_price = entry + (total_target * cfg['secure_pct']) if direction == 'BUY' else entry - (total_target * cfg['secure_pct'])
    locked_price = _round_price(position.symbol, locked_price)

    improved = locked_price > current_sl if direction == 'BUY' else (current_sl == 0 or locked_price < current_sl)
    if not improved:
        tracked_info['profit_lock_applied'] = True
        tracked_info['profit_lock_sl'] = locked_price
        return

    ok, err_msg = _move_position_sl(position, locked_price)
    if ok:
        tracked_info['profit_lock_applied'] = True
        tracked_info['profit_lock_sl'] = locked_price
        logger.info(
            f"🔐 Profit lock aplicado: ticket={position.ticket} {position.symbol} "
            f"{direction} progress={progress:.2%} novo_sl={locked_price}"
        )
    else:
        logger.warning(f"⚠️ Falha ao aplicar profit lock ticket={position.ticket}: {err_msg}")

# ─── MONITOR DE POSIÇÕES ─────────────────────────────────────────────────
def _to_utc_iso_from_deal(deal):
    time_msc = int(getattr(deal, 'time_msc', 0) or 0)
    time_s = int(getattr(deal, 'time', 0) or 0)
    if time_msc > 0:
        return datetime.fromtimestamp(time_msc / 1000, timezone.utc).isoformat().replace('+00:00', 'Z')
    if time_s > 0:
        return datetime.fromtimestamp(time_s, timezone.utc).isoformat().replace('+00:00', 'Z')
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _report_progress_to_dashboard(trade_id, price_high, price_low):
    """
    Reporta MFE (priceHigh/priceLow desde o last update) para o dashboard.
    O dashboard calcula maxFavorableR e marca reached1R/reached2R quando aplicavel.
    Chamado a cada poll do monitor para trades abertos.
    """
    try:
        url = f"{DASHBOARD_URL}/api/vip/bot/progress"
        payload = {
            'tradeId':   trade_id,
            'priceHigh': float(price_high) if price_high else None,
            'priceLow':  float(price_low)  if price_low  else None,
        }
        headers = {'Content-Type': 'application/json'}
        if WEBHOOK_TOKEN:
            headers['x-webhook-token'] = WEBHOOK_TOKEN
        # Timeout curto — se cair, monitor continua sem travar
        http_requests.post(url, json=payload, headers=headers, timeout=3)
    except Exception:
        pass  # silencioso — falha de progress nao deve travar o monitor


def _report_close_to_dashboard(trade_id, ticket, close_price, outcome, closed_at_iso=None):
    """Notifica o dashboard do fechamento real de uma posição no MT5."""
    try:
        url = f"{DASHBOARD_URL}/api/vip/bot/result"
        payload = {
            'tradeId':    trade_id,
            'ticket':     ticket,
            'closePrice': close_price,
            'outcome':    outcome,
            'closedAt':   closed_at_iso or datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        }
        headers = {'Content-Type': 'application/json'}
        if WEBHOOK_TOKEN:
            headers['x-webhook-token'] = WEBHOOK_TOKEN
        resp = http_requests.post(url, json=payload, headers=headers, timeout=10)
        if resp.status_code == 200:
            logger.info(f"✅ Dashboard notificado: trade={trade_id} ticket={ticket} {outcome} @ {close_price}")
        else:
            logger.warning(f"⚠️ Dashboard retornou {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        logger.error(f"❌ Erro ao notificar dashboard: {e}")


def _find_close_deal_for_ticket(ticket, lookback_hours=48):
    try:
        ticket = int(ticket)
    except Exception:
        return None

    dt_from = datetime.now() - timedelta(hours=lookback_hours)
    dt_to = datetime.now() + timedelta(minutes=1)
    deals = mt5.history_deals_get(dt_from, dt_to) or []

    for deal in sorted(deals, key=lambda d: d.time, reverse=True):
        if int(getattr(deal, 'position_id', 0)) == ticket and getattr(deal, 'entry', None) == mt5.DEAL_ENTRY_OUT:
            return deal
    return None


def _monitor_positions():
    """
    Thread de monitor: detecta quando posições gerenciadas pelo bot fecham no MT5
    (via TP, SL ou fechamento manual) e reporta o preço real ao dashboard.
    """
    logger.info(f"🔍 Monitor de posições iniciado (intervalo: {MONITOR_INTERVAL_S}s)")
    known_open_tickets = set()  # tickets abertos conhecidos pelo bot

    while True:
        try:
            if not mt5.account_info():
                time.sleep(MONITOR_INTERVAL_S)
                continue

            # Posições atualmente abertas no MT5
            open_positions = mt5.positions_get() or []
            current_tickets = {p.ticket for p in open_positions}

            with _ticket_map_lock:
                tracked = dict(_ticket_map)  # copia segura

            for pos in open_positions:
                info = tracked.get(pos.ticket)
                if info:
                    _maybe_apply_profit_lock(pos, info)

                    # ── MFE TRACKING ─────────────────────────────────────
                    # Pega tick mais recente para extremos do periodo de poll.
                    # mt5.copy_ticks_from / copy_rates_from_pos retornaria mais
                    # precisao, mas para 15s de poll o price_current ja captura
                    # bem a excursao — over-engineering evitado no MVP.
                    trade_id = info.get('trade_id')
                    if trade_id:
                        tick = mt5.symbol_info_tick(pos.symbol)
                        if tick:
                            # Atualiza extremos observados desde o ultimo poll
                            ph = info.get('mfe_high') or 0.0
                            pl = info.get('mfe_low')  or float('inf')
                            ph = max(ph, tick.bid, tick.ask)
                            pl = min(pl, tick.bid, tick.ask)
                            info['mfe_high'] = ph
                            info['mfe_low']  = pl
                            _report_progress_to_dashboard(trade_id, ph, pl)

            # Tickets que estavam abertos e agora fecharam
            newly_closed = (known_open_tickets & set(tracked.keys())) - current_tickets

            for ticket in newly_closed:
                info = tracked.get(ticket)
                if not info:
                    continue

                trade_id = info.get('trade_id')
                logger.info(f"📌 Posição fechada detectada: ticket={ticket} trade_id={trade_id}")

                # Busca o deal de fechamento no histórico (últimas 48h)
                close_deal = _find_close_deal_for_ticket(ticket)

                if close_deal:
                    close_price = close_deal.price
                    reason      = close_deal.reason
                    if reason == mt5.DEAL_REASON_TP:
                        outcome = 'TP'
                    elif reason == mt5.DEAL_REASON_SL:
                        outcome = 'SL'
                    else:
                        outcome = 'MANUAL'

                    logger.info(f"💰 Deal fechamento: ticket={ticket} price={close_price} outcome={outcome} reason={reason}")
                    _report_close_to_dashboard(
                        trade_id,
                        ticket,
                        close_price,
                        outcome,
                        _to_utc_iso_from_deal(close_deal),
                    )
                    with _ticket_map_lock:
                        _ticket_map.pop(ticket, None)
                else:
                    retry_count = int(info.get('close_lookup_retries', 0)) + 1
                    if retry_count >= CLOSE_DEAL_RETRY_LIMIT:
                        logger.warning(
                            f"⚠️ Ticket {ticket} fechou mas deal não encontrado no histórico "
                            f"após {retry_count}/{CLOSE_DEAL_RETRY_LIMIT} tentativas - removendo do mapa"
                        )
                        with _ticket_map_lock:
                            _ticket_map.pop(ticket, None)
                    else:
                        with _ticket_map_lock:
                            if ticket in _ticket_map:
                                _ticket_map[ticket]['close_lookup_retries'] = retry_count
                        logger.info(
                            f"⏳ Ticket {ticket} fechou, mas o deal ainda não apareceu no histórico "
                            f"({retry_count}/{CLOSE_DEAL_RETRY_LIMIT})"
                        )

            known_open_tickets = current_tickets

        except Exception as e:
            logger.error(f"Erro no monitor de posições: {e}")

        time.sleep(MONITOR_INTERVAL_S)


# ─── WEBHOOK ENDPOINT ───────────────────────────────────────────────────
@app.route('/webhook/signal', methods=['POST'])
def receive_signal():
    """
    Recebe sinal do dashboard via webhook

    Esperado:
    {
        "asset": "XAUUSD",
        "direction": "COMPRA",
        "entry": 2350.70,
        "sl": 2345.20,
        "tp": 2360.15,
        "score": 2.5,
        "autoOpen": true,  // true = abre automático, false = aguarda aprovação
        "timestamp": "2026-04-24T08:30:15Z"
    }
    """

    try:
        # Validar token
        if not _is_authorized(request):
            logger.warning(f"❌ Webhook não autorizado de {request.remote_addr}")
            return {'error': 'Unauthorized'}, 401

        # Parsear sinal
        data = request.get_json()
        if not data:
            return {'error': 'No JSON'}, 400

        asset = data.get('asset', '').upper()
        direction = data.get('direction', '').upper()
        entry = float(data.get('entry', 0))
        sl = float(data.get('sl', 0))
        tp = float(data.get('tp', 0))
        score = float(data.get('score', 0))
        autoOpen = data.get('autoOpen', False)
        trade_id = data.get('tradeId', '')  # ID do trade no dashboard
        # riskPercent enviado pelo server.js baseado no score tier
        # 0.50% = sinal mínimo | 0.75% = médio | 1.00% = forte
        risk_percent = float(data.get('riskPercent', EQUITY_RISK_PERCENT))

        logger.info(f"📥 Sinal recebido: {asset} {direction} @ {entry} (score: {score}, risk: {risk_percent}%, auto: {autoOpen})")

        # Validações
        if not asset or not direction or entry <= 0:
            return {'error': 'Invalid signal'}, 400

        if direction not in ['COMPRA', 'VENDA', 'BUY', 'SELL']:
            return {'error': 'Invalid direction'}, 400

        # Normalizar para MT5
        direction = 'BUY' if direction in ['COMPRA', 'BUY'] else 'SELL'

        # Se autoOpen = False, retornar aguardando
        if not autoOpen:
            logger.info(f"⏳ Sinal aguardando aprovação: {asset} {direction}")
            return {
                'ok': False,
                'ticket': None,
                'reason': 'Awaiting approval',
                'action': 'PENDING_APPROVAL'
            }, 202  # 202 = Accepted, processing

        # Abrir posição
        result = open_position(asset, direction, entry, sl, tp, score, risk_percent)

        if result['ok']:
            ticket = result['ticket']
            logger.info(f"✅ Posição aberta: ticket={ticket}")

            # Registra no mapa para o monitor detectar fechamento
            if trade_id and ticket:
                with _ticket_map_lock:
                    _ticket_map[ticket] = {
                        'trade_id':  trade_id,
                        'asset':     asset,
                        'direction': direction,
                        'entry':     entry,
                        'sl':        sl,
                        'tp':        tp,
                        'profit_lock_applied': False,
                        'close_lookup_retries': 0,
                    }
                logger.info(f"🗺️ Mapeado: ticket={ticket} -> trade_id={trade_id}")

            return {
                'ok': True,
                'ticket': ticket,
                'message': f'Position opened: {asset} {direction}',
                'entry': result['entry_actual'],
                'size': result['size'],
            }, 200
        else:
            logger.error(f"❌ Erro ao abrir posição: {result['error']}")
            return {
                'ok': False,
                'error': result['error'],
                'action': 'REJECTED'
            }, 400

    except Exception as e:
        logger.error(f"❌ Webhook exception: {str(e)}")
        return {'error': str(e)}, 500

# ─── CANCELAR TRADE ───────────────────────────────────────────────────
@app.route('/webhook/cancel', methods=['POST'])
def cancel_trade():
    """Cancela trade aberto via webhook"""
    try:
        data = request.get_json()
        ticket = data.get('ticket')

        if not ticket:
            return {'error': 'No ticket'}, 400

        # Fechar posição
        position = mt5.positions_get(ticket=ticket)
        if not position:
            return {'error': 'Position not found'}, 404

        pos = position[0]
        order_type = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY

        # Resolve symbol_info do simbolo da posicao para escolher filling mode
        # suportado pelo broker (FOK / IOC / RETURN). Sem isso, _get_filling_mode
        # estourava NameError e o cancelamento falhava sempre.
        symbol_info = mt5.symbol_info(pos.symbol)
        if not symbol_info:
            return {'ok': False, 'error': f'Cannot get symbol info: {pos.symbol}'}, 400

        request_order = {
            'action': mt5.TRADE_ACTION_DEAL,
            'symbol': pos.symbol,
            'volume': pos.volume,
            'type': order_type,
            'position': ticket,
            'deviation': 10,
            'magic': 123456,
            'comment': f'Closed via webhook: {ticket}',
            'type_time': mt5.ORDER_TIME_GTC,
            'type_filling': _get_filling_mode(symbol_info),
        }

        result = mt5.order_send(request_order)
        if result and result.retcode == mt5.TRADE_RETCODE_DONE:
            logger.info(f"🛑 Trade {ticket} fechado via webhook")
            return {'ok': True, 'message': f'Position {ticket} closed'}, 200
        else:
            return {'ok': False, 'error': result.comment if result else 'Unknown'}, 400

    except Exception as e:
        logger.error(f"Erro ao cancelar: {str(e)}")
        return {'error': str(e)}, 500

# ─── ABRIR POSIÇÃO ───────────────────────────────────────────────────

def _get_filling_mode(symbol_info):
    """
    Retorna o filling mode suportado pelo broker para o simbolo.
    Testa na ordem: FOK -> IOC -> RETURN.
    A propriedade filling_mode e um bitmask:
      bit 0 (1) = FOK, bit 1 (2) = IOC, bit 2 (4) = RETURN
    """
    fm = getattr(symbol_info, 'filling_mode', 0)
    if fm & 1:   return mt5.ORDER_FILLING_FOK
    if fm & 2:   return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_RETURN


def open_position(symbol: str, direction: str, entry: float, sl: float, tp: float, score: float, risk_percent: float = None):
    """
    Abre posição no MT5 com gestão de risco automática

    Returns:
    {
        'ok': True/False,
        'ticket': número do ticket ou None,
        'error': mensagem de erro ou None,
        'size': lotes abertos,
        'entry_actual': preço real de entrada,
    }
    """

    try:
        # Verificar MT5 conectado
        if not mt5.account_info():
            return {'ok': False, 'error': 'MT5 not connected', 'ticket': None}

        # Selecionar símbolo
        if not mt5.symbol_select(symbol, True):
            return {'ok': False, 'error': f'Symbol not found: {symbol}', 'ticket': None}

        symbol_info = mt5.symbol_info(symbol)
        if not symbol_info:
            return {'ok': False, 'error': f'Cannot get symbol info: {symbol}', 'ticket': None}

        # Calcular tamanho baseado em risco (tier por score)
        # risk_percent vem do server.js: 0.50 / 0.75 / 1.00
        # Se não enviado, usa EQUITY_RISK_PERCENT do .env como fallback
        account = mt5.account_info()
        equity = account.equity
        effective_risk = risk_percent if risk_percent is not None else EQUITY_RISK_PERCENT
        effective_risk = max(0.1, min(effective_risk, MAX_POSITION_SIZE * 2))  # sanidade
        risk_amount = equity * (effective_risk / 100)
        point_risk = abs(entry - sl)

        if point_risk > 0:
            # Fórmula correta:
            #   ticks_at_risk    = point_risk / tick_size
            #   risk_per_lot     = ticks_at_risk * tick_value  (em moeda da conta)
            #   lot_size         = risk_amount / risk_per_lot
            # Simplificado:
            #   lot_size = risk_amount * tick_size / (tick_value * point_risk)
            tick_size  = symbol_info.trade_tick_size  if symbol_info.trade_tick_size  > 0 else 0.01
            tick_value = symbol_info.trade_tick_value if symbol_info.trade_tick_value > 0 else 0.01
            lot_size = (risk_amount * tick_size) / (tick_value * point_risk)
            lot_size = min(lot_size, MAX_POSITION_SIZE)
            lot_size = max(lot_size, symbol_info.volume_min)
            # Arredonda para o step permitido pelo broker
            step = symbol_info.volume_step if symbol_info.volume_step > 0 else 0.01
            lot_size = round(round(lot_size / step) * step, 2)
        else:
            lot_size = symbol_info.volume_min

        logger.info(f"📊 Cálculo: Equity={equity:.2f}, Risk={effective_risk:.2f}% ({risk_amount:.2f}), Lots={lot_size}")

        # Preparar request
        action = mt5.TRADE_ACTION_DEAL
        order_type = mt5.ORDER_TYPE_BUY if direction == 'BUY' else mt5.ORDER_TYPE_SELL

        request_order = {
            'action': action,
            'symbol': symbol,
            'volume': lot_size,
            'type': order_type,
            'price': entry,
            'sl': sl,
            'tp': tp,
            'deviation': 10,
            'magic': 123456,
            'comment': f'Webhook signal (score:{score:.1f})',
            'type_time': mt5.ORDER_TIME_GTC,
            # Filling mode dinamico: alguns brokers (ICMarkets ECN, vivos) recusam
            # FOK e exigem IOC ou RETURN. _get_filling_mode le o bitmask do
            # symbol_info e escolhe o primeiro suportado.
            'type_filling': _get_filling_mode(symbol_info),
        }

        # Validar margem antes de enviar (order_check)
        check = mt5.order_check(request_order)
        if check and check.retcode not in (mt5.TRADE_RETCODE_DONE, 0):
            if check.retcode == mt5.TRADE_RETCODE_NO_MONEY:
                logger.warning(f"Margem insuficiente para {lot_size:.2f} lots. Tentando volume minimo: {symbol_info.volume_min}")
                lot_size = symbol_info.volume_min
                request_order['volume'] = lot_size
                check2 = mt5.order_check(request_order)
                if check2 and check2.retcode not in (mt5.TRADE_RETCODE_DONE, 0):
                    return {'ok': False, 'error': f'No margin even for volume_min: {check2.comment}', 'ticket': None}
            else:
                return {'ok': False, 'error': f'order_check rejeitou: {check.comment}', 'ticket': None}

        # Enviar order
        result = mt5.order_send(request_order)

        if not result:
            error = mt5.last_error()
            logger.error(f"Order send failed: {error}")
            return {'ok': False, 'error': str(error), 'ticket': None}

        if result.retcode != mt5.TRADE_RETCODE_DONE:
            logger.error(f"Order rejected: {result.comment}")
            return {'ok': False, 'error': result.comment, 'ticket': None}

        # ✅ Sucesso
        logger.info(f"✅ Order enviada: ticket={result.order}")

        return {
            'ok': True,
            'ticket': result.order,
            'size': lot_size,
            'entry_actual': result.price if hasattr(result, 'price') else entry,
            'sl_actual': sl,
            'tp_actual': tp,
        }

    except Exception as e:
        logger.error(f"open_position exception: {str(e)}")
        return {'ok': False, 'error': str(e), 'ticket': None}

# ─── HEALTH CHECK ───────────────────────────────────────────────────
@app.route('/config/profit-lock', methods=['GET'])
def get_profit_lock_status():
    if not _is_authorized(request):
        return {'error': 'Unauthorized'}, 401
    cfg = _get_profit_lock_config()
    return jsonify({
        'success': True,
        'profitLockEnabled': cfg['enabled'],
        'triggerPct': cfg['trigger_pct'],
        'securePct': cfg['secure_pct'],
    }), 200


@app.route('/config/profit-lock', methods=['POST'])
def set_profit_lock_status():
    if not _is_authorized(request):
        return {'error': 'Unauthorized'}, 401
    data = request.get_json() or {}
    enabled = data.get('enabled')
    if not isinstance(enabled, bool):
        return {'error': '"enabled" must be boolean'}, 400
    cfg = _update_profit_lock_config(enabled=enabled)
    logger.info(
        f"Profit lock {'LIGADO' if cfg['enabled'] else 'DESLIGADO'} "
        f"(trigger={cfg['trigger_pct']:.0%} secure={cfg['secure_pct']:.0%})"
    )
    return jsonify({
        'success': True,
        'profitLockEnabled': cfg['enabled'],
        'triggerPct': cfg['trigger_pct'],
        'securePct': cfg['secure_pct'],
    }), 200


@app.route('/health', methods=['GET'])
def health_check():
    try:
        account = mt5.account_info()
        return jsonify({
            'status': 'OK',
            'mt5_connected': bool(account),
            'account': {
                'equity': account.equity if account else 0,
                'balance': account.balance if account else 0,
                'free_margin': account.margin_free if account else 0,
            } if account else None,
            'timestamp': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        }), 200
    except Exception as e:
        return {'status': 'ERROR', 'message': str(e)}, 500

# ─── STATUS ───────────────────────────────────────────────────────
@app.route('/status', methods=['GET'])
def status():
    try:
        account = mt5.account_info()
        positions = mt5.positions_get() or []
        cfg = _get_profit_lock_config()

        return jsonify({
            'bot_status': 'OK' if account else 'DISCONNECTED',
            'account': {
                'equity': account.equity,
                'balance': account.balance,
                'free_margin': account.margin_free,
                'open_positions': len(positions) if positions else 0,
            } if account else None,
            'profit_lock': {
                'enabled': cfg['enabled'],
                'triggerPct': cfg['trigger_pct'],
                'securePct': cfg['secure_pct'],
            },
            'positions': [{
                'ticket': p.ticket,
                'symbol': p.symbol,
                'type': 'BUY' if p.type == mt5.ORDER_TYPE_BUY else 'SELL',
                'volume': p.volume,
                'price_open': p.price_open,
                'price_current': p.price_current,
                'sl': p.sl,
                'tp': p.tp,
                'profit': p.profit,
            } for p in positions],
            'timestamp': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        }), 200
    except Exception as e:
        return {'error': str(e)}, 500


@app.route('/position-close/<int:ticket>', methods=['GET'])
def get_position_close(ticket):
    if not _is_authorized(request):
        return {'error': 'Unauthorized'}, 401
    try:
        deal = _find_close_deal_for_ticket(ticket)
        if not deal:
            return jsonify({'found': False, 'deal': None}), 200
        return jsonify({
            'found': True,
            'deal': {
                'ticket': int(getattr(deal, 'ticket', 0)),
                'position_id': int(getattr(deal, 'position_id', 0)),
                'price': float(getattr(deal, 'price', 0)),
                'volume': float(getattr(deal, 'volume', 0)),
                'profit': float(getattr(deal, 'profit', 0)),
                'symbol': str(getattr(deal, 'symbol', '')),
                'reason': int(getattr(deal, 'reason', -1)),
                'time': datetime.utcfromtimestamp(deal.time).isoformat() if hasattr(deal, 'time') else None,
                'comment': str(getattr(deal, 'comment', '')),
            }
        }), 200
    except Exception as e:
        return {'error': str(e)}, 500


# ─── HISTÓRICO DE DEALS (para comparação com dashboard) ──────────────────────
@app.route('/history/deals', methods=['GET'])
def get_history_deals():
    """
    Retorna deals de SAÍDA (entry=OUT) fechados nas últimas N horas.
    Usado pelo dashboard admin para comparar com o histórico interno.

    Query params:
      hours (int, default=168): janela de busca em horas (máx 720 = 30 dias)

    Resposta:
    {
      "success": true,
      "hours": 168,
      "count": 42,
      "deals": [
        {
          "ticket": 12345,
          "position_id": 12340,
          "symbol": "EURUSD",
          "type": 1,           // 0=BUY, 1=SELL
          "direction": "SELL",
          "price": 1.16801,
          "volume": 0.05,
          "profit": 34.5,
          "commission": -0.5,
          "swap": 0.0,
          "reason": 3,         // 3=TP, 4=SL, outros=MANUAL/BROKER
          "outcome": "TP",     // label legível
          "time_iso": "2026-05-14T14:59:00Z",
          "comment": ""
        },
        ...
      ]
    }
    """
    if not _is_authorized(request):
        return {'error': 'Unauthorized'}, 401

    try:
        hours = min(int(request.args.get('hours', 168)), 720)
        dt_from = datetime.now() - timedelta(hours=hours)
        dt_to   = datetime.now() + timedelta(minutes=1)

        deals_raw = mt5.history_deals_get(dt_from, dt_to) or []

        result = []
        for deal in deals_raw:
            # Só deals de saída (fechamento de posição)
            if getattr(deal, 'entry', None) != mt5.DEAL_ENTRY_OUT:
                continue

            reason = int(getattr(deal, 'reason', -1))
            if reason == mt5.DEAL_REASON_TP:
                outcome = 'TP'
            elif reason == mt5.DEAL_REASON_SL:
                outcome = 'SL'
            elif reason in (mt5.DEAL_REASON_CLIENT, mt5.DEAL_REASON_MOBILE, mt5.DEAL_REASON_WEB):
                outcome = 'MANUAL'
            else:
                outcome = 'OTHER'

            deal_type = int(getattr(deal, 'type', -1))
            direction = 'BUY' if deal_type == mt5.DEAL_TYPE_BUY else 'SELL'

            result.append({
                'ticket':      int(getattr(deal, 'ticket',      0)),
                'position_id': int(getattr(deal, 'position_id', 0)),
                'symbol':      str(getattr(deal, 'symbol',      '')),
                'type':        deal_type,
                'direction':   direction,
                'price':       float(getattr(deal, 'price',      0.0)),
                'volume':      float(getattr(deal, 'volume',     0.0)),
                'profit':      float(getattr(deal, 'profit',     0.0)),
                'commission':  float(getattr(deal, 'commission', 0.0)),
                'swap':        float(getattr(deal, 'swap',       0.0)),
                'reason':      reason,
                'outcome':     outcome,
                'time_iso':    _to_utc_iso_from_deal(deal),
                'comment':     str(getattr(deal, 'comment',     '')),
            })

        # Ordena do mais recente ao mais antigo
        result.sort(key=lambda d: d['time_iso'], reverse=True)

        return jsonify({
            'success': True,
            'hours':   hours,
            'count':   len(result),
            'deals':   result,
        }), 200

    except Exception as e:
        logger.error(f"Erro em /history/deals: {e}")
        return {'success': False, 'error': str(e)}, 500


# ----------------------------------------------------------------
if __name__ == '__main__':
    logger.info(f'Bot webhook receiver iniciando na porta {BOT_PORT}...')

    # Inicializar MT5
    if not mt5.initialize(login=MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER):
        logger.error(f'Falha ao inicializar MT5: {mt5.last_error()}')
    else:
        logger.info('MT5 inicializado com sucesso')
        account = mt5.account_info()
        if account:
            logger.info(f'Conta MT5: {account.login} | Equity: {account.equity} | Balance: {account.balance}')

    # Iniciar thread de monitor de posicoes
    monitor_thread = threading.Thread(target=_monitor_positions, daemon=True)
    monitor_thread.start()
    logger.info('Thread de monitor de posicoes iniciada')

    # Iniciar servidor Flask
    app.run(host='0.0.0.0', port=BOT_PORT, debug=False, use_reloader=False)
