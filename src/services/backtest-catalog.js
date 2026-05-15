'use strict';

const MASTER_SIGNAL_CFG = require('../../signal-config');
const { computeMasterScoreFromSignals } = require('./score');

function calcEMASeries(closes, period) {
  if (!Array.isArray(closes) || closes.length === 0) return [];
  const k = 2 / (period + 1);
  const result = new Array(closes.length).fill(null);
  let ema = closes[0];
  result[0] = ema;
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

function calcRSISeries(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (!Array.isArray(closes) || closes.length <= period) return result;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (delta > 0 ? delta : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (delta < 0 ? -delta : 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return result;
}

function calcMACDSeries(closes) {
  const fast = calcEMASeries(closes, 12);
  const slow = calcEMASeries(closes, 26);
  const macd = closes.map((_, i) => {
    const f = fast[i];
    const s = slow[i];
    return f == null || s == null ? null : f - s;
  });

  const signal = new Array(macd.length).fill(null);
  const seedIdx = macd.findIndex(v => v != null);
  if (seedIdx === -1) return { macd, signal };

  const valid = macd.slice(seedIdx).map(v => v ?? 0);
  const emaSignal = calcEMASeries(valid, 9);
  emaSignal.forEach((value, idx) => {
    signal[seedIdx + idx] = value;
  });

  return { macd, signal };
}

function calcATRSeries(candles, period = 14) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });

  const result = new Array(candles.length).fill(null);
  if (trs.length < period) return result;

  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = atr;
  for (let i = period; i < trs.length; i++) {
    atr = ((atr * (period - 1)) + trs[i]) / period;
    result[i] = atr;
  }
  return result;
}

function calcADXSeries(candles, period = 14) {
  const result = new Array(candles.length).fill(0);
  if (!Array.isArray(candles) || candles.length < period * 2 + 1) return result;

  const trs = [];
  const pdms = [];
  const mdms = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    const ph = candles[i - 1].high;
    const pl = candles[i - 1].low;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph;
    const dn = pl - l;
    pdms.push(up > dn && up > 0 ? up : 0);
    mdms.push(dn > up && dn > 0 ? dn : 0);
  }

  let sTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = pdms.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = mdms.slice(0, period).reduce((a, b) => a + b, 0);

  const getDX = (tr, pdm, mdm) => {
    if (tr === 0) return 0;
    const pdi = 100 * pdm / tr;
    const mdi = 100 * mdm / tr;
    return (pdi + mdi) === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
  };

  const dxs = [getDX(sTR, sPDM, sMDM)];
  for (let i = period; i < trs.length; i++) {
    sTR = sTR - sTR / period + trs[i];
    sPDM = sPDM - sPDM / period + pdms[i];
    sMDM = sMDM - sMDM / period + mdms[i];
    dxs.push(getDX(sTR, sPDM, sMDM));
  }

  if (dxs.length < period) return result;
  let adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[(period * 2) - 1] = adx;

  for (let i = period; i < dxs.length; i++) {
    adx = ((adx * (period - 1)) + dxs[i]) / period;
    result[i + period] = adx;
  }

  return result.map(v => Math.min(100, v || 0));
}

function calcBollingerSeries(closes, period = 20, mult = 2) {
  const upper = [];
  const mid = [];
  const lower = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      upper.push(null);
      mid.push(null);
      lower.push(null);
      continue;
    }
    const slice = closes.slice(i - period + 1, i + 1);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((a, b) => a + ((b - sma) ** 2), 0) / period);
    upper.push(sma + mult * std);
    mid.push(sma);
    lower.push(sma - mult * std);
  }

  return { upper, mid, lower };
}

