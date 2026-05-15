/**
 * signal-config.js — Fonte Única de Verdade para parâmetros do Master Signal
 *
 * Usado em:
 *   • server.js       → const MASTER_SIGNAL_CFG = require('./signal-config')
 *   • backtester.html → <script src="/signal-config.js">
 *   • dashboard.html  → <script src="/signal-config.js">
 *
 * NUNCA duplique esses valores. Qualquer mudança aqui reflete automaticamente
 * em todos os três contextos. Isso evita divergências entre backtester e live.
 */

// eslint-disable-next-line no-unused-vars
const MASTER_SIGNAL_CFG = {
  // ── Breakout ─────────────────────────────────────────────────────────────
  // Número de candles para determinar high/low de referência.
  // Valor maior → menos sinais de breakout, mais seletivo.
  breakoutLookback: 30,

  // ── RSI Momentum ─────────────────────────────────────────────────────────
  // Thresholds para confirmação de força direcional (não reversão).
  // RSI entre 45–55 = sem direção → sinal ignorado.
  rsiBullish: 55,
  rsiBearish: 45,

  // ── ADX ──────────────────────────────────────────────────────────────────
  // Mínimo para considerar que existe tendência ativa.
  // Abaixo de adxTrendMin o score é rebaixado para ±1.
  adxTrendMin: 25,
  // ADX a partir do qual a tendência é classificada como FORTE.
  adxStrong: 40,

  // ── SL / TP (multiplicadores de ATR) ─────────────────────────────────────
  // Risco:Recompensa implícito = takeAtrMult / stopAtrMult = 2:1 mínimo.
  stopAtrMult: 1.5,   // SL = entry ± stopAtrMult × ATR
  takeAtrMult: 3.0,   // TP = entry ∓ takeAtrMult × ATR

  // ── Execução realista ─────────────────────────────────────────────────────
  // Slippage base em % do preço de entrada, aplicado na direção desfavorável.
  // 0.015% é conservador para ativos líquidos (XAU, BTC, majors forex).
  slippagePct: 0.015,

  // Multiplicador de spread em janelas de notícias de alto impacto.
  // Em NFP, FOMC, CPI o spread real triplica ou mais.
  newsSpreadMult: 3.0,
};

// Exporta para Node.js sem quebrar o browser (onde `module` não existe)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MASTER_SIGNAL_CFG;
}
