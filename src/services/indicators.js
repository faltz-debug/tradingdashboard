'use strict';

/**
 * INDICATORS — Funções puras de análise técnica.
 *
 * Este módulo contém indicadores extraídos do server.js para isolar a lógica
 * matemática (sem efeitos colaterais, sem I/O). Todas as funções são puras:
 * mesma entrada → mesma saída, sem dependências de cache global, axios ou DB.
 *
 * Funções exportadas:
 *   - calcEMA(closes, period)
 *   - calcRSI(closes, period = 14)
 *   - calcMACD(closes)                       → { macd, signal }
 *   - calcBollinger(closes, period = 20)     → { upper, mid, lower }
 *   - calcATR(candles, period = 14)
 *   - calcADX(candles, period = 14)          → { adx, pdi, mdi }
 *   - calcSupportResistance(candles, lb = 5) → { supports, resistances, ... }
 *   - detectDivergence(candles, period = 14) → { divergences, hasBullish, ... }
 *   - calcIchimoku(candles, direction)
 *   - calcSessionVwap(candles, direction)
 *   - calcFibonacciLevels(candles, direction, lookback = 96)
 *
 * Estes indicadores assumem candles no formato:
 *   { open, high, low, close, volume?, time?, timestamp? }
 *
 * Não modificam nem o array de entrada nem qualquer estado externo.
 */

// ─── EMA (Exponential Moving Average) ─────────────────────────────────────
function calcEMA(closes, period) {
  if (!closes || closes.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// ─── RSI (Relative Strength Index) ────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length <= period) return 50; // dados insuficientes — retorna neutro
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ─── MACD (12/26/9) ───────────────────────────────────────────────────────
function calcMACD(closes) {
  // MACD Line = EMA(12) - EMA(26)
  const k12 = 2 / 13, k26 = 2 / 27;
  let ema12 = closes[0], ema26 = closes[0];
  const macdArr = [];
  for (let i = 0; i < closes.length; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
    ema26 = closes[i] * k26 + ema26 * (1 - k26);
    macdArr.push(ema12 - ema26);
  }
  // Signal Line = EMA(9) do MACD, inicializada com SMA(9) dos primeiros 9 valores
  // Isso alinha com TradingView/MT5 e evita noise nos primeiros candles
  const k9 = 2 / 10;
  let sig;
  if (macdArr.length < 9) {
    sig = macdArr[macdArr.length - 1];
  } else {
    sig = macdArr.slice(0, 9).reduce((a, b) => a + b, 0) / 9; // SMA(9) seed
    for (let i = 9; i < macdArr.length; i++) {
      sig = macdArr[i] * k9 + sig * (1 - k9);
    }
  }
  return { macd: macdArr[macdArr.length - 1], signal: sig };
}

// ─── BOLLINGER BANDS (20, 2σ) ─────────────────────────────────────────────
function calcBollinger(closes, period = 20) {
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: sma + 2 * std, mid: sma, lower: sma - 2 * std };
}

// ─── ATR (Average True Range) ─────────────────────────────────────────────
function calcATR(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const slice = trs.slice(-period);
  return slice.length > 0 ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
}

// ─── ADX (Average Directional Index) — Wilder smoothing ──────────────────
function calcADX(candles, period = 14) {
  // Precisa de pelo menos 2x o período de candles
  if (candles.length < period * 2 + 1) return { adx: 0, pdi: 0, mdi: 0 };

  const trs = [], pdms = [], mdms = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
    const ph = candles[i-1].high, pl = candles[i-1].low;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const upMove = h - ph, downMove = pl - l;
    pdms.push(upMove > downMove && upMove > 0 ? upMove : 0);
    mdms.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder smoothing: primeiro valor = soma dos primeiros `period` valores
  let sTR  = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = pdms.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = mdms.slice(0, period).reduce((a, b) => a + b, 0);

  const getDX = (tr, pdm, mdm) => {
    if (tr === 0) return 0;
    const pdi = 100 * pdm / tr, mdi = 100 * mdm / tr;
    return (pdi + mdi) === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
  };

  // Gera array de DX com smoothing Wilder
  const dxArr = [getDX(sTR, sPDM, sMDM)];
  for (let i = period; i < trs.length; i++) {
    sTR  = sTR  - sTR / period  + trs[i];
    sPDM = sPDM - sPDM / period + pdms[i];
    sMDM = sMDM - sMDM / period + mdms[i];
    dxArr.push(getDX(sTR, sPDM, sMDM));
  }

  // ADX = média suavizada do DX (Wilder)
  let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i]) / period;
  }

  const pdi = sTR > 0 ? 100 * sPDM / sTR : 0;
  const mdi = sTR > 0 ? 100 * sMDM / sTR : 0;
  return { adx: Math.min(100, adx), pdi, mdi };
}