function detectCandlePattern(candle, prev) {
  if (!candle || !prev) return { bull: false, bear: false, name: '' };

  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low || 0.0001;
  const bullCurr = candle.close > candle.open;
  const bearCurr = candle.close < candle.open;
  const bullPrev = prev.close > prev.open;
  const bearPrev = prev.close < prev.open;
  const lower = Math.min(candle.open, candle.close) - candle.low;
  const upper = candle.high - Math.max(candle.open, candle.close);
  const prevBody = Math.abs(prev.close - prev.open) || 0.0001;

  if (bearPrev && bullCurr && candle.open <= prev.close && candle.close >= prev.open && body >= prevBody * 0.9) {
    return { bull: true, bear: false, name: 'Engolfo Alta' };
  }
  if (bullPrev && bearCurr && candle.open >= prev.close && candle.close <= prev.open && body >= prevBody * 0.9) {
    return { bull: false, bear: true, name: 'Engolfo Baixa' };
  }
  if (lower >= 2 * Math.max(body, range * 0.04) && upper <= body * 0.6 && lower / range >= 0.45) {
    return { bull: true, bear: false, name: 'Martelo' };
  }
  if (upper >= 2 * Math.max(body, range * 0.04) && lower <= body * 0.6 && upper / range >= 0.45) {
    return { bull: false, bear: true, name: 'Estrela Cadente' };
  }
  if (lower / range >= 0.58 && body / range <= 0.25) {
    return { bull: true, bear: false, name: 'Pin Bar Alta' };
  }
  if (upper / range >= 0.58 && body / range <= 0.25) {
    return { bull: false, bear: true, name: 'Pin Bar Baixa' };
  }
  if (bullCurr && body / range >= 0.75) return { bull: true, bear: false, name: 'Marubozu Alta' };
  if (bearCurr && body / range >= 0.75) return { bull: false, bear: true, name: 'Marubozu Baixa' };
  return { bull: bullCurr, bear: bearCurr, name: '' };
}

function getBiasDirection(biasCandles) {
  if (!Array.isArray(biasCandles) || biasCandles.length < 55) return 'NEUTRAL';
  const closes = biasCandles.map(c => c.close);
  const e9 = calcEMASeries(closes, 9);
  const e20 = calcEMASeries(closes, 20);
  const e50 = calcEMASeries(closes, 50);
  const last = closes.length - 1;
  if (e9[last] > e20[last] && e20[last] > e50[last]) return 'BUY';
  if (e9[last] < e20[last] && e20[last] < e50[last]) return 'SELL';
  return 'NEUTRAL';
}

function isGoodSession(timestampSec, assetKey) {
  if (assetKey === 'btc') return true;
  const hour = new Date(timestampSec * 1000).getUTCHours();
  return (hour >= 7 && hour < 16) || (hour >= 12 && hour < 21);
}

function getSessionLabel(timestampSec, assetKey) {
  if (assetKey === 'btc') return 'BTC 24/7';
  const hour = new Date(timestampSec * 1000).getUTCHours();
  const london = hour >= 7 && hour < 16;
  const ny = hour >= 12 && hour < 21;
  if (london && ny) return 'London + NY';
  if (london) return 'London';
  if (ny) return 'NY';
  return 'Fora da sessao';
}

function isNewsBlackoutTime(timestampSec, enabled) {
  if (!enabled) return false;
  const date = new Date(timestampSec * 1000);
  const currentMin = (date.getUTCHours() * 60) + date.getUTCMinutes();
  const eventTimes = [
    { h: 8,  m: 30, delta: 30 },
    { h: 10, m: 0,  delta: 30 },
    { h: 14, m: 0,  delta: 30 },
    { h: 15, m: 0,  delta: 30 },
    { h: 8,  m: 0,  delta: 30 },
    { h: 9,  m: 0,  delta: 30 },
    { h: 13, m: 0,  delta: 30 },
    { h: 13, m: 30, delta: 30 },
  ];
  return eventTimes.some(event => Math.abs(currentMin - ((event.h * 60) + event.m)) <= event.delta);
}

function tradePct(type, entry, exit, costPct) {
  const rawPct = type === 'COMPRA'
    ? ((exit - entry) / entry) * 100
    : ((entry - exit) / entry) * 100;
  return rawPct - ((costPct || 0) * 2);
}

function classifyMasterSignal(score) {
  if (score >= 3) return { label: 'FORTE COMPRA', bias: 'LONG' };
  if (score === 2) return { label: 'COMPRA MODERADA', bias: 'LONG' };
  if (score <= -3) return { label: 'FORTE VENDA', bias: 'SHORT' };
  if (score === -2) return { label: 'VENDA MODERADA', bias: 'SHORT' };
  return { label: 'NEUTRO', bias: 'FLAT' };
}

