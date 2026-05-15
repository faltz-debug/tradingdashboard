'use strict';

/**
 * MARKET CONTEXT — Contexto externo de mercado (DXY e Fear & Greed).
 *
 * Este módulo contém funções assíncronas que buscam dados externos e mantêm
 * cache local para evitar rate-limits. Diferente dos módulos indicators.js e
 * filters.js (funções puras), este módulo tem estado (caches em memória) e
 * efeitos colaterais (chamadas HTTP via axios).
 *
 * Funções exportadas:
 *   - fetchDxyTrend(direction)        → Promise<{ dxyTrend, xauAligned, ... } | null>
 *   - fetchFearGreedIndex(direction)  → Promise<{ value, aligned, ... } | null>
 *
 * Dependências:
 *   - axios             (HTTP)
 *   - calcEMA           (src/services/indicators.js)
 *   - logger            (logger.js na raiz)
 *   - TWELVE_DATA_KEY   (lida de process.env.TWELVE_DATA_KEY)
 */

const axios  = require('axios');
const { calcEMA } = require('./indicators');
const logger = require('../../logger');

const TWELVE_DATA_KEY = process.env.TWELVE_DATA_KEY || 'COLE_SUA_CHAVE_AQUI';

// ─── DXY (Dollar Index) ───────────────────────────────────────────────────────

/**
 * CONTEXTO — DXY (Dollar Index) como filtro inverso para XAU/USD
 *
 * O ouro (XAU/USD) tem correlação inversa muito alta com o Dollar Index (~-0.80).
 * DXY subindo forte = pressão vendedora no ouro, mesmo que indicadores técnicos apontem BUY.
 * DXY caindo = vento a favor para compras de XAU.
 *
 * Busca dados do DXY via Twelve Data (símbolo "DX-Y.NYB") ou Yahoo Finance ("DX-Y.NYB").
 * Calcula a direção do DXY pela alinhação EMA 9/20/50 no 15m.
 *
 * Retorna:
 *   dxyTrend:   'UP' | 'DOWN' | 'NEUTRAL'
 *   xauAligned: true se DXY confirma a direção do sinal XAU (DXY DOWN + XAU BUY, etc.)
 *   warning:    string de aviso quando DXY vai contra o sinal
 */
const _dxyCache = { data: null, updatedAt: 0 };
const DXY_CACHE_TTL = 15 * 60 * 1000;  // 15 minutos

async function fetchDxyTrend(direction) {
  try {
    const now = Date.now();

    // Usa cache se fresco
    if (_dxyCache.data && (now - _dxyCache.updatedAt) < DXY_CACHE_TTL) {
      return _buildDxyResult(_dxyCache.data, direction);
    }

    let closes = null;

    // Tenta Twelve Data primeiro (timeout reduzido — falha rápida se offline)
    if (TWELVE_DATA_KEY && TWELVE_DATA_KEY !== 'COLE_SUA_CHAVE_AQUI') {
      try {
        const res = await axios.get('https://api.twelvedata.com/time_series', {
          params: { symbol: 'DX-Y.NYB', interval: '15min', outputsize: 60, apikey: TWELVE_DATA_KEY },
          timeout: 2000,
        });
        if (res.data?.values?.length >= 20) {
          closes = res.data.values.reverse().map(v => parseFloat(v.close));
        }
      } catch (_) { /* fallthrough para Yahoo */ }
    }

    // Fallback: Yahoo Finance (timeout reduzido)
    if (!closes) {
      try {
        const res = await axios.get(
          'https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB',
          { params: { interval: '15m', range: '5d' }, timeout: 2000 }
        );
        const result = res.data?.chart?.result?.[0];
        const rawCloses = result?.indicators?.quote?.[0]?.close;
        if (rawCloses?.length >= 20) {
          closes = rawCloses.filter(v => v != null);
        }
      } catch (_) { /* sem dados */ }
    }

    if (!closes || closes.length < 20) {
      // Cacheia a falha por 5 minutos — evita retry a cada computeVipSignal
      _dxyCache.updatedAt = now;
      return null;
    }

    _dxyCache.data      = closes;
    _dxyCache.updatedAt = now;
    return _buildDxyResult(closes, direction);

  } catch (err) {
    logger.warn('DXY fetch erro:', err.message);
    return null;
  }
}