// ─── SUPORTE E RESISTÊNCIA (Swing Highs/Lows) ────────────────────────────
function calcSupportResistance(candles, lookback = 5) {
  // Detecta swing highs e swing lows
  // lookback = quantas velas dos dois lados verificar
  const supports = [];
  const resistances = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) isSwingHigh = false;
      if (candles[i - j].low <= c.low || candles[i + j].low <= c.low) isSwingLow = false;
    }

    if (isSwingHigh) resistances.push({ price: c.high, time: c.time, index: i });
    if (isSwingLow) supports.push({ price: c.low, time: c.time, index: i });
  }

  // Pega os 3 mais recentes de cada
  const topRes = resistances.slice(-3).reverse();
  const topSup = supports.slice(-3).reverse();

  // Nível mais próximo do preço atual
  const currentPrice = candles[candles.length - 1].close;
  const nearestRes = topRes.length ? topRes.reduce((a, b) => Math.abs(a.price - currentPrice) < Math.abs(b.price - currentPrice) ? a : b) : null;
  const nearestSup = topSup.length ? topSup.reduce((a, b) => Math.abs(a.price - currentPrice) < Math.abs(b.price - currentPrice) ? a : b) : null;

  return { supports: topSup, resistances: topRes, nearestSup, nearestRes };
}

// ─── DIVERGÊNCIA RSI E MACD ──────────────────────────────────────────────
function detectDivergence(candles, period = 14) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // Calcula RSI array completo
  const rsiArr = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = 0; i <= period; i++) rsiArr.push(null);
  rsiArr[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsiArr[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  // MACD
  const k12 = 2 / 13, k26 = 2 / 27;
  let ema12 = closes[0], ema26 = closes[0];
  const macdArr = [];
  for (let i = 0; i < closes.length; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
    ema26 = closes[i] * k26 + ema26 * (1 - k26);
    macdArr.push(ema12 - ema26);
  }

  // Procura divergências nas últimas 30 velas
  const lookback = Math.min(30, candles.length - period - 2);
  const startIdx = candles.length - lookback;
  const divergences = [];

  // Swing highs e lows do preço (para detectar HH/HL e LH/LL)
  for (let i = Math.max(startIdx + 2, 2); i < candles.length - 2; i++) {
    if (rsiArr[i] === null) continue;

    // Swing High do preço
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && (i+2 >= candles.length || highs[i] > highs[i+2])) {
      // Procura swing high anterior do preço
      for (let j = i - 3; j >= Math.max(startIdx, 1); j--) {
        if (rsiArr[j] === null) continue;
        if (j + 1 < candles.length && highs[j] > highs[j-1] && highs[j] > highs[j+1]) {
          // Divergência Bearish: preço faz High mais alto, RSI faz high mais baixo
          if (highs[i] > highs[j] && rsiArr[i] < rsiArr[j]) {
            divergences.push({
              type: 'bearish_rsi',
              label: 'Divergência Bearish RSI',
              desc: 'Preço fez novo máximo, RSI caiu — possível reversão de baixa',
              index: i, time: candles[i].time,
              priceHigh: highs[i], rsiVal: rsiArr[i]
            });
          }
          // Divergência Bearish Regular MACD: preço faz HH, MACD faz LH (enfraquecimento)
          if (highs[i] > highs[j] && macdArr[i] < macdArr[j]) {
            divergences.push({
              type: 'bearish_macd',
              label: 'Divergência Bearish MACD',
              desc: 'Preço fez novo máximo, MACD caiu — possível reversão de baixa',
              index: i, time: candles[i].time,
              priceHigh: highs[i], macdVal: macdArr[i]
            });
          }
          break;
        }
      }
    }

    // Swing Low do preço
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && (i+2 >= candles.length || lows[i] < lows[i+2])) {
      for (let j = i - 3; j >= Math.max(startIdx, 1); j--) {
        if (rsiArr[j] === null) continue;
        if (j + 1 < candles.length && lows[j] < lows[j-1] && lows[j] < lows[j+1]) {
          // Divergência Bullish: preço faz Low mais baixo, RSI faz low mais alto
          if (lows[i] < lows[j] && rsiArr[i] > rsiArr[j]) {
            divergences.push({
              type: 'bullish_rsi',
              label: 'Divergência Bullish RSI',
              desc: 'Preço fez novo mínimo, RSI subiu — possível reversão de alta',
              index: i, time: candles[i].time,
              priceLow: lows[i], rsiVal: rsiArr[i]
            });
          }
          if (lows[i] < lows[j] && macdArr[i] > macdArr[j]) {
            divergences.push({
              type: 'bullish_macd',
              label: 'Divergência Bullish MACD',
              desc: 'Preço fez novo mínimo, MACD subiu — possível reversão de alta',
              index: i, time: candles[i].time,
              priceLow: lows[i], macdVal: macdArr[i]
            });
          }
          break;
        }
      }
    }
  }

  // Pega a mais recente de cada tipo
  const latest = {};
  for (const d of divergences) {
    if (!latest[d.type] || d.index > latest[d.type].index) latest[d.type] = d;
  }

  const hasBullish = !!latest['bullish_rsi'] || !!latest['bullish_macd'];
  const hasBearish = !!latest['bearish_rsi'] || !!latest['bearish_macd'];

  return {
    divergences: Object.values(latest),
    hasBullish,
    hasBearish,
    signal: hasBullish && !hasBearish ? 'BULLISH' : hasBearish && !hasBullish ? 'BEARISH' : hasBullish && hasBearish ? 'MISTO' : 'NENHUM'
  };
}

