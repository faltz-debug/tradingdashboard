#!/usr/bin/env python3
"""
MT5 Feed Sync - Sincroniza candles do MT5 com o Dashboard em tempo real
Busca histórico de candles e atualiza mt5_feed.json continuamente
"""

import MetaTrader5 as mt5
import json
import time
import os
from datetime import datetime, timedelta
from dotenv import load_dotenv
import logging

# ─── CONFIG ───────────────────────────────────────────────────────
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s'
)
logger = logging.getLogger(__name__)

MT5_LOGIN = int(os.getenv('MT5_LOGIN', '12345'))
MT5_PASSWORD = os.getenv('MT5_PASSWORD', '')
MT5_SERVER = os.getenv('MT5_SERVER', 'ICMarketsSC-Demo')
FEED_FILE = os.path.join(os.path.dirname(__file__), 'data', 'mt5_feed.json')
SYNC_INTERVAL = 5  # segundos

# Símbolos e timeframes que queremos sincronizar
# BTCUSD removido: o server.js usa Kraken WebSocket para BTC (mais rápido e confiável)
SYMBOLS_TIMEFRAMES = {
    'XAUUSD': ['M15', 'H1', 'H4', 'D1'],
    'EURUSD': ['M15', 'H1', 'H4', 'D1'],
    'USDJPY': ['M15', 'H1', 'H4', 'D1'],
}

# Quantidade de candles a buscar
# Margem de +15 para compensar possíveis candles filtrados pelo validateCandles
# (mínimo exigido pelo computeVipSignal: M15>=55, H1/H4/D1>=30)
CANDLES_NEEDED = {
    'M15': 70,
    'H1': 45,
    'H4': 45,
    'D1': 45,
}

# Garantir que a pasta data existe
os.makedirs(os.path.dirname(FEED_FILE), exist_ok=True)

# ─── INICIALIZAR MT5 ───────────────────────────────────────────────
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

# ─── BUSCAR CANDLES DO MT5 ───────────────────────────────────────
def get_candles(symbol, timeframe, count):
    """Busca últimos N candles do MT5"""
    try:
        if not mt5.symbol_select(symbol, True):
            logger.warning(f"⚠️  {symbol} não encontrado")
            return None

        # Converter timeframe Python para MT5
        tf_map = {
            'M15': mt5.TIMEFRAME_M15,
            'H1': mt5.TIMEFRAME_H1,
            'H4': mt5.TIMEFRAME_H4,
            'D1': mt5.TIMEFRAME_D1,
        }

        candles = mt5.copy_rates_from_pos(symbol, tf_map[timeframe], 0, count)
        if candles is None or len(candles) == 0:
            return None

        # Converter para lista de dicts
        result = []
        for candle in candles:
            result.append({
                'time': int(candle[0]),
                'open': float(candle[1]),
                'high': float(candle[2]),
                'low': float(candle[3]),
                'close': float(candle[4]),
                'tick_volume': int(candle[5]),
            })

        return result

    except Exception as e:
        logger.error(f"Error fetching {symbol} {timeframe}: {str(e)}")
        return None

