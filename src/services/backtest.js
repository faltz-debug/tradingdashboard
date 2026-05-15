'use strict';

/**
 * src/services/backtest.js
 *
 * Motor de backtest historico — replica a logica do Master Signal sobre
 * candles passados sem chamadas externas (sem DXY, Fear&Greed, session, news).
 *
 * Unico input: array de candles OHLCV em ordem cronologica.
 * Output:      lista de trades simulados + metricas agregadas.
 *
 * Fidelidade:
 *   - Usa as MESMAS funcoes puras de indicators.js e score.js que o live.
 *   - Aplica slippage de signal-config.js (identico ao live).
 *   - Detecta SL/TP usando high/low das velas subsequentes (sem look-ahead).
 *   - Uma posicao de cada vez por ativo (sem piramidacao).
 */

const {
  calcEMA,
  calcRSI,
  calcADX,
  calcATR,
} = require('./indicators');

const { computeMasterScoreFromSignals } = require('./score');
const MASTER_SIGNAL_CFG = require('../../signal-config');

// Candles minimos antes de comecar a calcular (EMA200 requer 200, usamos 60 p/ rapido)
const MIN_CANDLES_REQUIRED = 60;

// Velas maximas para aguardar SL ou TP apos entrada
const MAX_BARS_IN_TRADE = 96; // 96 x 15min = 24h

/**
 * Calcula o sinal Master em um slice de candles (sem I/O externo).
 * Retorna { score, direction, entry, sl, tp } ou null se dados insuficientes.
 */
function _computeSlice(candles) {
  if (candles.length < MIN_CANDLES_REQUIRED) return null;

  const closes = candles.map(c => c.close);
  const last   = closes[closes.length - 1];

  const ema9  = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const rsi   = calcRSI(closes, 14);

  const trendSig = ema9 > ema20 && ema20 > ema50 ? 'COMPRA'
                 : ema9 < ema20 && ema20 < ema50 ? 'VENDA' : 'NEUTRO';

  const rsiTrendSig = rsi > MASTER_SIGNAL_CFG.rsiBullish ? 'COMPRA'
                    : rsi < MASTER_SIGNAL_CFG.rsiBearish ? 'VENDA' : 'NEUTRO';

  const lookback = MASTER_SIGNAL_CFG.breakoutLookback;
  const prev = candles.slice(-(lookback + 1), -1);
  const bkHigh = prev.length ? Math.max(...prev.map(c => c.high)) : last;
  const bkLow  = prev.length ? Math.min(...prev.map(c => c.low))  : last;
  const bkSig  = last > bkHigh ? 'COMPRA' : last < bkLow ? 'VENDA' : 'AGUARDAR';

  const { adx } = calcADX(candles);
  const isLateral = adx < MASTER_SIGNAL_CFG.adxTrendMin;

  const { score, masterDir } = computeMasterScoreFromSignals({
    trendSig, rsiTrendSig, bkSig, isLateral,
  });

  if (score === 0 || !masterDir) return null;

  const atr   = calcATR(candles);
  if (atr <= 0) return null;

  const slip  = last * (MASTER_SIGNAL_CFG.slippagePct / 100);
  const dir   = masterDir; // 'BUY' | 'SELL'

  let entry, sl, tp;
  if (dir === 'BUY') {
    entry = last + slip;
    sl    = entry - MASTER_SIGNAL_CFG.stopAtrMult * atr;
    tp    = entry + MASTER_SIGNAL_CFG.takeAtrMult * atr;
  } else {
    entry = last - slip;
    sl    = entry + MASTER_SIGNAL_CFG.stopAtrMult * atr;
    tp    = entry - MASTER_SIGNAL_CFG.takeAtrMult * atr;
  }

  return { score, direction: dir, entry, sl, tp, atr, rsi, adx };
}

/**
 * Verifica nas velas subsequentes se SL ou TP foi tocado.
 * Retorna 'WIN', 'LOSS' ou 'OPEN' (tempo esgotado).
 * Usa high/low de cada vela — sem look-ahead alem do slice permitido.
 */
function _resolveOutcome(direction, sl, tp, futureCandles) {
  for (const candle of futureCandles) {
    if (direction === 'BUY') {
      if (candle.low  <= sl) return { result: 'LOSS', exitPrice: sl };
      if (candle.high >= tp) return { result: 'WIN',  exitPrice: tp };
    } else {
      if (candle.high >= sl) return { result: 'LOSS', exitPrice: sl };
      if (candle.low  <= tp) return { result: 'WIN',  exitPrice: tp };
    }
  }
  const lastClose = futureCandles[futureCandles.length - 1]?.close ?? null;
  return { result: 'OPEN', exitPrice: lastClose };
}

/**
 * Calcula metricas de performance a partir da lista de trades.
 */
