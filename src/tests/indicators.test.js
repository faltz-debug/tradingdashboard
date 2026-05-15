'use strict';

/**
 * Testes unitários para src/services/indicators.js
 *
 * Cobertura: calcEMA, calcRSI, calcMACD, calcBollinger, calcATR, calcADX,
 *            calcSupportResistance, detectDivergence
 *
 * Estratégia:
 *   - Entradas controladas onde o resultado matemático é verificável à mão
 *   - Edge cases: arrays vazios, dados insuficientes, valores constantes
 *   - Tolerância de ±0.01 para erros de ponto flutuante (toBeCloseTo 2 casas)
 */

const {
  calcEMA,
  calcRSI,
  calcMACD,
  calcBollinger,
  calcATR,
  calcADX,
  calcSupportResistance,
  detectDivergence,
} = require('../services/indicators');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Gera array de closes constante — EMA deve convergir ao próprio valor */
const constCloses = (val, n) => Array(n).fill(val);

/** Gera candle simples com OHLC iguais (útil para ATR/ADX sem ruído) */
const flatCandle = (price, vol = 1000) => ({
  open: price, high: price, low: price, close: price, volume: vol,
});

/** Gera candles com trend claro (incremento constante) */
const trendCandles = (start, step, n) =>
  Array.from({ length: n }, (_, i) => {
    const p = start + i * step;
    return { open: p, high: p + Math.abs(step) * 0.5, low: p - Math.abs(step) * 0.5, close: p, volume: 1000 };
  });

// ─── calcEMA ─────────────────────────────────────────────────────────────────

describe('calcEMA', () => {
  test('retorna 0 para array vazio', () => {
    expect(calcEMA([], 9)).toBe(0);
  });

  test('retorna o próprio valor para array com 1 elemento', () => {
    expect(calcEMA([100], 9)).toBe(100);
  });

  test('converge ao valor constante em série constante', () => {
    // Série de 100s → EMA deve ser exatamente 100 (independente do período)
    expect(calcEMA(constCloses(100, 50), 9)).toBeCloseTo(100, 2);
    expect(calcEMA(constCloses(100, 50), 20)).toBeCloseTo(100, 2);
  });

  test('EMA de período 1 é igual ao último valor', () => {
    const closes = [10, 20, 30, 40, 50];
    expect(calcEMA(closes, 1)).toBe(50);
  });

  test('EMA curta reage mais rápido que EMA longa em tendência de alta', () => {
    const closes = Array.from({ length: 60 }, (_, i) => i + 1); // 1..60
    const ema9  = calcEMA(closes, 9);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    expect(ema9).toBeGreaterThan(ema20);
    expect(ema20).toBeGreaterThan(ema50);
  });

  test('EMA de série descendente: curta < longa', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 60 - i); // 60..1
    const ema9  = calcEMA(closes, 9);
    const ema20 = calcEMA(closes, 20);
    expect(ema9).toBeLessThan(ema20);
  });
});

// ─── calcRSI ─────────────────────────────────────────────────────────────────

describe('calcRSI', () => {
  test('retorna 50 para dados insuficientes (≤ período)', () => {
    expect(calcRSI([100, 101, 102], 14)).toBe(50);
  });

  test('retorna 100 para série sempre crescente (sem perdas)', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(calcRSI(closes, 14)).toBe(100);
  });

  test('retorna 0 para série sempre decrescente (sem ganhos)', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(calcRSI(closes, 14)).toBe(0);
  });

  test('retorna ~50 para série alternando ±1 (gains ≈ losses)', () => {
    const closes = [];
    for (let i = 0; i < 30; i++) closes.push(100 + (i % 2 === 0 ? 1 : -1));
    const rsi = calcRSI(closes, 14);
    expect(rsi).toBeGreaterThan(40);
    expect(rsi).toBeLessThan(60);
  });

  test('RSI fica entre 0 e 100', () => {
    const closes = Array.from({ length: 30 }, () => Math.random() * 100 + 50);
    const rsi = calcRSI(closes, 14);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });
});

// ─── calcMACD ────────────────────────────────────────────────────────────────

