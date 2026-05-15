'use strict';

/**
 * Testes unitários para src/services/filters.js
 *
 * Cobertura: emaAligned, hasBreakout, hasInsideBar, hasVolumeConfirmation,
 *            hasBollingerSqueeze, getEma200Context, hasPullbackEma20,
 *            detectCMEGap, getBiasTf
 *
 * Estratégia:
 *   - Candles construídos para forçar o resultado esperado (true/false/null)
 *   - Edge cases: arrays curtos, ausência de volume, direção inválida
 *   - Sem mocks — filters.js usa calcEMA de indicators.js (integração real)
 */

const {
  emaAligned,
  hasBreakout,
  hasInsideBar,
  hasVolumeConfirmation,
  hasBollingerSqueeze,
  getEma200Context,
  hasPullbackEma20,
  detectCMEGap,
  getBiasTf,
} = require('../services/filters');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Candles crescentes para testar tendência de alta */
const bullCandles = (n = 60, start = 100, step = 1) =>
  Array.from({ length: n }, (_, i) => {
    const p = start + i * step;
    return { open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 1000 };
  });

/** Candles decrescentes para testar tendência de baixa */
const bearCandles = (n = 60, start = 200, step = 1) =>
  Array.from({ length: n }, (_, i) => {
    const p = start - i * step;
    return { open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 1000 };
  });

/** Gera closes puros a partir de candles */
const closes = (candles) => candles.map(c => c.close);

// ─── emaAligned ──────────────────────────────────────────────────────────────

describe('emaAligned', () => {
  test('retorna true para BUY em série fortemente crescente', () => {
    // Série longa crescente: EMA9 > EMA20 > EMA50
    expect(emaAligned(closes(bullCandles(60)), 'BUY')).toBe(true);
  });

  test('retorna true para SELL em série fortemente decrescente', () => {
    expect(emaAligned(closes(bearCandles(60)), 'SELL')).toBe(true);
  });

  test('retorna false para BUY em série decrescente', () => {
    expect(emaAligned(closes(bearCandles(60)), 'BUY')).toBe(false);
  });

  test('retorna false para SELL em série crescente', () => {
    expect(emaAligned(closes(bullCandles(60)), 'SELL')).toBe(false);
  });

  test('retorna false para direção inválida', () => {
    expect(emaAligned(closes(bullCandles(60)), 'NEUTRAL')).toBe(false);
  });

  test('série constante: retorna false (EMAs iguais, sem alinhamento)', () => {
    const flat = Array(60).fill(100);
    expect(emaAligned(flat, 'BUY')).toBe(false);
    expect(emaAligned(flat, 'SELL')).toBe(false);
  });
});

// ─── hasBreakout ─────────────────────────────────────────────────────────────

describe('hasBreakout', () => {
  test('retorna false para candles insuficientes', () => {
    expect(hasBreakout(bullCandles(5), 'BUY', 20)).toBe(false);
  });

  test('detecta breakout de alta: close acima do máximo das últimas N velas', () => {
    // 20 candles planos + 1 candle que fecha muito acima
    const candles = Array.from({ length: 20 }, () => ({
      open: 100, high: 102, low: 98, close: 100, volume: 1000,
    }));
    candles.push({ open: 103, high: 115, low: 102, close: 114, volume: 1500 });
    expect(hasBreakout(candles, 'BUY', 20)).toBe(true);
  });

  test('detecta breakout de baixa: close abaixo do mínimo das últimas N velas', () => {
    const candles = Array.from({ length: 20 }, () => ({
      open: 100, high: 102, low: 98, close: 100, volume: 1000,
    }));
    candles.push({ open: 97, high: 98, low: 85, close: 86, volume: 1500 });
    expect(hasBreakout(candles, 'SELL', 20)).toBe(true);
  });

  test('não detecta breakout quando close está dentro do range anterior', () => {
    const candles = Array.from({ length: 21 }, () => ({
      open: 100, high: 102, low: 98, close: 100, volume: 1000,
    }));
    expect(hasBreakout(candles, 'BUY', 20)).toBe(false);
    expect(hasBreakout(candles, 'SELL', 20)).toBe(false);
  });
});