function getMasterSignalSnapshot(candles, indicators, idx, assetKey, newsBlackoutEnabled) {
  const { e9, e20, e50, rsi, atr, adx } = indicators;
  const candle = candles[idx];
  const price = candle.close;

  const trendSig = e9[idx] > e20[idx] && e20[idx] > e50[idx] ? 'COMPRA'
    : e9[idx] < e20[idx] && e20[idx] < e50[idx] ? 'VENDA'
    : 'NEUTRO';

  const rsiTrendSig = rsi[idx] > MASTER_SIGNAL_CFG.rsiBullish ? 'COMPRA'
    : rsi[idx] < MASTER_SIGNAL_CFG.rsiBearish ? 'VENDA'
    : 'NEUTRO';

  const prev = candles.slice(Math.max(0, idx - MASTER_SIGNAL_CFG.breakoutLookback), idx);
  const bkHigh = prev.length ? Math.max(...prev.map(c => c.high)) : price;
  const bkLow = prev.length ? Math.min(...prev.map(c => c.low)) : price;
  const bkSig = price > bkHigh ? 'COMPRA' : price < bkLow ? 'VENDA' : 'AGUARDAR';

  const raw = computeMasterScoreFromSignals({
    trendSig,
    rsiTrendSig,
    bkSig,
    isLateral: false,
  });

  const rawScore = raw.rawScore;
  const adxValue = adx[idx] || 0;
  const adxOk = adxValue >= MASTER_SIGNAL_CFG.adxTrendMin;
  const score = adxOk ? rawScore : rawScore > 0 ? 1 : rawScore < 0 ? -1 : 0;
  const classification = classifyMasterSignal(score);
  const tradableScore = rawScore === 3 || rawScore === -3;
  const sessionOk = isGoodSession(candle.time, assetKey);
  const sessionLabel = getSessionLabel(candle.time, assetKey);
  const newsBlocked = isNewsBlackoutTime(candle.time, newsBlackoutEnabled);

  return {
    price,
    atr: atr[idx],
    adx: adxValue,
    trendSig,
    rsiTrendSig,
    bkSig,
    rawScore,
    score,
    label: classification.label,
    sessionOk,
    sessionLabel,
    newsBlocked,
    isTradable: tradableScore && adxOk && !!atr[idx] && sessionOk && !newsBlocked,
  };
}