describe('calcMACD', () => {
  test('retorna objeto com macd e signal', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const result = calcMACD(closes);
    expect(result).toHaveProperty('macd');
    expect(result).toHaveProperty('signal');
  });

  test('macd > 0 em tendência de alta forte', () => {
    // Série crescente: EMA12 > EMA26 → MACD positivo
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
    const { macd } = calcMACD(closes);
    expect(macd).toBeGreaterThan(0);
  });

  test('macd < 0 em tendência de baixa forte', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 200 - i * 2);
    const { macd } = calcMACD(closes);
    expect(macd).toBeLessThan(0);
  });

  test('série constante: macd ≈ 0', () => {
    const closes = constCloses(100, 40);
    const { macd, signal } = calcMACD(closes);
    expect(macd).toBeCloseTo(0, 5);
    expect(signal).toBeCloseTo(0, 5);
  });

  test('funciona com array de tamanho mínimo (1 elemento)', () => {
    const result = calcMACD([100]);
    expect(typeof result.macd).toBe('number');
    expect(typeof result.signal).toBe('number');
  });
});

// ─── calcBollinger ───────────────────────────────────────────────────────────

describe('calcBollinger', () => {
  test('retorna upper, mid, lower', () => {
    const closes = constCloses(100, 25);
    const result = calcBollinger(closes);
    expect(result).toHaveProperty('upper');
    expect(result).toHaveProperty('mid');
    expect(result).toHaveProperty('lower');
  });

  test('série constante: bandas colapsadas (std=0)', () => {
    const closes = constCloses(100, 25);
    const { upper, mid, lower } = calcBollinger(closes);
    expect(mid).toBeCloseTo(100, 5);
    expect(upper).toBeCloseTo(100, 5);
    expect(lower).toBeCloseTo(100, 5);
  });

  test('upper > mid > lower para série com variância > 0', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + (i % 5) * 2);
    const { upper, mid, lower } = calcBollinger(closes);
    expect(upper).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(lower);
  });

  test('mid é a SMA dos últimos 20 valores', () => {
    const closes = Array.from({ length: 30 }, (_, i) => i + 1); // 1..30
    const last20 = closes.slice(-20);
    const sma = last20.reduce((a, b) => a + b, 0) / 20;
    const { mid } = calcBollinger(closes, 20);
    expect(mid).toBeCloseTo(sma, 5);
  });
});

// ─── calcATR ─────────────────────────────────────────────────────────────────

describe('calcATR', () => {
  test('retorna 0 para array com menos de 2 candles', () => {
    expect(calcATR([flatCandle(100)])).toBe(0);
    expect(calcATR([])).toBe(0);
  });

  test('ATR ≈ range da vela em série de velas sem gap e range constante', () => {
    // Velas com high=102, low=98 (range=4), sem gap entre fechamentos
    const candles = Array.from({ length: 20 }, () => ({
      open: 100, high: 102, low: 98, close: 100, volume: 1000,
    }));
    const atr = calcATR(candles, 14);
    expect(atr).toBeCloseTo(4, 1);
  });

  test('ATR aumenta com candles de range maior', () => {
    const smallRange = Array.from({ length: 20 }, () => ({
      open: 100, high: 101, low: 99, close: 100, volume: 1000,
    }));
    const largeRange = Array.from({ length: 20 }, () => ({
      open: 100, high: 110, low: 90, close: 100, volume: 1000,
    }));
    expect(calcATR(largeRange, 14)).toBeGreaterThan(calcATR(smallRange, 14));
  });

  test('retorna número não-negativo', () => {
    const candles = trendCandles(100, 1, 20);
    expect(calcATR(candles, 14)).toBeGreaterThanOrEqual(0);
  });
});

// ─── calcADX ─────────────────────────────────────────────────────────────────

