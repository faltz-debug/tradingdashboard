// src/services/signals.js
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Motores de sinal â€” extraÃ­dos de server.js (passo 1 da refatoraÃ§Ã£o modular).
//
// Inclui:
//   â€¢ computeSignals(candles, assetName, dec, tf, marketData)     â€” sinal Master 15M
//   â€¢ computeVipSignal(assetKey, entryTf, biasTf, opts)            â€” motor VIP
//   â€¢ _signalCache + SIGNAL_CACHE_TTL_MS                            â€” cache da rota /api/vip/signal
//   â€¢ Helpers tightly-coupled: classifyMasterScore, getOperationalSnapshot,
//     buildSignalAudit, getOperationalContext.
//
// Os helpers de sessao + calendario economico (getSessionInfo, getNewsStatus,
// fetchEconomicCalendar) sao importados direto de src/services/context.js â€”
// padrao setContextProviders foi eliminado (commit anterior).
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const tradeStore        = require('../../tradeStore');
const MASTER_SIGNAL_CFG = require('../../signal-config');
const logger            = require('../../logger');

const {
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
} = require('./indicators');

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
  isHourBlocked,
  isSessionForbidden,
  isDirectionForbidden,
} = require('./filters');

const { fetchDxyTrend, fetchFearGreedIndex } = require('./marketContext');
const { ASSETS, ASSET_MAX_SCORE }            = require('./state');
const { getAsset }                           = require('./dataSources');
const { sendTelegram, lastSignals, saveLastSignals, buildVipTelegramMessage } = require('./telegram');

const {
  classifyMasterScore,
  computeMasterScoreFromSignals,
  sumVipScore,
  classifyVipStatus,
} = require('./score');

// Sessoes + calendario economico â€” antes injetados via setContextProviders.
const {
  getSessionInfo,
  getNewsStatus,
  fetchEconomicCalendar,
  getCurrentSessions,
} = require('./context');

// â”€â”€ ConfiguraÃ§Ãµes locais â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const VIP_SIGNAL_COOLDOWN_MS  = 2 * 60 * 60 * 1000; // 2h cooldown VIP (alerta Telegram)
// Pyramiding controlado: maximo de N trades simultaneos no MESMO ativo+direcao.
// Evita acumular posicao indefinida em tendencias longas (cada sinal VALID
// recorrente abriria um trade novo). Em 2, tendencias fortes ainda ganham
// uma adicao mas o risco fica capado em 2x o sizing por ativo+direcao.
const MAX_CONCURRENT_TRADES_PER_DIRECTION = 2;
const AUTO_BLOCK_WEAK_CONTEXT = process.env.AUTO_BLOCK_WEAK_CONTEXT !== 'false';

// Cache de resultado por ativo â€” evita recalcular ao trocar de ativo na UI
// TTL precisa ser >= ALERT_INTERVAL_MS para cobrir o gap entre ciclos de
// background. Sem OANDA o ciclo roda a cada 5 min; com OANDA a cada 2 min.
// Usando 7 min para garantir cobertura total (ciclo 5min + margem).
const SIGNAL_CACHE_TTL_MS = 7 * 60 * 1000;
const _signalCache        = {}; // { [cacheKey]: { data, cachedAt } }