function runMaster(candles, assetKey, options) {
  const closes = candles.map(c => c.close);
  const e9 = calcEMASeries(closes, 9);
  const e20 = calcEMASeries(closes, 20);
  const e50 = calcEMASeries(closes, 50);
  const rsi = calcRSISeries(closes, 14);
  const atr = calcATRSeries(candles, 14);
  const adx = calcADXSeries(candles, 14);
  const indicators = { e9, e20, e50, rsi, atr, adx };

  const trades = [];
  let inTrade = false;
  let tradeType = '';
  let entryIdx = 0;
  let entryPrice = 0;
  let slPrice = 0;
  let tpPrice = 0;
  let entryBarIdx = -1;
  let entryAudit = null;

  for (let i = 55; i < candles.length; i++) {
    const candle = candles[i];
    const signal = getMasterSignalSnapshot(candles, indicators, i, assetKey, options.newsBlackoutEnabled);

    if (!inTrade) {
      if (!signal.isTradable || i + 1 >= candles.length) continue;
      const fillCandle = candles[i + 1];
      const fillIsNews = isNewsBlackoutTime(fillCandle.time, options.newsBlackoutEnabled);
      const slipMult = fillIsNews ? MASTER_SIGNAL_CFG.newsSpreadMult : 1.0;
      const effectiveSlipPct = MASTER_SIGNAL_CFG.slippagePct * slipMult;
      const slip = fillCandle.open * effectiveSlipPct / 100;

      if (signal.rawScore === 3) {
        entryPrice = fillCandle.open + slip;
        slPrice = entryPrice - MASTER_SIGNAL_CFG.stopAtrMult * signal.atr;
        tpPrice = entryPrice + MASTER_SIGNAL_CFG.takeAtrMult * signal.atr;
        inTrade = true;
        tradeType = 'COMPRA';
        entryIdx = i + 1;
        entryBarIdx = i + 1;
      } else if (signal.rawScore === -3) {
        entryPrice = fillCandle.open - slip;
        slPrice = entryPrice + MASTER_SIGNAL_CFG.stopAtrMult * signal.atr;
        tpPrice = entryPrice - MASTER_SIGNAL_CFG.takeAtrMult * signal.atr;
        inTrade = true;
        tradeType = 'VENDA';
        entryIdx = i + 1;
        entryBarIdx = i + 1;
      }

      if (inTrade) {
        entryAudit = {
          rawScore: signal.rawScore,
          finalScore: signal.score,
          label: signal.label,
          adx: signal.adx,
          trendSig: signal.trendSig,
          rsiTrendSig: signal.rsiTrendSig,
          bkSig: signal.bkSig,
          sessionOk: signal.sessionOk,
          sessionLabel: signal.sessionLabel,
          newsBlocked: signal.newsBlocked,
          slippagePct: effectiveSlipPct,
          newsSpread: fillIsNews,
          fillOpen: fillCandle.open,
        };
      }
    } else {
      if (i <= entryBarIdx) continue;

      let exit = false;
      let exitPrice = candle.close;
      const scoreWeak = tradeType === 'COMPRA' ? signal.score <= 0 : signal.score >= 0;
      let exitReason = 'FORCA_PERDIDA';

      if (tradeType === 'COMPRA') {
        if (candle.low <= slPrice) {
          exit = true;
          exitPrice = slPrice;
          exitReason = 'STOP_LOSS';
        } else if (candle.high >= tpPrice) {
          exit = true;
          exitPrice = tpPrice;
          exitReason = 'TAKE_PROFIT';
        } else if (scoreWeak) {
          exit = true;
        }
      } else {
        if (candle.high >= slPrice) {
          exit = true;
          exitPrice = slPrice;
          exitReason = 'STOP_LOSS';
        } else if (candle.low <= tpPrice) {
          exit = true;
          exitPrice = tpPrice;
          exitReason = 'TAKE_PROFIT';
        } else if (scoreWeak) {
          exit = true;
        }
      }

      if (exit) {
        const pct = tradePct(tradeType, entryPrice, exitPrice, options.costPct);
        trades.push({
          entryIdx,
          exitIdx: i,
          entryPrice,
          exitPrice,
          pct,
          win: pct > 0,
          type: tradeType,
          sl: slPrice,
          tp: tpPrice,
          hasSL: true,
          exitReason,
          audit: {
            ...entryAudit,
            exitScore: signal.score,
            exitRawScore: signal.rawScore,
            exitLabel: signal.label,
            exitAdx: signal.adx,
          },
        });
        inTrade = false;
        entryBarIdx = -1;
        entryAudit = null;
      }
    }
  }

  return trades;
}

