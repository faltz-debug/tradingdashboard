'use strict';

/**
 * FILTERS — Funções de filtro e contexto para o motor de sinal VIP.
 *
 * Funções puras: mesma entrada → mesma saída, sem I/O, sem cache global.
 * Dependência: calcEMA importado de ./indicators.
 */

const { calcEMA } = require('./indicators');
const {
  ASSET_FORBIDDEN_SESSIONS,
  ASSET_FORBIDDEN_DIRECTIONS,
  BLOCKED_HOURS_UTC,
} = require('./state');

// ─── HARD-BLOCK FILTERS (executam ANTES do scoring) ──────────────────────────

/**
 * Simplifica o objeto de sessoes ativas em um label canonico.
 * Aceita o objeto retornado por getCurrentSessions() em context.js.
 */
function simplifySession(sessions = {}) {
  if (sessions.overlap)               return 'Overlap';
  if (sessions.london && sessions.ny) return 'London+NY';
  if (sessions.ny  && !sessions.london) return 'NY';
  if (sessions.london && sessions.tokyo) return 'Tokyo+London';
  if (sessions.london)                return 'London';
  if (sessions.tokyo)                 return 'Tokyo';
  return 'NoSession';
}

/**
 * true se a hora UTC atual estiver na lista bloqueada (state.BLOCKED_HOURS_UTC).
 * Pode ser desativado temporariamente via setHourBlockOverride(true) — usado
 * pelo admin panel para testar em horários normalmente bloqueados.
 */
let _hourBlockOverride = false;
function setHourBlockOverride(val) { _hourBlockOverride = !!val; }
function getHourBlockOverride()    { return _hourBlockOverride; }

function isHourBlocked(now = new Date()) {
  if (_hourBlockOverride) return false;
  return BLOCKED_HOURS_UTC.includes(now.getUTCHours());
}

/**
 * true se o combo ativo+sessao (label simplificado) estiver na lista negra.
 * Quando _hourBlockOverride=true (override manual ativo), retorna false para
 * que o scanner mostre sinais reais mesmo em sessões historicamente bloqueadas.
 */
function isSessionForbidden(assetKey, sessions) {
  if (_hourBlockOverride) return false; // override ativo — ignora todos os bloqueios de sessão
  const list = ASSET_FORBIDDEN_SESSIONS[assetKey];
  if (!list || !list.length) return false;
  return list.includes(simplifySession(sessions));
}

/**
 * true se a direcao foi historicamente destrutiva neste ativo.
 * Quando _hourBlockOverride=true (override manual ativo), retorna false
 * para permitir visualização irrestrita do sinal no scanner.
 */
function isDirectionForbidden(assetKey, direction) {
  if (_hourBlockOverride) return false; // override ativo — ignora bloqueios de direção
  const list = ASSET_FORBIDDEN_DIRECTIONS[assetKey];
  if (!list || !list.length) return false;
  return list.includes(direction);
}

// ─── EMA ALIGNMENT ───────────────────────────────────────────────────────────

function emaAligned(closes, direction) {
  const ema9  = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  if (!ema9 || !ema20 || !ema50) return false;
  if (direction === 'BUY')  return ema9 > ema20 && ema20 > ema50;
  if (direction === 'SELL') return ema9 < ema20 && ema20 < ema50;
  return false;
}

// ─── BREAKOUT ────────────────────────────────────────────────────────────────

function hasBreakout(candles, direction, bars = 20) {
  if (candles.length < bars + 1) return false;
  const lookback = candles.slice(candles.length - bars - 1, candles.length - 1);
  const last = candles[candles.length - 1];
  if (direction === 'BUY')  return last.close > Math.max(...lookback.map(c => c.high));
  if (direction === 'SELL') return last.close < Math.min(...lookback.map(c => c.low));
  return false;
}

// ─── INSIDE BAR ──────────────────────────────────────────────────────────────

function hasInsideBar(candles, direction) {
  if (candles.length < 3) return false;
  const mother  = candles[candles.length - 3];
  const inside  = candles[candles.length - 2];
  const confirm = candles[candles.length - 1];

  const isInsideBar = inside.high < mother.high && inside.low > mother.low;
  if (!isInsideBar) return false;

  if (direction === 'BUY')  return confirm.close > inside.high;
  if (direction === 'SELL') return confirm.close < inside.low;
  return false;
}

// ─── VOLUME CONFIRMATION ─────────────────────────────────────────────────────

function hasVolumeConfirmation(candles, multiplier = 1.1) {
  if (candles.length < 21) return null;
  const current = candles[candles.length - 1];
  if (!current.volume || current.volume === 0) return null;
  const lookback = candles.slice(-21, -1);
  const avgVol = lookback.reduce((sum, c) => sum + (c.volume || 0), 0) / lookback.length;
  if (avgVol === 0) return null;
  return current.volume >= avgVol * multiplier;
}

// ─── BOLLINGER SQUEEZE ───────────────────────────────────────────────────────