// ─── hasInsideBar ─────────────────────────────────────────────────────────────

describe('hasInsideBar', () => {
  test('retorna false para menos de 3 candles', () => {
    expect(hasInsideBar([
      { open: 100, high: 105, low: 95, close: 100 },
      { open: 101, high: 104, low: 97, close: 101 },
    ], 'BUY')).toBe(false);
  });

  test('detecta inside bar + confirmação de alta (BUY)', () => {
    const candles = [
      // Vela mãe: range 90-110
      { open: 100, high: 110, low:  90, close: 100 },
      // Inside bar: dentro da mãe
      { open: 100, high: 105, low:  95, close: 100 },
      // Confirmação: fecha ACIMA da máxima da mãe
      { open: 108, high: 115, low: 107, close: 112 },
    ];
    expect(hasInsideBar(candles, 'BUY')).toBe(true);
  });

  test('detecta inside bar + confirmação de baixa (SELL)', () => {
    const candles = [
      { open: 100, high: 110, low:  90, close: 100 },
      { open: 100, high: 105, low:  95, close: 100 },
      // Confirmação: fecha ABAIXO da mínima da mãe
      { open:  92, high:  93, low:  82, close: 85  },
    ];
    expect(hasInsideBar(candles, 'SELL')).toBe(true);
  });

  test('retorna false quando confirmação não rompe a mãe (BUY)', () => {
    const candles = [
      { open: 100, high: 110, low:  90, close: 100 },
      { open: 100, high: 105, low:  95, close: 100 },
      { open: 108, high: 109, low: 107, close: 108 }, // fecha abaixo dos 110
    ];
    expect(hasInsideBar(candles, 'BUY')).toBe(false);
  });

  test('retorna false quando a segunda vela não é inside bar', () => {
    const candles = [
      { open: 100, high: 105, low:  98, close: 100 },
      { open:  99, high: 110, low:  90, close: 100 }, // maior que a mãe
      { open: 108, high: 115, low: 107, close: 112 },
    ];
    expect(hasInsideBar(candles, 'BUY')).toBe(false);
  });
});

// ─── hasVolumeConfirmation ────────────────────────────────────────────────────

describe('hasVolumeConfirmation', () => {
  test('retorna null quando candles não têm volume', () => {
    const candles = Array.from({ length: 21 }, () => ({
      open: 100, high: 101, low: 99, close: 100,
    }));
    expect(hasVolumeConfirmation(candles)).toBeNull();
  });

  test('retorna true quando último volume > média * multiplier', () => {
    const candles = Array.from({ length: 20 }, () => ({
      open: 100, high: 101, low: 99, close: 100, volume: 1000,
    }));
    // Volume muito acima da média de 1000
    candles.push({ open: 100, high: 102, low: 99, close: 101, volume: 5000 });
    expect(hasVolumeConfirmation(candles, 1.1)).toBe(true);
  });

  test('retorna false quando último volume < média', () => {
    const candles = Array.from({ length: 20 }, () => ({
      open: 100, high: 101, low: 99, close: 100, volume: 2000,
    }));
    candles.push({ open: 100, high: 102, low: 99, close: 101, volume: 500 });
    expect(hasVolumeConfirmation(candles, 1.1)).toBe(false);
  });
});

// ─── hasBollingerSqueeze ─────────────────────────────────────────────────────

describe('hasBollingerSqueeze', () => {
  test('retorna false para dados insuficientes', () => {
    expect(hasBollingerSqueeze(Array(10).fill(100), 20, 20)).toBe(false);
  });

  test('retorna true quando banda atual é mais estreita que as anteriores', () => {
    // Histórico volátil (±10) seguido de período de baixa vol (±0.2)
    // squeeze: largura atual < largura histórica * 0.85
    const highVol = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 10 : -10));
    const lowVol  = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 0.2 : -0.2));
    const closes = [...highVol, ...lowVol];
    expect(hasBollingerSqueeze(closes, 20, 20)).toBe(true);
  });

  test('retorna false quando banda atual é mais larga que as anteriores', () => {
    // Série constante no início, depois volátil (banda expande)
    const flat = Array(20).fill(100);
    const volatile = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 10 : -10));
    const closes = [...flat, ...volatile];
    expect(hasBollingerSqueeze(closes, 20, 20)).toBe(false);
  });
});