function runTrend(candles, biasCandles, assetKey, options) {
  const closes = candles.map(c => c.close);
  const e9 = calcEMASeries(closes, 9);
  const e20 = calcEMASeries(closes, 20);
  const e50 = calcEMASeries(closes, 50);
  const adx = calcADXSeries(candles, 14);
  const atr = calcATRSeries(candles, 14);
  const rsi = calcRSISeries(closes, 14);
  const bias = getBiasDirection(biasCandles);
  const trades = [];

  let inTrade = false;
  let tradeType = '';
  let entryIdx = 0;
  let entryPrice = 0;
  let trailStop = 0;
  let peakPrice = 0;
  let entryATR = 0;
  let lastExitIdx = -1;
  let entryPattern = '';
  const atrMult = assetKey === 'btc' ? 2.5 : assetKey === 'xau' ? 1.5 : 1.8;
  const getCooldown = (adxValue) => (assetKey === 'btc' ? (adxValue < 30 ? 12 : 8) : 5);

  for (let i = 52; i < candles.length; i++) {
    const candle = candles[i];
    const prev = candles[i - 1];

    if (!inTrade) {
      if (isNewsBlackoutTime(candle.time, options.newsBlackoutEnabled)) continue;
      const currentCooldown = getCooldown(adx[i] || 0);
      if (lastExitIdx >= 0 && i - lastExitIdx < currentCooldown) continue;
      if (!adx[i] || adx[i] < 25) continue;

      const longAlign = e9[i] > e20[i] && e20[i] > e50[i];
      const shortAlign = e9[i] < e20[i] && e20[i] < e50[i];
      const body = Math.abs(candle.close - candle.open);
      const range = candle.high - candle.low || 0.0001;
      const strongBody = body / range > 0.4;
      const atrTol = atr[i] || 0;
      const biasOkLong = bias === 'BUY' || bias === 'NEUTRAL';
      const biasOkShort = bias === 'SELL' || bias === 'NEUTRAL';
      const pattern = detectCandlePattern(candle, prev);

      if (
        longAlign &&
        biasOkLong &&
        Math.abs(prev.low - e20[i - 1]) < atrTol * 1.2 &&
        candle.close > candle.open &&
        candle.close > e9[i] &&
        strongBody &&
        (!options.confluenceEnabled || pattern.bull)
      ) {
        inTrade = true;
        tradeType = 'COMPRA';
        entryIdx = i;
        entryPrice = candle.close;
        peakPrice = candle.close;
        entryATR = atr[i] || atrTol;
        trailStop = peakPrice - atrMult * entryATR;
        entryPattern = pattern.name || 'Corpo Forte';
      } else if (
        shortAlign &&
        biasOkShort &&
        Math.abs(prev.high - e20[i - 1]) < atrTol * 1.2 &&
        candle.close < candle.open &&
        candle.close < e9[i] &&
        strongBody &&
        (!options.confluenceEnabled || pattern.bear) &&
        (rsi[i] || 0) <= 60
      ) {
        inTrade = true;
        tradeType = 'VENDA';
        entryIdx = i;
        entryPrice = candle.close;
        peakPrice = candle.close;
        entryATR = atr[i] || atrTol;
        trailStop = peakPrice + atrMult * entryATR;
        entryPattern = pattern.name || 'Corpo Forte';
      }
    } else {
      const curAtr = atr[i] || atr[i - 1] || 0.0001;
      if (tradeType === 'COMPRA') {
        if (candle.high > peakPrice) peakPrice = candle.high;
        const effectiveATR = Math.max(curAtr, entryATR);
        trailStop = Math.max(trailStop, peakPrice - atrMult * effectiveATR);
        const hit = candle.low <= trailStop;
        const ema50breach = candle.low < e50[i] * 0.997;
        if (hit || ema50breach) {
          const exitPrice = hit ? Math.min(candle.close, trailStop) : candle.close;
          const pct = tradePct(tradeType, entryPrice, exitPrice, options.costPct);
          trades.push({ entryIdx, exitIdx: i, entryPrice, exitPrice, pct, win: pct > 0, type: tradeType, pattern: entryPattern, sl: trailStop, hasSL: true });
          inTrade = false;
          lastExitIdx = i;
        }
      } else {
        if (candle.low < peakPrice) peakPrice = candle.low;
        const effectiveATR = Math.max(curAtr, entryATR);
        trailStop = Math.min(trailStop, peakPrice + atrMult * effectiveATR);
        const hit = candle.high >= trailStop;
        const ema50breach = candle.high > e50[i] * 1.003;
        if (hit || ema50breach) {
          const exitPrice = hit ? Math.max(candle.close, trailStop) : candle.close;
          const pct = tradePct(tradeType, entryPrice, exitPrice, options.costPct);
          trades.push({ entryIdx, exitIdx: i, entryPrice, exitPrice, pct, win: pct > 0, type: tradeType, pattern: entryPattern, sl: trailStop, hasSL: true });
          inTrade = false;
          lastExitIdx = i;
        }
      }
    }
  }

  return trades;
}