function hasBollingerSqueeze(closes, period = 20, lookbackWindows = 20) {
  if (closes.length < period + lookbackWindows) return false;

  const widths = [];
  for (let i = 0; i <= lookbackWindows; i++) {
    const end   = closes.length - i;
    const start = end - period;
    if (start < 0) break;
    const slice = closes.slice(start, end);
    const sma   = slice.reduce((a, b) => a + b, 0) / period;
    if (sma === 0) { widths.push(0); continue; }
    const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
    const std = Math.sqrt(variance);
    widths.push((4 * std) / sma);
  }

  if (widths.length < 2) return false;
  const currentWidth = widths[0];
  const avgWidth = widths.slice(1).reduce((a, b) => a + b, 0) / (widths.length - 1);

  return currentWidth > 0 && avgWidth > 0 && currentWidth < avgWidth * 0.90;
}

// ─── EMA 200 CONTEXT ─────────────────────────────────────────────────────────

function getEma200Context(candles, direction) {
  if (!candles || candles.length < 200) return null;
  const closes = candles.map(c => c.close);
  const ema200 = calcEMA(closes, 200);
  const price  = closes[closes.length - 1];
  const aligned = direction === 'BUY' ? price > ema200 : price < ema200;
  return { ema200: parseFloat(ema200.toFixed(2)), aligned };
}

// ─── PULLBACK EMA20 ──────────────────────────────────────────────────────────

function hasPullbackEma20(candles, direction) {
  if (candles.length < 3) return false;

  const closes = candles.map(c => c.close);
  const ema9  = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);

  const alignedBuy  = ema9 > ema20 && ema20 > ema50;
  const alignedSell = ema9 < ema20 && ema20 < ema50;
  if (direction === 'BUY'  && !alignedBuy)  return false;
  if (direction === 'SELL' && !alignedSell) return false;

  const prev  = candles[candles.length - 2];
  const prevCloses = closes.slice(0, -1);
  const ema20prev  = calcEMA(prevCloses, 20);
  const touchedEma20 = Math.abs(prev.close - ema20prev) / (ema20prev || 1) < 0.008
                    || Math.abs(prev.low   - ema20prev) / (ema20prev || 1) < 0.008
                    || Math.abs(prev.high  - ema20prev) / (ema20prev || 1) < 0.008;

  if (!touchedEma20) return false;

  const curr      = candles[candles.length - 1];
  const bodySize  = Math.abs(curr.close - curr.open);
  const range     = curr.high - curr.low;
  const strongBody = range > 0 && bodySize / range >= 0.5;

  if (direction === 'BUY')  return curr.close > curr.open && curr.close > ema9 && strongBody;
  if (direction === 'SELL') return curr.close < curr.open && curr.close < ema9 && strongBody;
  return false;
}

// ─── CME GAP ─────────────────────────────────────────────────────────────────

function detectCMEGap(candles) {
  if (!candles || candles.length < 10) return null;

  let fridayClose = null;
  let sundayOpen  = null;

  for (let i = candles.length - 1; i >= 0; i--) {
    const c  = candles[i];
    const ts = typeof c.timestamp === 'number' ? c.timestamp : (c.time ? c.time * 1000 : null);
    if (!ts) continue;
    const d   = new Date(ts);
    const day = d.getUTCDay();
    const hr  = d.getUTCHours();

    if (day === 5 && hr >= 20 && hr <= 22 && !fridayClose) {
      fridayClose = { price: c.close, ts };
    }
    if (day === 0 && hr >= 22 && !sundayOpen) {
      sundayOpen = { price: c.open ?? c.close, ts };
    }

    if (fridayClose && sundayOpen) break;
  }

  if (!fridayClose || !sundayOpen) return null;
  if (fridayClose.ts >= sundayOpen.ts) return null;

  const gapSize = sundayOpen.price - fridayClose.price;
  const gapPct  = (gapSize / fridayClose.price) * 100;

  if (Math.abs(gapPct) < 0.3) return null;

  const currentPrice    = candles[candles.length - 1].close;
  const gapDirection    = gapSize > 0 ? 'UP' : 'DOWN';
  const fillerDirection = gapDirection === 'DOWN' ? 'BUY' : 'SELL';

  const gapFilled = gapDirection === 'UP'
    ? currentPrice <= fridayClose.price
    : currentPrice >= fridayClose.price;

  return {
    gapSize:          parseFloat(gapSize.toFixed(2)),
    gapPct:           parseFloat(gapPct.toFixed(2)),
    gapDirection,
    fillerDirection,
    fridayClose:      fridayClose.price,
    sundayOpen:       sundayOpen.price,
    fillTarget:       fridayClose.price,
    gapFilled,
    alignedWithSignal: null,
  };
}

// ─── BIAS (EMA 9/20/50) ──────────────────────────────────────────────────────

function getBiasTf(candles) {
  if (!candles || candles.length < 30) return 'NEUTRAL';
  const closes = candles.map(c => c.close);
  const ema9   = calcEMA(closes, 9);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  if (ema9 > ema20 && ema20 > ema50) return 'BUY';
  if (ema9 < ema20 && ema20 < ema50) return 'SELL';
  return 'NEUTRAL';
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  emaAligned,
  hasBreakout,
  hasInsideBar,
  hasVolumeConfirmation,
  hasBollingerSqueeze,
  getEma200Context,
  hasPullbackEma20,
  detectCMEGap,
  getBiasTf,
  // Hard-block helpers
  simplifySession,
  isHourBlocked,
  isSessionForbidden,
  isDirectionForbidden,
  setHourBlockOverride,
  getHourBlockOverride,
};
