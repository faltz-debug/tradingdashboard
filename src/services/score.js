'use strict';

/**
 * src/services/score.js
 *
 * Camada de SCORING isolada — funcoes puras (sem I/O, sem cache, sem DB)
 * que recebem o resultado dos indicadores/filtros e devolvem score + label.
 *
 * Extraido de src/services/signals.js para que a logica de pontuacao possa
 * ser testada/ajustada de forma independente do pipeline pesado de fetch
 * de candles e providers de contexto.
 *
 * ── DUAS CAMADAS DE SCORE ──────────────────────────────────────────────
 *  1) MASTER (escala -3..+3) — usado em computeSignals/dashboard.
 *     EMA Tendencia (1) + RSI Momentum (1) + Breakout 20 (1).
 *     Penalidade de regime: ADX < adxTrendMin (laterizado) reduz |score| pra 1.
 *
 *  2) VIP (escala 0..maxScore) — usado em computeVipSignal/area VIP.
 *     5 filtros base (ema=2, breakout=2, adx=2, session=1, insideBar=1) +
 *     ate 11 bonus universais e por ativo (volume, bbSqueeze, ichimoku,
 *     vwap, pullback, divConfirm, fib, dxy, 4h-bias, fng).
 *     Penalidade: breakout com volume fraco (-1).
 *
 * @module services/score
 */

// ─────────────────────────────────────────────────────────────────────────
// MASTER SCORE — escala -3..+3
// ─────────────────────────────────────────────────────────────────────────

/**
 * Mapeia score numerico para o label classico do Master Signal.
 * @param {number} score
 * @returns {string}
 */
function classifyMasterScore(score) {
  if (score >= 3)   return 'FORTE COMPRA';
  if (score === 2)  return 'COMPRA MODERADA';
  if (score <= -3)  return 'FORTE VENDA';
  if (score === -2) return 'VENDA MODERADA';
  return 'NEUTRO';
}

/**
 * Mapeia score numerico para o emoji exibido no dashboard.
 * @param {number} score
 * @returns {string}
 */
function masterEmojiFor(score) {
  if (score >= 3)   return '🟢';
  if (score === 2)  return '🟡';
  if (score <= -3)  return '🔴';
  if (score === -2) return '🟠';
  return '⚪';
}

/** Mapping interno de string → peso na soma master. */
const MASTER_SIG_MAP = { COMPRA: 1, VENDA: -1 };

/**
 * Combina os 3 sinais base do Master (trend EMA, RSI momentum, breakout 20)
 * num score -3..+3 e devolve label/emoji/direcao.
 *
 * Quando `isLateral=true` (ADX baixo / regime sem tendencia), o |score| eh
 * reduzido para 1 e os labels viram FRACA (LATERAL).
 *
 * @param {object} args
 * @param {string} args.trendSig     — 'COMPRA' | 'VENDA' | outro
 * @param {string} args.rsiTrendSig  — 'COMPRA' | 'VENDA' | outro
 * @param {string} args.bkSig        — 'COMPRA' | 'VENDA' | outro
 * @param {boolean} args.isLateral   — ADX abaixo do limiar de tendencia
 * @returns {{rawScore:number, score:number, masterLabel:string, masterEmoji:string, masterDir:('BUY'|'SELL'|null)}}
 */
function computeMasterScoreFromSignals({ trendSig, rsiTrendSig, bkSig, isLateral }) {
  const rawScore = [trendSig, rsiTrendSig, bkSig]
    .map(s => MASTER_SIG_MAP[s] || 0)
    .reduce((a, b) => a + b, 0);

  let score, masterLabel, masterEmoji;
  if (isLateral) {
    // Regime lateral: corta forca para evitar entradas em range
    score = rawScore > 0 ? 1 : rawScore < 0 ? -1 : 0;
    masterLabel = score > 0
      ? 'COMPRA FRACA (LATERAL)'
      : score < 0 ? 'VENDA FRACA (LATERAL)' : 'NEUTRO';
    masterEmoji = score > 0 ? '🟡' : score < 0 ? '🟠' : '⚪';
  } else {
    score = rawScore;
    masterLabel = classifyMasterScore(score);
    masterEmoji = masterEmojiFor(score);
  }

  const masterDir = score > 0 ? 'BUY' : score < 0 ? 'SELL' : null;
  return { rawScore, score, masterLabel, masterEmoji, masterDir };
}

// ─────────────────────────────────────────────────────────────────────────
// VIP SCORE — escala 0..maxScore (varia por ativo)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Pesos dos filtros no score VIP. Mantido como objeto explicito (em vez de
 * espalhado em ifs encadeados) pra facilitar tuning futuro e visibilidade
 * em testes/relatorios.
 */