function runInsideBar(candles, biasCandles, _assetKey, options) {
  const closes = candles.map(c => c.close);
  const e9 = calcEMASeries(closes, 9);
  const e50 = calcEMASeries(closes, 50);
  const adx = calcADXSeries(candles, 14);
  const atr = calcATRSeries(candles, 14);
  const bias = getBiasDirection(biasCandles);
  const trades = [];

  let inTrade = false;
  let tradeType = '';
  let entryIdx = 0;
  let entryPrice = 0;
  let slPrice = 0;
  let tpPrice = 0;
  let entryPattern = '';

  for (let i = 52; i < candles.length - 1; i++) {
    if (!inTrade) {
      if (isNewsBlackoutTime(candles[i].time, options.newsBlackoutEnabled)) continue;
      if (!adx[i] || adx[i] < 25) continue;
      const mother = candles[i - 1];
      const inside = candles[i];
      const confirm = candles[i + 1];
      const atrVal = atr[i] || 0;
      const isInside = inside.high <= mother.high && inside.low >= mother.low;
      if (!isInside) continue;

      const pattern = detectCandlePattern(confirm, inside);
      if (confirm.close > mother.high && e9[i] > e50[i] && (bias === 'BUY' || bias === 'NEUTRAL') && (!options.confluenceEnabled || pattern.bull)) {
        entryPrice = confirm.close;
        slPrice = mother.low - atrVal * 0.2;
        const risk = entryPrice - slPrice;
        if (risk <= 0) continue;
        tpPrice = entryPrice + (2 * risk);
        inTrade = true;
        tradeType = 'COMPRA';
        entryIdx = i + 1;
        entryPattern = pattern.name || 'Breakout Alta';
      } else if (confirm.close < mother.low && e9[i] < e50[i] && (bias === 'SELL' || bias === 'NEUTRAL') && (!options.confluenceEnabled || pattern.bear)) {
        entryPrice = confirm.close;
        slPrice = mother.high + atrVal * 0.2;
        const risk = slPrice - entryPrice;
        if (risk <= 0) continue;
        tpPrice = entryPrice - (2 * risk);
        inTrade = true;
        tradeType = 'VENDA';
        entryIdx = i + 1;
        entryPattern = pattern.name || 'Breakout Baixa';
      }
    } else {
      const candle = candles[i];
      let exit = false;
      let exitPrice = candle.close;
      if (tradeType === 'COMPRA') {
        if (candle.low <= slPrice) {
          exit = true;
          exitPrice = slPrice;
        } else if (candle.high >= tpPrice) {
          exit = true;
          exitPrice = tpPrice;
        }
      } else {
        if (candle.high >= slPrice) {
          exit = true;
          exitPrice = slPrice;
        } else if (candle.low <= tpPrice) {
          exit = true;
          exitPrice = tpPrice;
        }
      }
      if (exit) {
        const pct = tradePct(tradeType, entryPrice, exitPrice, options.costPct);
        trades.push({ entryIdx, exitIdx: i, entryPrice, exitPrice, pct, win: pct > 0, type: tradeType, sl: slPrice, tp: tpPrice, hasSL: true, pattern: entryPattern });
        inTrade = false;
      }
    }
  }

  return trades;
}

function runRsi(candles, _biasCandles, _assetKey, options) {
  const closes = candles.map(c => c.close);
  const rsi = calcRSISeries(closes, 14);
  const atr = calcATRSeries(candles, 14);
  const e50 = calcEMASeries(closes, 50);
  const bb = calcBollingerSeries(closes, 20, 2);
  const adx = calcADXSeries(candles, 14);
  const trades = [];

  let inTrade = false;
  let tradeType = '';
  let entryIdx = 0;
  let entryPrice = 0;
  let slPrice = 0;
  let entryPattern = '';

  for (let i = 52; i < candles.length; i++) {
    const candle = candles[i];
    if (!inTrade) {
      if (isNewsBlackoutTime(candle.time, options.newsBlackoutEnabled)) continue;
      if (adx[i] && adx[i] >= 20) continue;
      if (rsi[i] == null || atr[i] == null || bb.lower[i] == null) continue;
      const e50Slope = e50[i] - e50[Math.max(0, i - 10)];
      const pattern = detectCandlePattern(candle, candles[i - 1]);

      if (rsi[i] < 30 && candle.close <= bb.lower[i] * 1.001 && e50Slope >= -e50[i] * 0.002 && (!options.confluenceEnabled || pattern.bull)) {
        inTrade = true;
        tradeType = 'COMPRA';
        entryIdx = i;
        entryPrice = candle.close;
        slPrice = entryPrice - (1.5 * atr[i]);
        entryPattern = pattern.name || 'RSI Extremo';
      } else if (rsi[i] > 70 && candle.close >= bb.upper[i] * 0.999 && e50Slope <= e50[i] * 0.002 && (!options.confluenceEnabled || pattern.bear)) {
        inTrade = true;
        tradeType = 'VENDA';
        entryIdx = i;
        entryPrice = candle.close;
        slPrice = entryPrice + (1.5 * atr[i]);
        entryPattern = pattern.name || 'RSI Extremo';
      }
    } else {
      let exit = false;
      let exitPrice = candle.close;
      if (tradeType === 'COMPRA') {
        if (candle.low <= slPrice) {
          exit = true;
          exitPrice = slPrice;
        } else if (bb.mid[i] != null && candle.close > bb.mid[i]) {
          exit = true;
        }
      } else {
        if (candle.high >= slPrice) {
          exit = true;
          exitPrice = slPrice;
        } else if (bb.mid[i] != null && candle.close < bb.mid[i]) {
          exit = true;
        }
      }
      if (exit) {
        const pct = tradePct(tradeType, entryPrice, exitPrice, options.costPct);
        trades.push({ entryIdx, exitIdx: i, entryPrice, exitPrice, pct, win: pct > 0, type: tradeType, sl: slPrice, hasSL: true, pattern: entryPattern });
        inTrade = false;
      }
    }
  }

  return trades;
}