describe('calcADX', () => {
  test('retorna { adx:0, pdi:0, mdi:0 } para dados insuficientes', () => {
    const result = calcADX(trendCandles(100, 1, 10), 14);
    expect(result).toEqual({ adx: 0, pdi: 0, mdi: 0 });
  });

  test('retorna objeto com adx, pdi, mdi', () => {
    const candles = trendCandles(100, 1, 50);
    const result = calcADX(candles, 14);
    expect(result).toHaveProperty('adx');
    expect(result).toHaveProperty('pdi');
    expect(result).toHaveProperty('mdi');
  });

  test('ADX entre 0 e 100', () => {
    const candles = trendCandles(100, 2, 60);
    const { adx } = calcADX(candles, 14);
    expect(adx).toBeGreaterThanOrEqual(0);
    expect(adx).toBeLessThanOrEqual(100);
  });

  test('tendência de alta: pdi > mdi', () => {
    // Série fortemente crescente → +DI deve superar -DI
    const candles = trendCandles(100, 3, 60);
    const { pdi, mdi } = calcADX(candles, 14);
    expect(pdi).toBeGreaterThan(mdi);
  });

  test('tendência de baixa: mdi > pdi', () => {
    const candles = trendCandles(200, -3, 60);
    const { pdi, mdi } = calcADX(candles, 14);
    expect(mdi).toBeGreaterThan(pdi);
  });
});

// ─── calcSupportResistance ───────────────────────────────────────────────────

describe('calcSupportResistance', () => {
  test('retorna objeto com supports, resistances, nearestSup, nearestRes', () => {
    const candles = trendCandles(100, 0.5, 30);
    const result = calcSupportResistance(candles, 3);
    expect(result).toHaveProperty('supports');
    expect(result).toHaveProperty('resistances');
    expect(result).toHaveProperty('nearestSup');
    expect(result).toHaveProperty('nearestRes');
  });

  test('retorna arrays vazios para dados insuficientes', () => {
    const { supports, resistances } = calcSupportResistance(
      trendCandles(100, 1, 5), 5
    );
    expect(supports).toEqual([]);
    expect(resistances).toEqual([]);
  });

  test('detecta swing high como resistência', () => {
    // Pico claro no meio: sobe, pico, desce
    const candles = [
      { open: 100, high: 100, low: 98,  close: 100, time: 1 },
      { open: 101, high: 101, low: 99,  close: 101, time: 2 },
      { open: 102, high: 102, low: 100, close: 102, time: 3 },
      { open: 105, high: 110, low: 104, close: 105, time: 4 }, // swing high
      { open: 103, high: 104, low: 102, close: 103, time: 5 },
      { open: 101, high: 102, low: 100, close: 101, time: 6 },
      { open: 100, high: 101, low: 99,  close: 100, time: 7 },
      { open: 99,  high: 100, low: 98,  close:  99, time: 8 },
      { open: 98,  high: 99,  low: 97,  close:  98, time: 9 },
    ];
    const { resistances } = calcSupportResistance(candles, 2);
    expect(resistances.some(r => r.price === 110)).toBe(true);
  });
});

// ─── detectDivergence ────────────────────────────────────────────────────────

describe('detectDivergence', () => {
  test('retorna objeto com divergences, hasBullish, hasBearish', () => {
    const candles = trendCandles(100, 1, 30);
    const result = detectDivergence(candles, 14);
    expect(result).toHaveProperty('divergences');
    expect(result).toHaveProperty('hasBullish');
    expect(result).toHaveProperty('hasBearish');
    expect(Array.isArray(result.divergences)).toBe(true);
  });

  test('série constante: sem divergências', () => {
    const candles = Array.from({ length: 30 }, () => ({
      open: 100, high: 100, low: 100, close: 100, volume: 1000,
    }));
    const { divergences } = detectDivergence(candles, 14);
    expect(divergences).toHaveLength(0);
  });

  test('hasBullish e hasBearish são booleanos', () => {
    const candles = trendCandles(100, 1, 40);
    const { hasBullish, hasBearish } = detectDivergence(candles, 14);
    expect(typeof hasBullish).toBe('boolean');
    expect(typeof hasBearish).toBe('boolean');
  });

  test('não modifica o array de candles de entrada', () => {
    const candles = trendCandles(100, 1, 30);
    const original = JSON.stringify(candles);
    detectDivergence(candles, 14);
    expect(JSON.stringify(candles)).toBe(original);
  });
});