// ─── ICHIMOKU CLOUD (9/26/52) ────────────────────────────────────────────
function calcIchimoku(candles, direction) {
  if (candles.length < 52) return null;

  const price    = candles[candles.length - 1].close;
  const p9       = candles.slice(-9);
  const p26      = candles.slice(-26);
  const p52      = candles.slice(-52);

  const tenkan   = (Math.max(...p9.map(c => c.high))  + Math.min(...p9.map(c => c.low)))  / 2;
  const kijun    = (Math.max(...p26.map(c => c.high)) + Math.min(...p26.map(c => c.low))) / 2;
  const spanA    = (tenkan + kijun) / 2;
  const spanB    = (Math.max(...p52.map(c => c.high)) + Math.min(...p52.map(c => c.low))) / 2;
  const kumoTop  = Math.max(spanA, spanB);
  const kumoBot  = Math.min(spanA, spanB);

  const aboveKumo = price > kumoTop;
  const belowKumo = price < kumoBot;
  const insideKumo = !aboveKumo && !belowKumo;

  let aligned = false;
  if (direction === 'BUY')  aligned = aboveKumo && tenkan > kijun;
  if (direction === 'SELL') aligned = belowKumo && tenkan < kijun;

  return {
    tenkan:     parseFloat(tenkan.toFixed(5)),
    kijun:      parseFloat(kijun.toFixed(5)),
    spanA:      parseFloat(spanA.toFixed(5)),
    spanB:      parseFloat(spanB.toFixed(5)),
    kumoTop:    parseFloat(kumoTop.toFixed(5)),
    kumoBot:    parseFloat(kumoBot.toFixed(5)),
    aboveKumo, belowKumo, insideKumo, aligned,
  };
}

/**
 * VWAP de Sessão (Volume Weighted Average Price)
 * Referência de "preço justo" do dia baseada em volume.
 *
 * Ancoragem: início do dia UTC (00:00 UTC) — reset automático a cada dia.
 * Preço típico = (high + low + close) / 3 por vela.
 * Para forex/XAU sem volume real: usa tick volume como proxy (ainda tem valor relativo).
 *
 * BUY:  preço > VWAP → mercado operando ACIMA do valor justo → pressão compradora
 * SELL: preço < VWAP → mercado operando ABAIXO do valor justo → pressão vendedora
 *
 * Retorna null se menos de 3 velas do dia disponíveis.
 */