function runMacd(candles, biasCandles, _assetKey, options) {
  const closes = candles.map(c => c.close);
  const { macd, signal } = calcMACDSeries(closes);
  const adx = calcADXSeries(candles, 14);
  const atr = calcATRSeries(candles, 14);
  const bias = getBiasDirection(biasCandles);
  const trades = [];

  let inTrade = false;
  let tradeType = '';
  let entryIdx = 0;
  let entryPrice = 0;
  let slPrice = 0;
  let tpPrice = 0;
  let entryPattern = '';

  for (let i = 27; i < candles.length; i++) {
    const candle = candles[i];
    if (!inTrade) {
      if (isNewsBlackoutTime(candle.time, options.newsBlackoutEnabled)) continue;
      if (!adx[i] || adx[i] < 25) continue;
      const atrVal = atr[i] || 0;
      const pattern = detectCandlePattern(candle, candles[i - 1]);

      if (macd[i] > signal[i] && macd[i - 1] <= signal[i - 1] && macd[i] > 0 && (bias === 'BUY' || bias === 'NEUTRAL') && (!options.confluenceEnabled || pattern.bull)) {
        entryPrice = candle.close;
        slPrice = entryPrice - (2 * atrVal);
        tpPrice = entryPrice + (3 * atrVal);
        inTrade = true;
        tradeType = 'COMPRA';
        entryIdx = i;
        entryPattern = pattern.name || 'Cruz MACD';
      } else if (macd[i] < signal[i] && macd[i - 1] >= signal[i - 1] && macd[i] < 0 && (bias === 'SELL' || bias === 'NEUTRAL') && (!options.confluenceEnabled || pattern.bear)) {
        entryPrice = candle.close;
        slPrice = entryPrice + (2 * atrVal);
        tpPrice = entryPrice - (3 * atrVal);
        inTrade = true;
        tradeType = 'VENDA';
        entryIdx = i;
        entryPattern = pattern.name || 'Cruz MACD';
      }
    } else {
      let exit = false;
      let exitPrice = candle.close;
      if (tradeType === 'COMPRA') {
        if (candle.low <= slPrice) {
          exit = true;
          exitPrice = slPrice;
        } else if (candle.high >= tpPrice) {
          exit = true;
          exitPrice = tpPrice;
        } else if (macd[i] < signal[i]) {
          exit = true;
        }
      } else {
        if (candle.high >= slPrice) {
          exit = true;
          exitPrice = slPrice;
        } else if (candle.low <= tpPrice) {
          exit = true;
          exitPrice = tpPrice;
        } else if (macd[i] > signal[i]) {
          exit = true;
        }
      }
      if (exit) {
        const pct = tradePct(tradeType, entryPrice, exitPrice, options.costPct);
        trades.push({ entryIdx, exitIdx: i, entryPrice, exitPrice, pct, win: pct > 0, type: tradeType, sl: slPrice, tp: tpPrice, hasSL: true, pattern: entryPattern });
        inTrade = false;
      }
    }
  }

  return trades;
}