# ─── COLETAR TODOS OS DADOS DO MT5 ───────────────────────────────
def collect_all_mt5_data():
    """Coleta candles de todos os símbolos e timeframes"""
    try:
        account = mt5.account_info()
        if not account:
            return None

        # Dicionário para armazenar dados dos ativos
        assets = {}

        # Buscar candles para cada símbolo
        for symbol, timeframes in SYMBOLS_TIMEFRAMES.items():
            symbol_lower = symbol.lower()
            assets[symbol_lower] = {
                'candles': {},
                'symbol': symbol,
                'mode': 'MT5_SYNCED',
                'isLive': True,
            }

            for tf in timeframes:
                candle_count = CANDLES_NEEDED[tf]
                candles = get_candles(symbol, tf, candle_count)

                # Converter timeframe para formato esperado pelo dashboard (M15→15m, H1→1h, H4→4h, D1→daily)
                tf_map = {'M15': '15m', 'H1': '1h', 'H4': '4h', 'D1': 'daily'}
                tf_key = tf_map.get(tf, tf.lower())

                if candles:
                    assets[symbol_lower]['candles'][tf_key] = candles
                    logger.info(f"✅ {symbol} {tf}: {len(candles)} candles")
                else:
                    assets[symbol_lower]['candles'][tf_key] = []
                    logger.warning(f"⚠️  {symbol} {tf}: sem candles")

        # Posições abertas
        positions = mt5.positions_get()
        pos_list = []
        if positions:
            for pos in positions:
                pos_list.append({
                    'ticket': pos.ticket,
                    'symbol': pos.symbol,
                    'type': 'BUY' if pos.type == mt5.ORDER_TYPE_BUY else 'SELL',
                    'volume': pos.volume,
                    'price_open': float(pos.price_open),
                    'price_current': float(pos.price_current),
                    'sl': float(pos.sl) if pos.sl else None,
                    'tp': float(pos.tp) if pos.tp else None,
                    'profit': float(pos.profit),
                    'time_open': pos.time,
                    'comment': pos.comment,
                })

        # Extrair preço atual de cada ativo via tick real do MT5
        for symbol_lower, asset_data in assets.items():
            symbol = asset_data['symbol']
            tick = mt5.symbol_info_tick(symbol)
            last_candle_15m = asset_data['candles'].get('15m', [])
            last_close = float(last_candle_15m[-1]['close']) if last_candle_15m else None

            if tick:
                bid = float(tick.bid)
                ask = float(tick.ask)
                mid = round((bid + ask) / 2, 8)
                spread = round(ask - bid, 8)
                asset_data['price'] = mid
                asset_data['bid']   = bid
                asset_data['ask']   = ask
                asset_data['spread'] = spread
                asset_data['tick'] = {
                    'bid':   bid,
                    'ask':   ask,
                    'last':  float(tick.last) if tick.last else mid,
                    'time':  int(tick.time * 1000),
                }
            elif last_close is not None:
                # Fallback: usar close do último candle (sem spread real)
                asset_data['price'] = last_close
                asset_data['bid']   = last_close
                asset_data['ask']   = last_close
                asset_data['spread'] = 0
                asset_data['tick'] = {
                    'bid': last_close, 'ask': last_close, 'last': last_close,
                    'time': int(last_candle_15m[-1]['time'] * 1000),
                }

        # Montando resposta final (estrutura esperada pelo dashboard)
        data = {
            'generatedAt': int(time.time() * 1000),  # Timestamp em ms
            'connected': True,
            'account': {
                'login': account.login,
                'balance': float(account.balance),
                'equity': float(account.equity),
                'free_margin': float(account.margin_free),
                'used_margin': float(account.margin),
                'margin_level': float(account.margin_level) if account.margin_level else 0,
                'currency': account.currency,
                'server': account.server,
                'company': account.company,
            },
            'assets': assets,
            'positions': pos_list,
            'position_count': len(pos_list),
        }

        return data

    except Exception as e:
        logger.error(f"Error collecting MT5 data: {str(e)}")
        return None

# ─── SALVAR DADOS NO ARQUIVO ───────────────────────────────────────
def save_feed_data(data):
    """Salva dados em mt5_feed.json via escrita atômica (tmp → rename).
    Evita que o Node.js leia um arquivo parcialmente escrito ou corrompido
    com bytes nulos remanescentes de gravações anteriores.
    """
    try:
        tmp_file = FEED_FILE + '.tmp'
        with open(tmp_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_file, FEED_FILE)  # operação atômica no Windows e Linux
        return True
    except Exception as e:
        logger.error(f"Error saving feed file: {str(e)}")
        return False

# ─── LOOP PRINCIPAL ───────────────────────────────────────────────
def main():
    logger.info("🔄 MT5 Feed Sync iniciado...")
    logger.info(f"📁 Salvando em: {FEED_FILE}")
    logger.info(f"⏱️  Intervalo de sincronização: {SYNC_INTERVAL}s")
    logger.info(f"📊 Símbolos: {', '.join(SYMBOLS_TIMEFRAMES.keys())}")

    if not init_mt5():
        logger.error("❌ Falha ao conectar MT5. Abra MetaTrader 5 primeiro!")
        return

    sync_count = 0
    error_count = 0

    try:
        while True:
            try:
                # Coletar dados
                data = collect_all_mt5_data()

                if data:
                    # Salvar dados
                    if save_feed_data(data):
                        sync_count += 1
                        pos_count = data.get('position_count', 0)
                        equity = data['account']['equity']
                        balance = data['account']['balance']

                        if sync_count % 12 == 0:  # Log a cada 60 segundos
                            logger.info(
                                f"✅ Sync #{sync_count} | "
                                f"Posições: {pos_count} | "
                                f"Equity: {equity:.2f} | "
                                f"Balance: {balance:.2f}"
                            )
                        error_count = 0
                else:
                    error_count += 1
                    logger.warning(f"⚠️  Falha ao coletar dados (tentativa {error_count})")

                    if error_count > 5:
                        logger.error("❌ Muitos erros. Reconectando ao MT5...")
                        mt5.shutdown()
                        if not init_mt5():
                            logger.error("❌ Falha ao reconectar. Aguardando...")
                            time.sleep(10)
                        error_count = 0

            except Exception as e:
                logger.error(f"❌ Erro no loop: {str(e)}")
                error_count += 1
                time.sleep(SYNC_INTERVAL)
                continue

            # Aguardar antes da próxima sincronização
            time.sleep(SYNC_INTERVAL)

    except KeyboardInterrupt:
        logger.info("\n🛑 MT5 Feed Sync encerrado pelo usuário")
    except Exception as e:
        logger.error(f"❌ Erro fatal: {str(e)}")
    finally:
        mt5.shutdown()
        logger.info("👋 MT5 desconectado")

if __name__ == '__main__':
    main()