function calcSessionVwap(candles, direction) {
  if (!candles || candles.length === 0) return null;

  const now = Date.now();
  const todayMidnight = now - (now % (24 * 60 * 60 * 1000));

  const todayCandles = candles.filter(c => {
    // MT5 candles usam c.time (Unix segundos); Twelve Data usa c.timestamp (ms)
    const ts = typeof c.timestamp === 'number'
      ? c.timestamp
      : (c.time ? c.time * 1000 : NaN);
    return ts >= todayMidnight;
  });

  if (todayCandles.length < 3) return null;

  let cumPV = 0, cumVol = 0;
  for (const c of todayCandles) {
    const typical = (c.high + c.low + c.close) / 3;
    const vol     = (c.volume && c.volume > 0) ? c.volume : 1;  // fallback: peso igual
    cumPV  += typical * vol;
    cumVol += vol;
  }

  if (cumVol === 0) return null;
  const vwap  = cumPV / cumVol;
  const price = todayCandles[todayCandles.length - 1].close;

  let aligned = false;
  if (direction === 'BUY')  aligned = price > vwap;
  if (direction === 'SELL') aligned = price < vwap;

  return {
    vwap:         parseFloat(vwap.toFixed(5)),
    aligned,
    candlesUsed:  todayCandles.length,
  };
}

// ─── FIBONACCI RETRACEMENT LEVELS ────────────────────────────────────────
function calcFibonacciLevels(candles, direction, lookback = 96) {
  if (!candles || candles.length < 10) return null;

  const slice     = candles.slice(-Math.min(lookback, candles.length));
  const swingHigh = Math.max(...slice.map(c => c.high));
  const swingLow  = Math.min(...slice.map(c => c.low));
  const range     = swingHigh - swingLow;
  if (range <= 0) return null;

  const price = candles[candles.length - 1].close;

  // Níveis clássicos de Fibonacci
  const FIB_RATIOS = [
    { ratio: 0,     label: '0.0%'  },
    { ratio: 0.236, label: '23.6%' },
    { ratio: 0.382, label: '38.2%' },  // zona de suporte leve
    { ratio: 0.5,   label: '50.0%' },  // zona de suporte média
    { ratio: 0.618, label: '61.8%' },  // zona de suporte forte (golden ratio)
    { ratio: 0.786, label: '78.6%' },  // zona de suporte profundo
    { ratio: 1.0,   label: '100%'  },
  ];

  // Para BUY: retracement de HIGH → LOW (suportes abaixo do swing high)
  // Para SELL: retracement de LOW → HIGH (resistências acima do swing low)
  const levels = FIB_RATIOS.map(({ ratio, label }) => ({
    ratio,
    label,
    price: parseFloat((
      direction === 'BUY'
        ? swingHigh - ratio * range   // mede de cima para baixo → pullback bullish
        : swingLow  + ratio * range   // mede de baixo para cima → pullback bearish
    ).toFixed(5)),
  }));

  // Nível mais próximo do preço atual
  const tolerance = range * 0.05;   // ±5% do range total (mais tolerante para ativos voláteis como XAUUSD)
  const KEY_RATIOS = [0.382, 0.5, 0.618, 0.786];

  const nearLevel = levels
    .filter(l => KEY_RATIOS.includes(l.ratio))
    .reduce((best, l) => {
      const dist = Math.abs(price - l.price);
      return (!best || dist < Math.abs(price - best.price)) ? l : best;
    }, null);

  const isNearKeyLevel = nearLevel && Math.abs(price - nearLevel.price) <= tolerance;

  // Alinhamento direcional: para BUY, preço deve estar abaixo do swing high (em retração)
  const inRetracementZone = direction === 'BUY'
    ? price < swingHigh && price > swingLow
    : price > swingLow  && price < swingHigh;

  return {
    swingHigh:       parseFloat(swingHigh.toFixed(5)),
    swingLow:        parseFloat(swingLow.toFixed(5)),
    range:           parseFloat(range.toFixed(5)),
    levels,
    nearLevel:       isNearKeyLevel ? nearLevel : null,
    isNearKeyLevel,
    inRetracementZone,
    // Bônus: preço próximo a nível chave E dentro da zona de retração
    aligned:         isNearKeyLevel && inRetracementZone,
  };
}

module.exports = {
  calcEMA,
  calcRSI,
  calcMACD,
  calcBollinger,
  calcATR,
  calcADX,
  calcSupportResistance,
  detectDivergence,
  calcIchimoku,
  calcSessionVwap,
  calcFibonacciLevels,
};