const VIP_FILTER_WEIGHTS = Object.freeze({
  // Filtros base (peso 2 ou 1)
  ema:        2,
  breakout:   2,
  adx:        2,
  session:    1,
  insideBar:  1,
  // Bonus universais (todos peso 1)
  volume:     1,
  bbSqueeze:  1,
  ichimoku:   1,  // BTC, USDJPY
  vwap:       1,  // BTC, XAUUSD
  pullback:   1,
  divConfirm: 1,
  fib:        1,
  dxy:        1,  // XAUUSD
  fourHBias:  1,
  fng:        1,  // BTC
});

/**
 * Filtros que NAO contam como bonus (sao base — usados em status === VALID).
 * Mantem alinhado com o comentario do topo do modulo: 5 filtros base
 * (ema=2, breakout=2, adx=2, session=1, insideBar=1).
 */
const VIP_BASE_FILTER_KEYS = Object.freeze(['ema', 'breakout', 'adx', 'session', 'insideBar']);

/**
 * Soma os pesos dos filtros ativados (`true` no objeto `filters`) e aplica
 * a penalidade de volume (breakout confirmado mas com volume abaixo da media).
 *
 * @param {Object<string, boolean>} filters       — flags de cada filtro
 * @param {Object} [opts]
 * @param {boolean|null} [opts.volumeConfirmed]   — null = sem dados; true/false = OK/fraco
 * @returns {{score:number, bonusCount:number}}
 */
function sumVipScore(filters, { volumeConfirmed = null } = {}) {
  let score = 0;
  let bonusCount = 0;

  for (const [key, weight] of Object.entries(VIP_FILTER_WEIGHTS)) {
    if (!filters[key]) continue;
    score += weight;
    if (!VIP_BASE_FILTER_KEYS.includes(key)) bonusCount++;
  }

  // Penalidade: breakout com volume explicitamente fraco
  if (filters.breakout && volumeConfirmed === false) score -= 1;

  return { score, bonusCount };
}

/**
 * Decide o status final + razao textual para um sinal VIP, com base no
 * score absoluto e nos blocos de noticia/contexto.
 *
 * Ordem de precedencia (early-return):
 *   NEWS_BLOCKED > CONTEXT_BLOCKED > VALID(score>=7) > PARTIAL(score>=4) > NO_SIGNAL
 *
 * @param {object} args
 * @param {number}  args.score
 * @param {number}  args.maxScore
 * @param {number}  args.bonusCount
 * @param {string}  args.direction       — 'BUY' | 'SELL' | null
 * @param {boolean} args.newsBlocked
 * @param {object}  [args.newsInfo]      — { nearName, nearTimeStr }
 * @param {boolean} args.contextBlocked
 * @param {string}  [args.contextDetail] — explicacao do bloqueio de contexto
 * @returns {{status:string, reason:string}}
 */
function classifyVipStatus({
  score,
  maxScore,
  bonusCount,
  direction,
  newsBlocked,
  newsInfo,
  contextBlocked,
  contextDetail,
}) {
  if (newsBlocked) {
    const nearName = newsInfo?.nearName || 'evento de alto impacto';
    const nearTime = newsInfo?.nearTimeStr || '';
    return {
      status: 'NEWS_BLOCKED',
      reason: `Bloqueado por notícia: ${nearName} (${nearTime})`,
    };
  }

  if (contextBlocked) {
    return {
      status: 'CONTEXT_BLOCKED',
      reason: `Bloqueado por contexto: ${contextDetail || 'condicoes operacionais desfavoraveis'}`,
    };
  }

  if (score >= 7) {
    const bonusNote = bonusCount > 0 ? ` + ${bonusCount} bônus ativo(s)` : '';
    const dirEmoji  = direction === 'BUY' ? '📈 Compra' : '📉 Venda';
    return {
      status: 'VALID_SIGNAL',
      reason: `Setup completo confirmado${bonusNote}. ${dirEmoji} com alta convicção.`,
    };
  }

  if (score >= 4) {
    return {
      status: 'PARTIAL_SIGNAL',
      reason: `Filtros parciais (${score}/${maxScore}). Aguardar confirmação adicional.`,
    };
  }

  return {
    status: 'NO_SIGNAL',
    reason: `Condições insuficientes (${score}/${maxScore}). Sem setup VIP no momento.`,
  };
}

module.exports = {
  // Master
  classifyMasterScore,
  masterEmojiFor,
  computeMasterScoreFromSignals,
  // VIP
  VIP_FILTER_WEIGHTS,
  VIP_BASE_FILTER_KEYS,
  sumVipScore,
  classifyVipStatus,
};