function runBreakout(candles, _biasCandles, assetKey, options) {
  const atr = calcATRSeries(candles, 14);
  const adx = calcADXSeries(candles, 14);
  const trades = [];

  let inTrade = false;
  let tradeType = '';
  let entryIdx = 0;
  let entryPrice = 0;
  let slPrice = 0;
  let tpPrice = 0;
  let entryPattern = '';

  for (let i = 31; i < candles.length; i++) {
    const candle = candles[i];
    if (!inTrade) {
      if (!isGoodSession(candle.time, assetKey)) continue;
      if (isNewsBlackoutTime(candle.time, options.newsBlackoutEnabled)) continue;
      if (!adx[i] || adx[i] < 25) continue;

      const high20 = Math.max(...candles.slice(i - 30, i).map(x => x.high));
      const low20 = Math.min(...candles.slice(i - 30, i).map(x => x.low));
      const low5 = Math.min(...candles.slice(i - 5, i).map(x => x.low));
      const high5 = Math.max(...candles.slice(i - 5, i).map(x => x.high));
      const atrVal = atr[i] || 0;
      const pattern = detectCandlePattern(candle, candles[i - 1]);

      if (candle.close > high20 && (candle.close - high20) > atrVal * 0.5 && (!options.confluenceEnabled || pattern.bull)) {
        slPrice = low5 * 0.9995;
        tpPrice = candle.close + (2 * (candle.close - slPrice));
        inTrade = true;
        tradeType = 'COMPRA';
        entryIdx = i;
        entryPrice = candle.close;
        entryPattern = pattern.name || 'Rompimento';
      } else if (candle.close < low20 && (low20 - candle.close) > atrVal * 0.5 && (!options.confluenceEnabled || pattern.bear)) {
        slPrice = high5 * 1.0005;
        tpPrice = candle.close - (2 * (slPrice - candle.close));
        inTrade = true;
        tradeType = 'VENDA';
        entryIdx = i;
        entryPrice = candle.close;
        entryPattern = pattern.name || 'Rompimento';
      }
    } else {
      let exit = false;
      let exitPrice = candle.close;
      if (tradeType === 'COMPRA') {
        if (candle.low <= slPrice) {
          exit = true;
          exitPrice = slPrice;
        } else if (candle.high >= tpPrice) {
          exit = true;
          exitPrice = tpPrice;
        }
      } else {
        if (candle.high >= slPrice) {
          exit = true;
          exitPrice = slPrice;
        } else if (candle.low <= tpPrice) {
          exit = true;
          exitPrice = tpPrice;
        }
      }
      if (exit) {
        const pct = tradePct(tradeType, entryPrice, exitPrice, options.costPct);
        trades.push({ entryIdx, exitIdx: i, entryPrice, exitPrice, pct, win: pct > 0, type: tradeType, sl: slPrice, tp: tpPrice, hasSL: true, pattern: entryPattern });
        inTrade = false;
      }
    }
  }

  return trades;
}

function runStrategyCatalog({ assetKey, candles, biasCandles, options = {} }) {
  const opts = {
    confluenceEnabled: false,
    newsBlackoutEnabled: false,
    costPct: 0,
    ...options,
  };

  const strategies = {
    master: {
      name: 'Master Signal',
      source: 'dashboard-core',
      stopMode: 'fixed',
      hasSL: true,
      trades: runMaster(candles, assetKey, opts),
    },
    trend: {
      name: 'EMA Tendencia',
      source: 'backend-shared',
      stopMode: 'trailing',
      hasSL: true,
      trades: runTrend(candles, biasCandles, assetKey, opts),
    },
    ema: {
      name: 'Inside Bar',
      source: 'backend-shared',
      stopMode: 'fixed',
      hasSL: true,
      trades: runInsideBar(candles, biasCandles, assetKey, opts),
    },
    rsi: {
      name: 'RSI Reversao',
      source: 'backend-shared',
      stopMode: 'fixed',
      hasSL: true,
      trades: runRsi(candles, biasCandles, assetKey, opts),
    },
    macd: {
      name: 'MACD Crossover',
      source: 'backend-shared',
      stopMode: 'fixed',
      hasSL: true,
      trades: runMacd(candles, biasCandles, assetKey, opts),
    },
    breakout: {
      name: 'Breakout',
      source: 'backend-shared',
      stopMode: 'fixed',
      hasSL: true,
      trades: runBreakout(candles, biasCandles, assetKey, opts),
    },
  };

  return {
    strategies,
    meta: {
      assetKey,
      totalCandles: candles.length,
      biasCandles: Array.isArray(biasCandles) ? biasCandles.length : 0,
      options: opts,
      vipHistoricalExact: false,
      vipNote: 'O historico VIP exato ainda depende de snapshots externos (news, DXY e contexto live) que nao estao persistidos candle a candle.',
      generatedAt: new Date().toISOString(),
    },
  };
}

module.exports = {
  runStrategyCatalog,
};