function _calcStats(trades, dec) {
  const closed  = trades.filter(t => t.result !== 'OPEN');
  const wins    = closed.filter(t => t.result === 'WIN');
  const losses  = closed.filter(t => t.result === 'LOSS');

  const winRate    = closed.length ? (wins.length / closed.length) * 100 : 0;

  const grossProfit = wins.reduce((s, t)   => s + Math.abs(t.pnlR), 0);
  const grossLoss   = losses.reduce((s, t) => s + Math.abs(t.pnlR), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const expectancy = closed.length
    ? (wins.length * (grossProfit / (wins.length || 1)) -
       losses.length * (grossLoss  / (losses.length || 1))) / closed.length
    : 0;

  // Drawdown em R (unidades de risco)
  let peak = 0, drawdown = 0, maxDrawdown = 0, equity = 0;
  for (const t of trades) {
    equity += t.pnlR;
    if (equity > peak) peak = equity;
    drawdown = peak - equity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // Equity curve (acumulada em R)
  let cum = 0;
  const equityCurve = trades.map((t, i) => {
    cum += t.pnlR;
    return { x: i + 1, y: parseFloat(cum.toFixed(2)) };
  });

  return {
    total:        trades.length,
    closed:       closed.length,
    wins:         wins.length,
    losses:       losses.length,
    open:         trades.filter(t => t.result === 'OPEN').length,
    winRate:      parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(Math.min(profitFactor, 99).toFixed(2)),
    expectancy:   parseFloat(expectancy.toFixed(3)),
    maxDrawdownR: parseFloat(maxDrawdown.toFixed(2)),
    totalR:       parseFloat(cum.toFixed(2)),
    equityCurve,
  };
}

/**
 * runBacktest — entry point principal.
 *
 * @param {Array}  candles        Array OHLCV em ordem cronologica
 * @param {object} opts
 * @param {string} opts.assetName Nome do ativo (ex: 'BTCUSD')
 * @param {number} opts.dec       Casas decimais do preco
 * @param {number} [opts.scoreThreshold=2] Score minimo para abrir trade
 * @param {number} [opts.maxBarsInTrade]   Max velas aguardando SL/TP
 * @param {number} [opts.startIdx]         Indice inicial (default: MIN_CANDLES_REQUIRED)
 *
 * @returns {{ trades: Array, stats: object, meta: object }}
 */
function runBacktest(candles, opts = {}) {
  const {
    assetName       = 'ASSET',
    dec             = 2,
    scoreThreshold  = 2,
    maxBarsInTrade  = MAX_BARS_IN_TRADE,
    startIdx        = MIN_CANDLES_REQUIRED,
  } = opts;

  if (!Array.isArray(candles) || candles.length < MIN_CANDLES_REQUIRED + 10) {
    return {
      trades: [],
      stats:  _calcStats([], dec),
      meta:   { error: 'Dados insuficientes para backtest', required: MIN_CANDLES_REQUIRED + 10 },
    };
  }

  const trades  = [];
  let   inTrade = false;

  for (let i = startIdx; i < candles.length - 1; i++) {
    if (inTrade) continue; // uma posicao por vez

    const slice  = candles.slice(0, i + 1);
    const signal = _computeSlice(slice);
    if (!signal) continue;
    if (Math.abs(signal.score) < scoreThreshold) continue;

    const { direction, entry, sl, tp, score, rsi, adx } = signal;
    const candleTime = candles[i].time ?? candles[i].timestamp ?? i;

    const futureEnd    = Math.min(i + 1 + maxBarsInTrade, candles.length);
    const futureSlice  = candles.slice(i + 1, futureEnd);

    if (futureSlice.length === 0) break;

    const { result, exitPrice } = _resolveOutcome(direction, sl, tp, futureSlice);

    // pnlR: +2 = WIN (2R), -1 = LOSS (-1R), parcial se OPEN
    let pnlR = 0;
    if (result === 'WIN')  pnlR = MASTER_SIGNAL_CFG.takeAtrMult;
    if (result === 'LOSS') pnlR = -MASTER_SIGNAL_CFG.stopAtrMult;
    if (result === 'OPEN' && exitPrice != null) {
      const raw = direction === 'BUY' ? exitPrice - entry : entry - exitPrice;
      const atrR = signal.atr > 0 ? raw / signal.atr : 0;
      pnlR = parseFloat(atrR.toFixed(2));
    }

    trades.push({
      index:     i,
      time:      candleTime,
      direction,
      score,
      rsi:       parseFloat(rsi.toFixed(1)),
      adx:       parseFloat(adx.toFixed(1)),
      entry:     parseFloat(entry.toFixed(dec)),
      sl:        parseFloat(sl.toFixed(dec)),
      tp:        parseFloat(tp.toFixed(dec)),
      exitPrice: exitPrice != null ? parseFloat(exitPrice.toFixed(dec)) : null,
      result,
      pnlR:      parseFloat(pnlR.toFixed(2)),
    });

    // Avanca o cursor para apos o trade (evita entradas no meio do trade)
    if (result !== 'OPEN') {
      i += futureSlice.findIndex(c => {
        if (direction === 'BUY') return c.low <= sl || c.high >= tp;
        return c.high >= sl || c.low <= tp;
      }) + 1;
    } else {
      i += futureSlice.length;
    }

    inTrade = false; // pronto para proximo sinal
  }

  return {
    trades,
    stats: _calcStats(trades, dec),
    meta:  {
      assetName,
      totalCandles: candles.length,
      scoreThreshold,
      maxBarsInTrade,
      generatedAt: new Date().toISOString(),
    },
  };
}

module.exports = { runBacktest };