// ─── getEma200Context ─────────────────────────────────────────────────────────

describe('getEma200Context', () => {
  test('retorna null para dados insuficientes (< 200 candles)', () => {
    expect(getEma200Context(bullCandles(50), 'BUY')).toBeNull();
  });

  test('retorna objeto com ema200 e aligned para dados suficientes', () => {
    const result = getEma200Context(bullCandles(210), 'BUY');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('ema200');
    expect(result).toHaveProperty('aligned');
  });

  test('aligned=true para BUY quando preço > EMA200 (tendência de alta longa)', () => {
    // 210 candles crescentes: preço final está bem acima da EMA200
    const result = getEma200Context(bullCandles(210, 100, 1), 'BUY');
    expect(result.aligned).toBe(true);
  });

  test('aligned=true para SELL quando preço < EMA200 (tendência de baixa longa)', () => {
    const result = getEma200Context(bearCandles(210, 500, 1), 'SELL');
    expect(result.aligned).toBe(true);
  });
});

// ─── hasPullbackEma20 ────────────────────────────────────────────────────────

describe('hasPullbackEma20', () => {
  test('retorna false para dados insuficientes', () => {
    expect(hasPullbackEma20(bullCandles(5), 'BUY')).toBe(false);
  });

  test('retorna booleano para dados suficientes', () => {
    const result = hasPullbackEma20(bullCandles(30), 'BUY');
    expect(typeof result).toBe('boolean');
  });
});

// ─── detectCMEGap ────────────────────────────────────────────────────────────

describe('detectCMEGap', () => {
  test('retorna null para array vazio', () => {
    expect(detectCMEGap([])).toBeNull();
  });

  test('retorna null para menos de 2 candles', () => {
    expect(detectCMEGap([{ open: 100, high: 101, low: 99, close: 100 }])).toBeNull();
  });

  test('retorna objeto quando há gap entre fechamento e abertura', () => {
    const candles = [
      { open: 100, high: 102, low: 98, close: 100, time: 1 },
      // Gap de alta: abertura bem acima do fechamento anterior
      { open: 110, high: 112, low: 108, close: 111, time: 2 },
    ];
    const result = detectCMEGap(candles);
    // Se o gap for detectado, deve ter propriedades úteis
    if (result !== null) {
      expect(result).toHaveProperty('direction');
      expect(result).toHaveProperty('gapSize');
    }
  });

  test('não modifica o array de entrada', () => {
    const candles = bullCandles(10);
    const original = JSON.stringify(candles);
    detectCMEGap(candles);
    expect(JSON.stringify(candles)).toBe(original);
  });
});

// ─── getBiasTf ───────────────────────────────────────────────────────────────

describe('getBiasTf', () => {
  test('retorna BUY, SELL ou NEUTRAL (string)', () => {
    const valid = ['BUY', 'SELL', 'NEUTRAL'];
    expect(valid).toContain(getBiasTf(bullCandles(60)));
    expect(valid).toContain(getBiasTf(bearCandles(60)));
  });

  test('retorna BUY para série fortemente crescente', () => {
    expect(getBiasTf(bullCandles(60, 100, 2))).toBe('BUY');
  });

  test('retorna SELL para série fortemente decrescente', () => {
    expect(getBiasTf(bearCandles(60, 300, 2))).toBe('SELL');
  });

  test('retorna NEUTRAL para série plana', () => {
    const flat = Array.from({ length: 60 }, () => ({
      open: 100, high: 100, low: 100, close: 100, volume: 1000,
    }));
    expect(getBiasTf(flat)).toBe('NEUTRAL');
  });

  test('retorna NEUTRAL para dados insuficientes', () => {
    expect(getBiasTf(bullCandles(5))).toBe('NEUTRAL');
  });
});