function _buildDxyResult(closes, direction) {
  const ema9  = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = closes.length >= 50 ? calcEMA(closes, 50) : null;

  let dxyTrend = 'NEUTRAL';
  if (ema50) {
    if (ema9 > ema20 && ema20 > ema50) dxyTrend = 'UP';
    else if (ema9 < ema20 && ema20 < ema50) dxyTrend = 'DOWN';
  } else {
    if (ema9 > ema20) dxyTrend = 'UP';
    else if (ema9 < ema20) dxyTrend = 'DOWN';
  }

  // Correlação inversa: DXY DOWN = favorável para BUY de XAU
  //                    DXY UP   = favorável para SELL de XAU
  const xauAligned = (direction === 'BUY'  && dxyTrend === 'DOWN')
                  || (direction === 'SELL' && dxyTrend === 'UP');

  const xauOpposing = (direction === 'BUY'  && dxyTrend === 'UP')
                   || (direction === 'SELL' && dxyTrend === 'DOWN');

  return {
    dxyTrend,
    ema9:        parseFloat(ema9.toFixed(3)),
    ema20:       parseFloat(ema20.toFixed(3)),
    xauAligned,
    xauOpposing,
    warning: xauOpposing
      ? `⚠️ DXY em tendência ${dxyTrend === 'UP' ? 'de ALTA' : 'de BAIXA'} — vento contra para ${direction} em XAU`
      : null,
  };
}

// ─── FEAR & GREED INDEX ───────────────────────────────────────────────────────

/**
 * Fear & Greed Index — Alternative.me (API gratuita, sem chave)
 *
 * Escala 0–100:
 *   0–24   Extreme Fear  → mercado sobrevendido → bônus BUY para BTC
 *  25–44   Fear          → contexto levemente bearish
 *  45–55   Neutral       → sem bônus
 *  56–74   Greed         → contexto levemente bullish
 *  75–100  Extreme Greed → mercado sobrecomprado → bônus SELL para BTC
 *
 * Cache de 15 min para evitar rate limit.
 */
const _fngCache = { value: null, classification: null, updatedAt: 0 };
const FNG_CACHE_TTL = 15 * 60 * 1000;  // 15 minutos

async function fetchFearGreedIndex(direction) {
  try {
    const now = Date.now();

    // Retorna do cache se ainda fresco
    if (_fngCache.value !== null && (now - _fngCache.updatedAt) < FNG_CACHE_TTL) {
      return _buildFngResult(_fngCache.value, _fngCache.classification, direction);
    }

    const resp = await axios.get('https://api.alternative.me/fng/?limit=1', {
      timeout: 3000,
      headers: { 'User-Agent': 'TradingDashboard/1.0' },
    });

    const entry = resp.data?.data?.[0];
    if (!entry || entry.value === undefined) {
      logger.warn('Fear & Greed: resposta inesperada da API', resp.data);
      return null;
    }

    const value          = parseInt(entry.value, 10);
    const classification = entry.value_classification || '';

    _fngCache.value          = value;
    _fngCache.classification = classification;
    _fngCache.updatedAt      = now;

    return _buildFngResult(value, classification, direction);
  } catch (err) {
    logger.warn(`Fear & Greed fetch falhou: ${err.message}`);
    return null;
  }
}

function _buildFngResult(value, classification, direction) {
  const isExtremeFear  = value <= 24;
  const isExtremeGreed = value >= 75;
  const isFear         = value >= 25 && value <= 44;
  const isGreed        = value >= 56 && value <= 74;

  // Bônus: extremos confirmam entradas de reversão / continuação
  const btcBuyAligned  = isExtremeFear;   // medo extremo → BTC sobrevendido → bônus BUY
  const btcSellAligned = isExtremeGreed;  // ganância extrema → BTC sobrecomprado → bônus SELL
  const aligned        = direction === 'BUY'  ? btcBuyAligned
                       : direction === 'SELL' ? btcSellAligned
                       : false;

  // Aviso quando o sentimento opõe a direção do sinal
  const opposing = (direction === 'BUY'  && isExtremeGreed)
                || (direction === 'SELL' && isExtremeFear);

  let emoji = '😐';
  if (isExtremeFear)  emoji = '😱';
  else if (isFear)    emoji = '😰';
  else if (isGreed)   emoji = '😏';
  else if (isExtremeGreed) emoji = '🤑';

  return {
    value,
    classification,
    emoji,
    isExtremeFear,
    isExtremeGreed,
    aligned,   // true → +1 bônus
    opposing,  // true → aviso (sem penalidade)
    warning: opposing
      ? `⚠️ Fear & Greed ${emoji} ${value} (${classification}) — sentimento contra o sinal ${direction}`
      : null,
  };
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  fetchDxyTrend,
  fetchFearGreedIndex,
};