// â”€â”€ Snapshot operacional (live price / bid-ask / entryBasis) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getOperationalSnapshot(marketData = null, direction = null, fallbackPrice = null) {
  const toNum = (value) => {
    if (value == null || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const bid = toNum(marketData?.bid ?? marketData?.live?.bid ?? marketData?.tick?.bid);
  const ask = toNum(marketData?.ask ?? marketData?.live?.ask ?? marketData?.tick?.ask);
  const livePrice = toNum(marketData?.live?.price ?? marketData?.price ?? fallbackPrice);
  const spread = toNum(marketData?.spread ?? ((bid != null && ask != null) ? (ask - bid) : null));

  let entryPrice = livePrice ?? fallbackPrice ?? null;
  let entryBasis = livePrice != null ? 'live_price' : 'candle_close';

  if (direction === 'BUY' && ask != null) {
    entryPrice = ask;
    entryBasis = 'ask';
  } else if (direction === 'SELL' && bid != null) {
    entryPrice = bid;
    entryBasis = 'bid';
  }

  return {
    livePrice,
    bid,
    ask,
    spread,
    entryPrice,
    entryBasis,
    source: marketData?.source || null,
    mode: marketData?.mode || 'ANALYSIS_ONLY',
    isOperational: marketData?.isOperational === true,
  };
}

// â”€â”€ Auditoria do sinal (regime + votos + bloqueadores + sessÃ£o + notÃ­cia) â”€â”€â”€
function buildSignalAudit(signal, assetKey) {
  const sessionInfo = getSessionInfo(assetKey);
  const newsInfo    = getNewsStatus(assetKey);
  const votes = [
    { key: 'trend', name: 'EMA TendÃªncia', signal: signal.trendSig },
    { key: 'momentum', name: 'RSI Momentum', signal: signal.rsiTrendSig },
    { key: 'breakout', name: 'Breakout 20', signal: signal.bkSig },
  ];
  const blockers = [];
  if (!signal.adxOk) blockers.push(`ADX baixo (${signal.adx.toFixed(1)})`);
  if (!sessionInfo.isGood) blockers.push(`Fora da sessÃ£o ideal (${sessionInfo.sessionStr})`);
  if (newsInfo.isNearNews) blockers.push(`NotÃ­cia prÃ³xima: ${newsInfo.nearName || 'alto impacto'}`);
  if (signal.bkSig === 'AGUARDAR') blockers.push('Sem breakout confirmado');
  if (signal.rsiTrendSig === 'NEUTRO') blockers.push(`RSI neutro (${signal.rsi.toFixed(1)})`);
  if (signal.trendSig === 'NEUTRO') blockers.push('EMAs sem alinhamento');

  return {
    regime: signal.adx >= 40 ? 'TREND_FORTE'
      : signal.adx >= 25 ? 'TREND_MODERADA'
      : signal.adx >= 15 ? 'TREND_FRACA'
      : 'LATERAL',
    scoreBeforeAdx: signal.rawScore,
    scoreAfterAdx: signal.score,
    labelBeforeAdx: classifyMasterScore(signal.rawScore),
    labelAfterAdx: signal.masterLabel,
    votes,
    bullishVotes: votes.filter(v => v.signal === 'COMPRA').map(v => v.name),
    bearishVotes: votes.filter(v => v.signal === 'VENDA').map(v => v.name),
    neutralVotes: votes.filter(v => !['COMPRA', 'VENDA'].includes(v.signal)).map(v => v.name),
    session: {
      isGood: sessionInfo.isGood,
      label: sessionInfo.sessionStr,
    },
    news: {
      isBlocked: newsInfo.isNearNews,
      name: newsInfo.nearName,
      time: newsInfo.nearTimeStr,
    },
    blockers,
  };
}

// â”€â”€ Contexto operacional (OPERAR / CAUTELA / EVITAR) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getOperationalContext(assetKey, signal) {
  const fallback = {
    status: 'CAUTELA',
    summary: 'Operar com cautela',
    detail: 'HistÃ³rico contextual ainda insuficiente para reforÃ§ar o sinal.',
    contextLine: 'Sem amostra suficiente neste contexto',
    rows: [],
  };

  if (!assetKey || !signal) return fallback;

  const stats = tradeStore.getLiveSignalStats();
  const audit = signal.audit || null;
  const rows = [];
  const assetRow = stats.byAsset?.[assetKey];
  const regimeRow = stats.byRegime?.[audit?.regime];
  const sessionRow = stats.bySession?.[audit?.session?.label];

  if (assetRow) rows.push({ group: 'asset', label: 'ativo', name: assetKey.toUpperCase(), ...assetRow });
  if (regimeRow) rows.push({ group: 'regime', label: 'regime', name: audit?.regime, ...regimeRow });
  if (sessionRow) rows.push({ group: 'session', label: 'sessÃ£o', name: audit?.session?.label, ...sessionRow });

  const weakRow = rows.find(r => r.health === 'WEAK');
  const strongRow = rows
    .filter(r => r.health === 'STRONG')
    .sort((a, b) => (b.total - a.total) || (b.winRate - a.winRate))[0];
  const mixedRow = rows
    .filter(r => r.health === 'MIXED')
    .sort((a, b) => (b.total - a.total) || (b.winRate - a.winRate))[0];
  const lowSampleOnly = rows.length > 0 && rows.every(r => r.health === 'LOW_SAMPLE');

  const blockers = [];
  const cautions = [];

  if ((signal.score || 0) === 0) blockers.push('Sem consenso entre os filtros');
  if (audit?.news?.isBlocked) blockers.push('NotÃ­cia de alto impacto prÃ³xima');
  if (weakRow) blockers.push(`Contexto historicamente fraco em ${weakRow.label}`);

  if (!audit?.session?.isGood) cautions.push('Fora da sessÃ£o ideal');
  if (audit?.regime === 'LATERAL' || audit?.regime === 'TREND_FRACA') cautions.push('Regime fraco ou lateral');
  if (mixedRow) cautions.push(`HistÃ³rico misto em ${mixedRow.label}`);
  if (!rows.length || lowSampleOnly) cautions.push('Amostra histÃ³rica insuficiente');
  if (Math.abs(signal.score || 0) < 2) cautions.push('Score operacional ainda fraco');

  if (blockers.length) {
    const main = weakRow
      ? `${weakRow.label} ${weakRow.name} com WR ${weakRow.winRate}% em ${weakRow.total} sinais`
      : blockers[0];
    return {
      status: 'EVITAR',
      summary: 'Evitar entrada agora',
      detail: main,
      contextLine: blockers.join(' | '),
      rows,
    };
  }

  const highConviction = Math.abs(signal.score || 0) >= 2
    && !!strongRow
    && audit?.session?.isGood
    && !audit?.news?.isBlocked
    && ['TREND_FORTE', 'TREND_MODERADA'].includes(audit?.regime);

  if (highConviction) {
    return {
      status: 'OPERAR',
      summary: 'Contexto favorÃ¡vel para operar',
      detail: `${strongRow.label} ${strongRow.name} com WR ${strongRow.winRate}% em ${strongRow.total} sinais`,
      contextLine: `HistÃ³rico forte neste contexto | ${strongRow.label} ${strongRow.name}`,
      rows,
    };
  }

  return {
    status: 'CAUTELA',
    summary: 'Operar com cautela',
    detail: cautions[0] || 'O sinal existe, mas o contexto ainda nÃ£o Ã© dos melhores.',
    contextLine: cautions.join(' | ') || 'Contexto misto ou amostra reduzida',
    rows,
  };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// computeSignals â€” Master Signal no timeframe entry (default 15M).
// Combina EMA TendÃªncia + RSI Momentum + Breakout 20 (score 0..3, com penal.
// ADX baixo). Retorna objeto com price, score, ATR/SL/TP, ADX, S/R, divergÃªncia
// e (se assetKey resolvido) audit + operationalContext.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function computeSignals(candles15m, assetName, dec, tf = '15M', marketData = null) {
  const closes = candles15m.map(c => c.close);
  const last   = closes.length - 1;
  const analysisPrice  = closes[last];
  let price = analysisPrice;

  const ema9  = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const rsi   = calcRSI(closes, 14);
  const { macd, signal: macdSig } = calcMACD(closes);
  const bb    = calcBollinger(closes, 20);

  // 1. EMA TendÃªncia
  const buyAligned  = ema9 > ema20 && ema20 > ema50;
  const sellAligned = ema9 < ema20 && ema20 < ema50;
  const aligned     = buyAligned || sellAligned;   // âœ… verdadeiro para BUY *e* SELL alinhados
  const trendSig    = buyAligned ? 'COMPRA' : sellAligned ? 'VENDA' : 'NEUTRO';

  // 2. EMA Crossover
  const emaSig = ema9 > ema20 ? 'COMPRA' : 'VENDA';

  // 3. RSI Momentum â€” confirma forÃ§a da tendÃªncia (â‰  RSI ReversÃ£o que usa 30/70)
  const rsiTrendSig = rsi > MASTER_SIGNAL_CFG.rsiBullish ? 'COMPRA'
                    : rsi < MASTER_SIGNAL_CFG.rsiBearish ? 'VENDA' : 'NEUTRO';

  // 4. Breakout (exclui vela atual â€” senÃ£o close nunca > prÃ³prio high)
  const prevCandles = candles15m.slice(-(MASTER_SIGNAL_CFG.breakoutLookback + 1), -1);
  const bkHigh = prevCandles.length ? Math.max(...prevCandles.map(c => c.high)) : analysisPrice;
  const bkLow  = prevCandles.length ? Math.min(...prevCandles.map(c => c.low))  : analysisPrice;
  let bkSig = 'AGUARDAR';
  if (analysisPrice > bkHigh) bkSig = 'COMPRA';
  else if (analysisPrice < bkLow) bkSig = 'VENDA';

  // RSI + Bollinger (ReversÃ£o)
  const rsiSig = rsi < 30 ? 'COMPRA' : rsi > 70 ? 'VENDA' : 'NEUTRO';
  const rsiReversalAlert = (rsi < 30 && analysisPrice <= bb.lower) || (rsi > 70 && analysisPrice >= bb.upper);

  // ADX â€” forÃ§a da tendÃªncia (calculado ANTES do score para que a penalidade
  // lateral seja aplicada de uma vez sÃ³ dentro de computeMasterScoreFromSignals)
  const { adx, pdi, mdi } = calcADX(candles15m);
  const adxTrend = adx >= MASTER_SIGNAL_CFG.adxStrong ? 'FORTE'
                 : adx >= MASTER_SIGNAL_CFG.adxTrendMin ? 'MODERADA'
                 : adx >= 15 ? 'FRACA' : 'LATERAL';
  const adxOk    = adx >= MASTER_SIGNAL_CFG.adxTrendMin;
  const adxDir   = pdi > mdi ? 'â†‘' : 'â†“';

  // Master Signal: EMA Trend (direÃ§Ã£o) + RSI Momentum (forÃ§a) + Breakout (nÃ­vel)
  // MACD removido: zero edge comprovado (14.3M backtests). RSI tem WR 60-65% validado.
  // Penalidade ADX baixo (lateral) reduz |score| pra 1 e troca labels p/ FRACA (LATERAL).
  const masterCalc = computeMasterScoreFromSignals({
    trendSig,
    rsiTrendSig,
    bkSig,
    isLateral: !adxOk,
  });
  const rawScore    = masterCalc.rawScore;
  const score       = masterCalc.score;
  const masterLabel = masterCalc.masterLabel;
  const masterEmoji = masterCalc.masterEmoji;
  const masterDir   = masterCalc.masterDir;

  // ATR-based Entry / SL / TP (usa direÃ§Ã£o final pÃ³s-lateral; sinal preservado)
  const atr     = calcATR(candles15m);
  const liveCtx = getOperationalSnapshot(marketData, masterDir, analysisPrice);
  price = liveCtx.livePrice ?? analysisPrice;
  let entry = liveCtx.entryPrice ?? analysisPrice, sl = null, tp = null;
  if (score > 0) {
    sl = entry - MASTER_SIGNAL_CFG.stopAtrMult * atr;
    tp = entry + MASTER_SIGNAL_CFG.takeAtrMult * atr;
  } else if (score < 0) {
    sl = entry + MASTER_SIGNAL_CFG.stopAtrMult * atr;
    tp = entry - MASTER_SIGNAL_CFG.takeAtrMult * atr;
  }

  // S/R + DivergÃªncia
  const sr  = calcSupportResistance(candles15m);
  const div = detectDivergence(candles15m);
  const assetKey = Object.entries(ASSETS).find(([, cfg]) => cfg.name === assetName)?.[0] || null;
  // Alerta de divergÃªncia vs direÃ§Ã£o do Master Signal
  const divAlert = masterDir ? {
    confirming: masterDir === 'BUY'  ? div.hasBullish : div.hasBearish,
    opposing:   masterDir === 'BUY'  ? div.hasBearish : div.hasBullish,
    signal:     div.signal,
  } : null;

  const signal = {
    asset: assetName, price, analysisPrice, dec, score, rawScore, masterLabel, masterEmoji, tf,
    trendSig, emaSig, rsiTrendSig, bkSig,
    rsi, rsiSig, rsiReversalAlert, bb,
    atr, entry, sl, tp, tfConfluence: [tf],
    adx, pdi, mdi, adxTrend, adxOk, adxDir,
    bid: liveCtx.bid, ask: liveCtx.ask, spread: liveCtx.spread,
    entryBasis: liveCtx.entryBasis, liveMode: liveCtx.mode, dataSource: liveCtx.source,
    sr, div, divAlert,
  };
  if (assetKey) {
    signal.audit = buildSignalAudit(signal, assetKey);
    signal.operationalContext = getOperationalContext(assetKey, signal);
  }

  return signal;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// computeVipSignal â€” Motor da Ãrea VIP.
// Avalia 5 filtros base + atÃ© 11 bÃ´nus (variando por ativo) â†’ score / maxScore.
// Persiste sinal+trade em tradeStore (skipPersist=true para modo scan/preview)
// e dispara alerta Telegram quando score qualifica como vÃ¡lido/parcial.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function computeVipSignal(assetKey, entryTf = '15m', biasTf = '1h', { skipPersist = false } = {}) {
  const cfg = ASSETS[assetKey];
  if (!cfg) throw new Error(`Ativo desconhecido: ${assetKey}`);

  const TF_MAP = { '15m': '15m', '1h': '1h', '4h': '4h', 'daily': 'daily', '1d': 'daily' };
  const entryKey = TF_MAP[entryTf] || '15m';
  const biasKey  = TF_MAP[biasTf]  || '1h';

  const _maxScore = ASSET_MAX_SCORE[assetKey] ?? 14;

  const data = await getAsset(assetKey);
  if (data.isSimulation) {
    return {
      success: false,
      asset: assetKey,
      biasTf,
      entryTf,
      maxScore: _maxScore,
      score: 0,
      status: 'SIMULATION_BLOCKED',
      reason: 'Sinal VIP indisponivel com dados simulados',
      filters: { emaAligned: false, breakout20: false, adxOk: false, sessionOk: false, newsBlocked: false },
      levels: null,
      meta: { reason: 'Fonte de dados em simulacao' },
    };
  }
  if (data.isMarketClosed) {
    return {
      success: false,
      asset: assetKey,
      biasTf,
      entryTf,
      maxScore: _maxScore,
      score: 0,
      status: 'MARKET_CLOSED',
      reason: 'Sinal VIP indisponivel com mercado fechado',
      filters: { emaAligned: false, breakout20: false, adxOk: false, sessionOk: false, newsBlocked: false },
      levels: null,
      meta: { reason: 'Mercado fechado' },
    };
  }
  const entryCandles = data[entryKey] || [];
  const biasCandles  = data[biasKey]  || [];

  if (entryCandles.length < 55 || biasCandles.length < 30) {
    return {
      success: false,
      asset: assetKey,
      maxScore: _maxScore,
      score: 0,
      status: 'INSUFFICIENT_DATA',
      reason: `Dados insuficientes: ${entryCandles.length} candles de entrada, ${biasCandles.length} de viÃ©s`,
    };
  }

  const closes = entryCandles.map(c => c.close);
  const analysisPrice  = entryCandles[entryCandles.length - 1].close;

  // FILTRO 1: ViÃ©s do timeframe maior
  const direction = getBiasTf(biasCandles);
  if (direction === 'NEUTRAL') {
    return {
      success: true, asset: assetKey, biasTf, entryTf, direction: 'NEUTRAL',
      score: 0, maxScore: _maxScore, status: 'NO_BIAS',
      filters: { emaAligned: false, breakout20: false, adxOk: false, sessionOk: false, newsBlocked: false },
      levels: null, meta: { reason: 'EMAs sem tendÃªncia definida no timeframe de viÃ©s' },
    };
  }

  // ─── HARD BLOCKS (executam ANTES do scoring, sem persistir/Telegram) ─────
  // Combos historicamente catastroficos (vide ASSET_FORBIDDEN_*).
  // Sample size ainda baixo (~5-9 trades por bucket) — revisar mensalmente.
  const _curSessions = getCurrentSessions();
  if (isHourBlocked()) {
    return {
      success: true, asset: assetKey, biasTf, entryTf, direction,
      score: 0, maxScore: _maxScore, status: 'HARD_BLOCK_HOUR',
      filters: { emaAligned: false, breakout20: false, adxOk: false, sessionOk: false, newsBlocked: false },
      levels: null, meta: { reason: `Hora UTC ${new Date().getUTCHours()}h bloqueada (BLOCKED_HOURS_UTC)` },
    };
  }
  if (isSessionForbidden(assetKey, _curSessions)) {
    return {
      success: true, asset: assetKey, biasTf, entryTf, direction,
      score: 0, maxScore: _maxScore, status: 'HARD_BLOCK_SESSION',
      filters: { emaAligned: false, breakout20: false, adxOk: false, sessionOk: false, newsBlocked: false },
      levels: null, meta: { reason: `Sessao proibida para ${assetKey} (ASSET_FORBIDDEN_SESSIONS)` },
    };
  }
  if (isDirectionForbidden(assetKey, direction)) {
    return {
      success: true, asset: assetKey, biasTf, entryTf, direction,
      score: 0, maxScore: _maxScore, status: 'HARD_BLOCK_DIRECTION',
      filters: { emaAligned: false, breakout20: false, adxOk: false, sessionOk: false, newsBlocked: false },
      levels: null, meta: { reason: `Direcao ${direction} proibida em ${assetKey} (ASSET_FORBIDDEN_DIRECTIONS)` },
    };
  }

  // FILTRO 2: EMAs alinhadas no entry TF
  const filterEma = emaAligned(closes, direction);

  // FILTRO 3: Breakout
  const filterBreakout = hasBreakout(entryCandles, direction, MASTER_SIGNAL_CFG.breakoutLookback);

  // FILTRO 4: ADX
  const { adx, pdi, mdi } = calcADX(entryCandles);
  const filterAdx = adx >= MASTER_SIGNAL_CFG.adxTrendMin;

  // FILTRO 5A: SessÃ£o ideal
  const sessionInfo   = getSessionInfo(assetKey);
  const filterSession = sessionInfo.isGood;

  // FILTRO 5B: Sem notÃ­cia forte
  await fetchEconomicCalendar();
  const newsInfo    = getNewsStatus(assetKey);
  const newsBlocked = newsInfo.isNearNews;

  // â”€â”€ FILTROS BÃ”NUS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Cada bÃ´nus vale +1 ponto (aditivos ao score base de 7)
  // Permite atingir VALID_SIGNAL (â‰¥7) mesmo sem um filtro base, se bÃ´nus compensam

  // BÃ”NUS 1: Inside Bar â€” compressÃ£o antes do rompimento
  const filterInsideBar = hasInsideBar(entryCandles, direction);

  // BÃ”NUS 2: Volume de confirmaÃ§Ã£o â€” vela atual acima da mÃ©dia 20 perÃ­odos
  // null = sem dados de volume â†’ neutro (nÃ£o penaliza nem pontua)
  const volumeConfirmed = hasVolumeConfirmation(entryCandles);
  const filterVolume = volumeConfirmed === true;  // sÃ³ pontua se confirmado explicitamente

  // BÃ”NUS 3: Bollinger Band Squeeze â€” compressÃ£o das bandas antes do breakout
  const entryCloses = closes;  // jÃ¡ calculado acima
  const filterBBSqueeze = hasBollingerSqueeze(entryCloses);

  // CONTEXTO MACRO: EMA 200 para XAU/USD (sem pontuaÃ§Ã£o â€” sÃ³ contexto/aviso)
  const ema200Ctx = assetKey === 'xauusd' ? getEma200Context(entryCandles, direction) : null;

  // BÃ”NUS 4: Ichimoku â€” USD/JPY usa como filtro principal; BTC tem forte tradiÃ§Ã£o de uso
  const ichimokuCtx    = (assetKey === 'usdjpy' || assetKey === 'btc')
    ? calcIchimoku(entryCandles, direction) : null;
  const filterIchimoku = ichimokuCtx?.aligned === true;

  // BÃ”NUS 5: VWAP de SessÃ£o â€” referÃªncia de valor justo do dia (BTC e XAU/USD)
  const vwapCtx    = (assetKey === 'btc' || assetKey === 'xauusd')
    ? calcSessionVwap(entryCandles, direction) : null;
  const filterVwap = vwapCtx?.aligned === true;

  // BÃ”NUS 6: Pullback EMA20 com confirmaÃ§Ã£o â€” entrada em pullback > entrada em extensÃ£o
  const filterPullback = hasPullbackEma20(entryCandles, direction);

  // BÃ”NUS 7: DivergÃªncia confirmando a direÃ§Ã£o (+1 se bullish_rsi/macd confirmam BUY,
  //           ou bearish confirmam SELL). DivergÃªncia contrÃ¡ria = aviso, sem penalidade no VIP.
  const divCtx = detectDivergence(entryCandles);
  const filterDivConfirm = (direction === 'BUY'  && divCtx.hasBullish)
                        || (direction === 'SELL' && divCtx.hasBearish);
  const divOpposing     = (direction === 'BUY'  && divCtx.hasBearish)
                        || (direction === 'SELL' && divCtx.hasBullish);

  // CONTEXTO: CME Gap para BTC (nÃ£o pontua â€” mas indica alvo estratÃ©gico)
  let cmeGapCtx = null;
  if (assetKey === 'btc') {
    cmeGapCtx = detectCMEGap(entryCandles);
    if (cmeGapCtx) {
      cmeGapCtx.alignedWithSignal = cmeGapCtx.fillerDirection === direction;
    }
  }

  // BÃ”NUS 8: Fibonacci â€” entrada prÃ³xima a nÃ­vel-chave de retraÃ§Ã£o (+1)
  // Lookback de 96 velas = ~24h no 15m (sessÃ£o diÃ¡ria completa)
  const fibCtx       = calcFibonacciLevels(entryCandles, direction, 96);
  const filterFib    = fibCtx?.aligned === true;

  // CONTEXTO + BÃ”NUS 9: DXY para XAU/USD â€” correlaÃ§Ã£o inversa com o dÃ³lar
  // DXY alinhado com sinal = +1 bÃ´nus; DXY contra = aviso (sem penalidade no score)
  let dxyCtx         = null;
  let filterDxy      = false;
  if (assetKey === 'xauusd') {
    dxyCtx    = await fetchDxyTrend(direction);
    filterDxy = dxyCtx?.xauAligned === true;
  }

  // BÃ”NUS 10: Bias 4H â€” filtro macro universal (EMA9/20/50 no 4H)
  // Alinha a direÃ§Ã£o do sinal com a tendÃªncia macro de 4 horas.
  // +1 se o 4H confirma a direÃ§Ã£o; aviso se opÃµe (sem penalidade).
  // Melhora estimada: +8â€“12% de precisÃ£o ao eliminar trades contra a macro.
  const candles4h      = data['4h'] || [];
  // getBiasTf ja exige internamente >= 30 candles (EMA50 precisa de 30+).
  // O threshold anterior (55) era maior que os ~37 candles 4H disponiveis via
  // agregacao de 600 candles 15m (600 Ã— 15min = 150h Ã· 4h = 37 candles 4H),
  // causando bias4h = 'NEUTRAL' mesmo em tendencias claras.
  const bias4h         = getBiasTf(candles4h);  // getBiasTf retorna NEUTRAL se < 30 candles
  const filter4hBias   = bias4h === direction;
  const bias4hOpposing = bias4h !== 'NEUTRAL' && bias4h !== direction;

  // BÃ”NUS 11: Fear & Greed Index â€” apenas BTC (API Alternative.me, gratuita)
  // Medo Extremo (â‰¤24) = +1 BUY | GanÃ¢ncia Extrema (â‰¥75) = +1 SELL
  // Neutro/Fear/Greed moderado = sem bÃ´nus (mas exibido no Telegram como contexto)
  let fngCtx       = null;
  let filterFng    = false;
  if (assetKey === 'btc') {
    fngCtx    = await fetchFearGreedIndex(direction);
    filterFng = fngCtx?.aligned === true;
  }

  // Score base: ema(2) + breakout(2) + adx(2) + session(1) = 7
  // BÃ´nus universais:  insideBar+volume+bbSqueeze+pullback+divConfirm+fib+bias4h = +7
  // BÃ´nus por ativo (fixos â€” nÃ£o variam com disponibilidade de API):
  //   USD/JPY:  + ichimoku(+1)                        = max 15
  //   BTC:      + ichimoku(+1) + vwap(+1) + fng(+1)  = max 17
  //   XAU/USD:  + vwap(+1)    + dxy(+1)              = max 16
  //   EUR/USD:  apenas os 7 universais                = max 14
  const maxScore = _maxScore; // definido no topo da funÃ§Ã£o via ASSET_MAX_SCORE (mÃ³dulo)

  // Soma dos pesos via score.js (centraliza tabela de pesos + penalidade de volume)
  const vipFilters = {
    ema:        filterEma,
    breakout:   filterBreakout,
    adx:        filterAdx,
    session:    filterSession,
    insideBar:  filterInsideBar,
    volume:     filterVolume,
    bbSqueeze:  filterBBSqueeze,
    ichimoku:   filterIchimoku,
    vwap:       filterVwap,
    pullback:   filterPullback,
    divConfirm: filterDivConfirm,
    fib:        filterFib,
    dxy:        filterDxy,
    fourHBias:  filter4hBias,
    fng:        filterFng,
  };
  const { score, bonusCount } = sumVipScore(vipFilters, { volumeConfirmed });

  // NÃ­veis operacionais (ATR-based, RR 1:2 fixo)
  const operationalFeed = getOperationalSnapshot(data, direction, analysisPrice);
  const livePrice = operationalFeed.livePrice ?? analysisPrice;
  const atr = calcATR(entryCandles) || (analysisPrice * 0.001);
  let entry = operationalFeed.entryPrice ?? analysisPrice, sl, tp;
  if (direction === 'BUY') {
    sl = parseFloat((entry - MASTER_SIGNAL_CFG.stopAtrMult * atr).toFixed(cfg.decimals));
    tp = parseFloat((entry + MASTER_SIGNAL_CFG.takeAtrMult * atr).toFixed(cfg.decimals));
  } else {
    sl = parseFloat((entry + MASTER_SIGNAL_CFG.stopAtrMult * atr).toFixed(cfg.decimals));
    tp = parseFloat((entry - MASTER_SIGNAL_CFG.takeAtrMult * atr).toFixed(cfg.decimals));
  }

  const vipOperationalContext = getOperationalContext(assetKey, {
    score,
    audit: {
      regime: adx >= MASTER_SIGNAL_CFG.adxStrong ? 'TREND_FORTE' : adx >= MASTER_SIGNAL_CFG.adxTrendMin ? 'TREND_MODERADA' : adx >= 15 ? 'TREND_FRACA' : 'LATERAL',
      session: { isGood: filterSession, label: sessionInfo.sessionStr },
      news: { isBlocked: newsBlocked, name: newsInfo.nearName, time: newsInfo.nearTimeStr },
    }
  });

  // bonusCount jÃ¡ vem de sumVipScore (centralizado em score.js)
  // maxScore calculado acima de forma dinÃ¢mica por ativo

  const contextBlocked = AUTO_BLOCK_WEAK_CONTEXT && vipOperationalContext?.status === 'EVITAR';
  const { status, reason } = classifyVipStatus({
    score,
    maxScore,
    bonusCount,
    direction,
    newsBlocked,
    newsInfo: { nearName: newsInfo.nearName, nearTimeStr: newsInfo.nearTimeStr },
    contextBlocked,
    contextDetail: vipOperationalContext?.detail,
  });

  const result = {
    success:   true,
    asset:     assetKey,
    biasTf,
    entryTf,
    direction,
    score,
    maxScore,
    status,
    filters: {
      // Filtros base
      emaAligned:  filterEma,
      breakout20:  filterBreakout,
      adxOk:       filterAdx,
      sessionOk:   filterSession,
      newsBlocked: newsBlocked,
      contextBlocked: AUTO_BLOCK_WEAK_CONTEXT && vipOperationalContext?.status === 'EVITAR',
      // Filtros bÃ´nus universais
      insideBar:    filterInsideBar,
      volumeOk:     filterVolume,
      volumeData:   volumeConfirmed,  // null = sem dados, true/false = confirmado/fraco
      bbSqueeze:    filterBBSqueeze,
      pullbackEma:  filterPullback,
      divConfirm:   filterDivConfirm,
      divOpposing:  divOpposing,       // aviso: divergÃªncia contra a direÃ§Ã£o
      // Filtros bÃ´nus por ativo
      ichimoku:     filterIchimoku,   // USD/JPY e BTC
      vwapOk:       filterVwap,       // BTC e XAU/USD
      fibOk:        filterFib,        // todos os ativos
      dxyOk:        filterDxy,        // XAU/USD apenas
      // Bias macro 4H â€” universal (todos os ativos)
      bias4hOk:       filter4hBias,   // 4H confirma direÃ§Ã£o
      bias4hOpposing: bias4hOpposing, // 4H opÃµe â†’ aviso
      // Fear & Greed â€” BTC only
      fngOk:          filterFng,      // extremo alinhado com direÃ§Ã£o
      fngOpposing:    fngCtx?.opposing ?? false, // extremo contra direÃ§Ã£o â†’ aviso
    },
    levels: {
      entry:   parseFloat(entry.toFixed(cfg.decimals)),
      sl,
      tp,
      atr:     parseFloat(atr.toFixed(cfg.decimals)),
      rr:      2.0,
      entryBasis: operationalFeed.entryBasis,
    },
    meta: {
      adx:     parseFloat(adx.toFixed(1)),
      pdi:     parseFloat(pdi.toFixed(1)),
      mdi:     parseFloat(mdi.toFixed(1)),
      session: sessionInfo.sessionStr,
      reason,
      price:   parseFloat(entry.toFixed(cfg.decimals)),
      analysisPrice: parseFloat(analysisPrice.toFixed(cfg.decimals)),
      livePrice: livePrice != null ? parseFloat(livePrice.toFixed(cfg.decimals)) : null,
      bid: operationalFeed.bid != null ? parseFloat(operationalFeed.bid.toFixed(cfg.decimals)) : null,
      ask: operationalFeed.ask != null ? parseFloat(operationalFeed.ask.toFixed(cfg.decimals)) : null,
      spread: operationalFeed.spread != null ? parseFloat(operationalFeed.spread.toFixed(cfg.decimals)) : null,
      entryBasis: operationalFeed.entryBasis,
      feedMode: data.mode || 'ANALYSIS_ONLY',
      feedSource: data.source || null,
      broker: data.broker || null,
      feedOperational: data.isOperational === true,
      newsInfo: newsBlocked ? { name: newsInfo.nearName, timeStr: newsInfo.nearTimeStr } : null,
      // Contexto macro XAU
      ema200: ema200Ctx ? {
        value:   ema200Ctx.ema200,
        aligned: ema200Ctx.aligned,
        warning: !ema200Ctx.aligned ? `âš ï¸ PreÃ§o ${direction === 'BUY' ? 'abaixo' : 'acima'} da EMA200 â€” entrada contra tendÃªncia macro` : null,
      } : null,
      // Ichimoku (USD/JPY e BTC)
      ichimoku: ichimokuCtx ? {
        tenkan:      ichimokuCtx.tenkan,
        kijun:       ichimokuCtx.kijun,
        kumoTop:     ichimokuCtx.kumoTop,
        kumoBot:     ichimokuCtx.kumoBot,
        aboveKumo:   ichimokuCtx.aboveKumo,
        belowKumo:   ichimokuCtx.belowKumo,
        insideKumo:  ichimokuCtx.insideKumo,
        aligned:     ichimokuCtx.aligned,
      } : null,
      // VWAP de sessÃ£o (BTC e XAU/USD)
      vwap: vwapCtx ? {
        value:       vwapCtx.vwap,
        aligned:     vwapCtx.aligned,
        candlesUsed: vwapCtx.candlesUsed,
      } : null,
      // DivergÃªncia RSI/MACD
      divergence: {
        signal:      divCtx.signal,
        hasBullish:  divCtx.hasBullish,
        hasBearish:  divCtx.hasBearish,
        confirming:  filterDivConfirm,
        opposing:    divOpposing,
        details:     divCtx.divergences.slice(0, 2),  // mÃ¡x 2 mais recentes
      },
      // CME Gap (BTC only)
      cmeGap: cmeGapCtx,
      // Fibonacci session high/low
      fibonacci: fibCtx ? {
        swingHigh:   fibCtx.swingHigh,
        swingLow:    fibCtx.swingLow,
        nearLevel:   fibCtx.nearLevel,
        aligned:     fibCtx.aligned,
        levels:      fibCtx.levels.filter(l => [0.382, 0.5, 0.618, 0.786].includes(l.ratio)),
      } : null,
      // DXY (XAU/USD only)
      dxy: dxyCtx ? {
        trend:       dxyCtx.dxyTrend,
        ema9:        dxyCtx.ema9,
        ema20:       dxyCtx.ema20,
        aligned:     dxyCtx.xauAligned,
        opposing:    dxyCtx.xauOpposing,
        warning:     dxyCtx.warning,
      } : null,
      // Bias 4H â€” universal
      bias4h: {
        trend:     bias4h,
        aligned:   filter4hBias,
        opposing:  bias4hOpposing,
        warning:   bias4hOpposing
          ? `âš ï¸ Macro 4H em ${bias4h} â€” sinal ${direction} vai contra a tendÃªncia maior`
          : null,
      },
      // Fear & Greed Index â€” BTC only
      fearGreed: fngCtx ? {
        value:          fngCtx.value,
        classification: fngCtx.classification,
        emoji:          fngCtx.emoji,
        aligned:        fngCtx.aligned,
        opposing:       fngCtx.opposing,
        warning:        fngCtx.warning,
      } : null,
    },
    operationalContext: vipOperationalContext,
    generatedAt: Date.now(),
  };

  // â”€â”€ HistÃ³rico do setup atual â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Filtra o histÃ³rico de sinais ao vivo pelo contexto exato deste setup:
  // mesmo ativo + direÃ§Ã£o + regime + sessÃ£o â†’ mostra WR e Ãºltimos resultados.
  const regime  = result.meta.adx >= 40 ? 'TREND_FORTE'
                : result.meta.adx >= 25 ? 'TREND_MODERADA'
                : result.meta.adx >= 15 ? 'TREND_FRACA' : 'LATERAL';
  const session = sessionInfo.sessionStr || null;

  // Contexto completo (mais especÃ­fico)
  const setupHistoryFull = tradeStore.getSetupHistory({
    asset:     assetKey,
    direction: direction === 'BUY' ? 'BUY' : 'SELL',
    regime,
    session,
  });

  // Fallback: sem sessÃ£o (relaxa um filtro se amostra insuficiente)
  const setupHistoryNoSession = !setupHistoryFull
    ? tradeStore.getSetupHistory({ asset: assetKey, direction, regime })
    : null;

  // Fallback 2: sÃ³ ativo + direÃ§Ã£o (mÃ¡xima amostra)
  const setupHistoryBase = (!setupHistoryFull && !setupHistoryNoSession)
    ? tradeStore.getSetupHistory({ asset: assetKey, direction })
    : null;

  result.setupHistory = setupHistoryFull || setupHistoryNoSession || setupHistoryBase || null;
  result.setupHistoryScope = setupHistoryFull   ? 'full'       // ativo+dir+regime+sessÃ£o
                           : setupHistoryNoSession ? 'no_session' // ativo+dir+regime
                           : setupHistoryBase      ? 'base'       // ativo+dir
                           : 'none';

  // Scan mode: não grava no histórico nem envia Telegram
  if (!skipPersist) {
    tradeStore.appendSignal(result);

    // ── Auto-abertura de trade para monitoramento automático de SL/TP ────────
    // Apenas sinais VALID (score ≥7) criam trades automáticos.
    // IMPORTANTE: quando BOT_WEBHOOK_ENABLED=true, o scheduler.js gerencia o
    // ciclo completo (openTrade + callBotWebhook → MT5). Criar trade local aqui
    // causaria duplicata no dashboard (1 "Local" + 1 "MT5 Confirmado" por sinal).
    // Neste modo, só criamos trade local se o webhook estiver desabilitado
    // (modo manual/monitoramento sem execução automática no MT5).
    const _webhookEnabled = process.env.BOT_WEBHOOK_ENABLED === 'true';
    if (!_webhookEnabled && status === 'VALID_SIGNAL' && result.levels?.sl && result.levels?.tp) {
      try {
        // Verifica se já existe trade aberto para este ativo+direção
        // (evita duplicar se o mesmo sinal for re-avaliado no ciclo)
        const existingOpen = tradeStore.listTrades({ asset: assetKey, status: 'open' });
        const alreadyOpen  = existingOpen.some(t => t.direction === direction
          && (Date.now() - (t.openedAt || 0)) < VIP_SIGNAL_COOLDOWN_MS);

        if (!alreadyOpen) {
          tradeStore.openTrade({
            asset:     assetKey,
            direction,
            biasTf,
            entryTf,
            entry:     result.levels.entry,
            sl:        result.levels.sl,
            tp:        result.levels.tp,
            atr:       result.levels.atr,
            rr:        result.levels.rr,
            score:     result.score,
            session:   result.meta.session,
            reason:    `AUTO | VIP VALID ${result.score}/${result.maxScore} | ${result.meta.reason}`,
          });
          logger.info(`Auto-trade aberto: ${assetKey.toUpperCase()} ${direction} score ${result.score}/${result.maxScore}`);
        }
      } catch (tradeErr) {
        logger.warn(`Erro ao auto-abrir trade ${assetKey}:`, tradeErr.message);
      }
    }
  }

  // ── Alerta Telegram para sinal VIP válido ou parcial ──────────────────────
  // Cooldown por chave ativo+direção+status para não repetir o mesmo sinal
  const vipAlertKey = `vip_${assetKey}_${direction}_${status}`;
  const prevVipAlert = lastSignals[vipAlertKey];
  const vipCooldownOk = !prevVipAlert?.lastSentAt || (Date.now() - prevVipAlert.lastSentAt) >= VIP_SIGNAL_COOLDOWN_MS;

  if (!skipPersist && vipCooldownOk && (status === 'VALID_SIGNAL' || status === 'PARTIAL_SIGNAL')) {
    const dirEmoji = direction === 'BUY' ? '📈' : '📉';
    const statusLabel = status === 'VALID_SIGNAL' ? '✅ SINAL VÁLIDO' : '⚡ SINAL PARCIAL';
    const scoreBar = '🟡'.repeat(Math.min(result.score, result.maxScore)) + '⚫'.repeat(Math.max(0, result.maxScore - result.score));
    const f = result.filters;
    const L = result.levels;
    const m = result.meta;

    // Linhas de bônus (só exibe os ativos para o ativo)
    const bonusLines = [];
    if (f.insideBar)    bonusLines.push(`⭐ Inside Bar confirmada`);
    if (f.volumeOk)     bonusLines.push(`⭐ Volume acima da média`);
    if (f.bbSqueeze)    bonusLines.push(`⭐ BB Squeeze (compressão)`);
    if (f.ichimoku)     bonusLines.push(`⭐ Ichimoku: preço ${m.ichimoku?.aboveKumo ? 'acima' : 'abaixo'} da Kumo + Tenkan/Kijun alinhados`);
    if (f.vwapOk)       bonusLines.push(`⭐ VWAP ${direction === 'BUY' ? 'bullish' : 'bearish'}: ${m.vwap?.value ?? '—'}`);
    if (f.pullbackEma)  bonusLines.push(`⭐ Pullback EMA20 com confirmação`);
    if (f.divConfirm)   bonusLines.push(`⭐ Divergência RSI/MACD confirmando ${direction}`);
    // Avisos
    if (f.volumeData === false && f.breakout20) bonusLines.push(`⚠️ Breakout com volume fraco (-1 ponto)`);
    if (f.fibOk)        bonusLines.push(`⭐ Fibonacci ${m.fibonacci?.nearLevel?.label ?? ''} — entrada em zona de retração chave`);
    if (f.dxyOk)        bonusLines.push(`⭐ DXY ${m.dxy?.trend === 'DOWN' ? '📉 caindo' : '📈 subindo'} — favorável para ${direction} em XAU`);
    if (f.bias4hOk)     bonusLines.push(`⭐ Bias 4H confirma ${direction} — macro alinhada com o sinal`);
    if (f.fngOk)        bonusLines.push(`⭐ Fear & Greed ${m.fearGreed?.emoji} ${m.fearGreed?.value} (${m.fearGreed?.classification}) — sentimento extremo confirma ${direction}`);
    if (f.divOpposing)  bonusLines.push(`⚠️ Divergência ${direction === 'BUY' ? 'bearish' : 'bullish'} detectada — sinal contrário ao trend`);
    if (f.bias4hOpposing) bonusLines.push(`⚠️ Macro 4H em ${m.bias4h?.trend} — ${direction} vai contra a tendência maior`);
    if (f.fngOpposing)  bonusLines.push(m.fearGreed?.warning);
    if (m.ema200 && !m.ema200.aligned) bonusLines.push(m.ema200.warning);
    if (m.ichimoku?.insideKumo) bonusLines.push(`⚠️ Preço DENTRO da Kumo — zona de transição, cautela`);
    if (m.dxy?.warning) bonusLines.push(m.dxy.warning);
    if (m.cmeGap && !m.cmeGap.gapFilled) {
      const gapDir = m.cmeGap.gapDirection === 'UP' ? '📈' : '📉';
      const aligned = m.cmeGap.alignedWithSignal ? '✅ alinhado com o sinal' : '⚠️ contra o sinal';
      bonusLines.push(`${gapDir} CME Gap ${m.cmeGap.gapDirection} de ${m.cmeGap.gapPct}% — Alvo de fill: ${m.cmeGap.fillTarget} (${aligned})`);
    }

    const vipMsg = [
      `⭐ <b>ÁREA VIP — ${statusLabel}</b>`,
      ``,
      `<b>${cfg.name}</b> ${dirEmoji} <b>${direction}</b>  |  Score: ${result.score}/${result.maxScore}`,
      `${scoreBar}`,
      ``,
      `🎯 <b>Níveis</b>`,
      `Entry: <b>${L.entry}</b>`,
      `Stop:  <b>${L.sl}</b>  (-1.5×ATR)`,
      `Alvo:  <b>${L.tp}</b>  (+3.0×ATR)`,
      `ATR: ${L.atr}  |  R:R 1:2`,
      ``,
      `📋 <b>Filtros Base</b>`,
      `${f.emaAligned  ? '✅' : '❌'} EMAs alinhadas (${entryTf})`,
      `${f.breakout20  ? '✅' : '❌'} Breakout ${MASTER_SIGNAL_CFG.breakoutLookback} barras`,
      `${f.adxOk       ? '✅' : '❌'} ADX ${m.adx} (≥25)`,
      `${f.sessionOk   ? '✅' : '❌'} Sessão: ${m.session}`,
      `${!f.newsBlocked ? '✅' : '⚠️'} Notícias: ${f.newsBlocked ? 'BLOQUEADO' : 'Livre'}`,
      ...(bonusLines.length > 0 ? [``, `🚀 <b>Filtros Bônus</b>`, ...bonusLines] : []),
      ``,
      `🧭 <b>Contexto Operacional</b>`,
      `${result.operationalContext.status} — ${result.operationalContext.summary}`,
      `${result.operationalContext.detail}`,
      ``,
      `Bias: ${biasTf.toUpperCase()}  |  Entry: ${entryTf.toUpperCase()}  |  Macro 4H: ${bias4h}`
        + (fngCtx ? `  |  F&G: ${fngCtx.emoji}${fngCtx.value}` : ''),
    ].join('\n');

    sendTelegram(vipMsg).catch(() => {});
    lastSignals[vipAlertKey] = { lastSentAt: Date.now() };
    saveLastSignals();
  }

  return result;
}

module.exports = {
  // Helpers (re-exportados — server.js continua chamando alguns deles)
  classifyMasterScore,
  getOperationalSnapshot,
  buildSignalAudit,
  getOperationalContext,
  // Motores
  computeSignals,
  computeVipSignal,
  // Cache compartilhado com a rota /api/vip/signal
  _signalCache,
  SIGNAL_CACHE_TTL_MS,
  // Constantes
  VIP_SIGNAL_COOLDOWN_MS,
};
