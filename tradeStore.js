'use strict';
/**
 * tradeStore.js — Persistência JSON para a Área VIP
 * Gerencia: sinais VIP, trades abertos e trades fechados
 * MVP: JSON em disco (data/vip_trades.json)
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'vip_trades.json');
const SIGNAL_FILE = path.join(DATA_DIR, 'vip_signals.json');
const LIVE_SIGNAL_FILE = path.join(DATA_DIR, 'live_signal_audit.json');
const LIVE_SIGNAL_LIMIT = 5000;
const LIVE_SIGNAL_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

// Garante que o diretório data/ existe
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ===== HELPERS DE I/O =====
function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.warn(`⚠️  tradeStore: erro ao ler ${file}: ${e.message}`);
    return fallback;
  }
}

let _saveTradeTimer = null;
let _saveSignalTimer = null;
let _saveLiveSignalTimer = null;

function writeJSON(file, data, timerRef, setTimer) {
  if (timerRef) clearTimeout(timerRef);
  const t = setTimeout(() => {
    fs.writeFile(file, JSON.stringify(data, null, 2), (err) => {
      if (err) console.warn(`⚠️  tradeStore: erro ao salvar ${file}: ${err.message}`);
    });
  }, 300);
  setTimer(t);
}

// ===== ESTADO EM MEMÓRIA =====
let _trades  = readJSON(STORE_FILE,  { open: [], closed: [] });
let _signals = readJSON(SIGNAL_FILE, []);
let _liveSignals = readJSON(LIVE_SIGNAL_FILE, []);

// Garante estrutura mínima
if (!_trades.open)   _trades.open   = [];
if (!_trades.closed) _trades.closed = [];
if (!Array.isArray(_signals)) _signals = [];
if (!Array.isArray(_liveSignals)) _liveSignals = [];

function pruneLiveSignals() {
  const cutoff = Date.now() - LIVE_SIGNAL_MAX_AGE_MS;
  _liveSignals = _liveSignals
    .filter(item => (item?.createdAt || item?.emittedAt || 0) >= cutoff)
    .slice(0, LIVE_SIGNAL_LIMIT);
}

pruneLiveSignals();

function persistTrades() {
  writeJSON(STORE_FILE, _trades, _saveTradeTimer, (t) => { _saveTradeTimer = t; });
}
function persistSignals() {
  writeJSON(SIGNAL_FILE, _signals, _saveSignalTimer, (t) => { _saveSignalTimer = t; });
}
function persistLiveSignals() {
  pruneLiveSignals();
  writeJSON(LIVE_SIGNAL_FILE, _liveSignals, _saveLiveSignalTimer, (t) => { _saveLiveSignalTimer = t; });
}

// ===== SINAIS VIP =====
/**
 * Salva um snapshot de sinal VIP no histórico (máx 500 por ativo)
 */
function appendSignal(signalObj) {
  _signals.unshift({ ...signalObj, savedAt: Date.now() });
  // Limita a 500 entradas totais
  if (_signals.length > 500) _signals.length = 500;
  persistSignals();
}

/**
 * Lista sinais do histórico, filtrado por asset e/ou status
 * @param {object} opts - { asset?, status?, limit? }
 */
function listSignals({ asset, status, limit = 100 } = {}) {
  let items = _signals;
  if (asset)  items = items.filter(s => s.asset  === asset);
  if (status) items = items.filter(s => s.status === status);
  return items.slice(0, limit);
}

// ===== SINAIS AO VIVO AUDITÁVEIS =====
function appendLiveSignal(signalObj) {
  const duplicate = _liveSignals.find(s =>
    s.asset === signalObj.asset &&
    s.tf === signalObj.tf &&
    s.label === signalObj.label &&
    s.emittedCandleTime === signalObj.emittedCandleTime
  );
  if (duplicate) return duplicate;

  const item = {
    id: `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
    ...signalObj,
    evaluation: {
      status: 'PENDING',
      horizonCandles: signalObj.horizonCandles || 4,
      outcomeType: null,
      evaluatedAt: null,
      evaluationPrice: null,
      evaluationCandleTime: null,
      realizedPct: null,
      candlesElapsed: null,
    }
  };

  _liveSignals.unshift(item);
  pruneLiveSignals();
  persistLiveSignals();
  return item;
}

function evaluateLiveSignals({ asset, candles, tf = '15m', horizonCandles = 4 } = {}) {
  if (!asset || !Array.isArray(candles) || !candles.length) return 0;
  const indexByTime = new Map(candles.map((c, i) => [c.time, i]));
  let updates = 0;

  for (const item of _liveSignals) {
    if (item.asset !== asset || item.tf !== tf) continue;
    if (item.evaluation?.status !== 'PENDING') continue;

    const entryIdx = indexByTime.get(item.emittedCandleTime);
    if (entryIdx == null) continue;

    const horizon = item.evaluation?.horizonCandles || horizonCandles;
    const targetIdx = entryIdx + horizon;
    if (targetIdx >= candles.length) continue;

    const futureCandles = candles.slice(entryIdx + 1, targetIdx + 1);
    const hasLevels = item.slPrice != null && item.tpPrice != null;
    let resolvedByLevel = false;
    let exitPrice = null;
    let exitCandle = null;
    let outcomeType = 'HORIZON';

    if (hasLevels) {
      for (const candle of futureCandles) {
        const hitTp = item.direction === 'BUY'
          ? candle.high >= item.tpPrice
          : candle.low <= item.tpPrice;
        const hitSl = item.direction === 'BUY'
          ? candle.low <= item.slPrice
          : candle.high >= item.slPrice;

        if (hitTp && hitSl) {
          // Regra conservadora: assume SL primeiro quando TP e SL cabem na mesma vela.
          exitPrice = item.slPrice;
          exitCandle = candle;
          outcomeType = 'SL_HIT_SAME_BAR';
          resolvedByLevel = true;
          break;
        }
        if (hitSl) {
          exitPrice = item.slPrice;
          exitCandle = candle;
          outcomeType = 'SL_HIT';
          resolvedByLevel = true;
          break;
        }
        if (hitTp) {
          exitPrice = item.tpPrice;
          exitCandle = candle;
          outcomeType = 'TP_HIT';
          resolvedByLevel = true;
          break;
        }
      }
    }

    if (!resolvedByLevel) {
      exitCandle = candles[targetIdx];
      exitPrice = exitCandle.close;
      outcomeType = 'HORIZON';
    }

    const rawPct = item.direction === 'BUY'
      ? ((exitPrice - item.entryPrice) / item.entryPrice) * 100
      : ((item.entryPrice - exitPrice) / item.entryPrice) * 100;

    item.evaluation.status = rawPct > 0 ? 'WIN' : rawPct < 0 ? 'LOSS' : 'FLAT';
    item.evaluation.outcomeType = outcomeType;
    item.evaluation.evaluatedAt = Date.now();
    item.evaluation.evaluationPrice = exitPrice;
    item.evaluation.evaluationCandleTime = exitCandle.time;
    item.evaluation.realizedPct = parseFloat(rawPct.toFixed(4));
    item.evaluation.candlesElapsed = Math.max(1, indexByTime.get(exitCandle.time) - entryIdx);
    updates++;
  }

  if (updates) persistLiveSignals();
  return updates;
}

function listLiveSignals({ asset, status, limit = 100 } = {}) {
  let items = _liveSignals;
  if (asset) items = items.filter(s => s.asset === asset);
  if (status) items = items.filter(s => (s.evaluation?.status || 'PENDING') === status);
  return items.slice(0, limit);
}

function pickBestRow(group, groupMap, { preferPositive = true } = {}) {
  return Object.entries(groupMap || {})
    .map(([name, row]) => ({ group, name, ...row }))
    .filter(row => row.total > 0)
    .sort((a, b) => {
      const aScore = (a.winRate || 0) + (a.sumPct || 0) * (preferPositive ? 2 : -2);
      const bScore = (b.winRate || 0) + (b.sumPct || 0) * (preferPositive ? 2 : -2);
      return preferPositive
        ? (bScore - aScore) || (b.winRate - a.winRate) || (b.sumPct - a.sumPct)
        : (aScore - bScore) || (a.winRate - b.winRate) || (a.sumPct - b.sumPct);
    })[0] || null;
}

function buildDrawdownStats(resolved) {
  let equity = 0;
  let peak = 0;
  let troughFromPeak = 0;
  let maxDrawdownPct = 0;
  const curve = [];

  resolved.forEach(item => {
    equity += item.evaluation?.realizedPct || 0;
    peak = Math.max(peak, equity);
    troughFromPeak = equity - peak;
    maxDrawdownPct = Math.min(maxDrawdownPct, troughFromPeak);
    curve.push({
      at: item.evaluation?.evaluatedAt || item.createdAt || Date.now(),
      equityPct: parseFloat(equity.toFixed(3)),
      drawdownPct: parseFloat(troughFromPeak.toFixed(3)),
    });
  });

  return {
    curve,
    cumulativePct: parseFloat(equity.toFixed(3)),
    maxDrawdownPct: parseFloat(Math.abs(maxDrawdownPct).toFixed(3)),
    currentDrawdownPct: parseFloat(Math.abs(troughFromPeak).toFixed(3)),
  };
}

function buildStreakStats(resolved) {
  let currentWin = 0;
  let currentLoss = 0;
  let maxWin = 0;
  let maxLoss = 0;

  resolved.forEach(item => {
    const status = item.evaluation?.status;
    if (status === 'WIN') {
      currentWin += 1;
      currentLoss = 0;
    } else if (status === 'LOSS') {
      currentLoss += 1;
      currentWin = 0;
    } else {
      currentWin = 0;
      currentLoss = 0;
    }
    maxWin = Math.max(maxWin, currentWin);
    maxLoss = Math.max(maxLoss, currentLoss);
  });

  return {
    currentWin,
    currentLoss,
    maxWin,
    maxLoss,
  };
}

function buildRecentStats(resolved, windowSize = 20) {
  const recent = resolved.slice(-windowSize);
  const wins = recent.filter(item => item.evaluation?.status === 'WIN').length;
  const losses = recent.filter(item => item.evaluation?.status === 'LOSS').length;
  const flats = recent.filter(item => item.evaluation?.status === 'FLAT').length;
  const total = recent.length;
  const avgPct = total
    ? recent.reduce((sum, item) => sum + (item.evaluation?.realizedPct || 0), 0) / total
    : 0;

  let verdict = 'NEUTRO';
  if (total >= 5 && wins / total >= 0.58 && avgPct > 0) verdict = 'QUENTE';
  else if (total >= 5 && losses / total >= 0.5 && avgPct < 0) verdict = 'FRIO';

  return {
    windowSize,
    total,
    wins,
    losses,
    flats,
    winRate: total ? parseFloat(((wins / total) * 100).toFixed(1)) : 0,
    avgPct: parseFloat(avgPct.toFixed(3)),
    verdict,
  };
}

function buildDailyBreakdown(resolved, maxDays = 7) {
  const map = {};
  resolved.forEach(item => {
    const ts = item.evaluation?.evaluatedAt || item.createdAt;
    if (!ts) return;
    const key = new Date(ts).toISOString().slice(0, 10);
    if (!map[key]) map[key] = { total: 0, wins: 0, losses: 0, flats: 0, sumPct: 0 };
    const row = map[key];
    row.total++;
    if (item.evaluation?.status === 'WIN') row.wins++;
    else if (item.evaluation?.status === 'LOSS') row.losses++;
    else row.flats++;
    row.sumPct += item.evaluation?.realizedPct || 0;
  });
  return Object.entries(map)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-maxDays)
    .map(([date, row]) => ({
      date,
      total: row.total,
      wins: row.wins,
      losses: row.losses,
      flats: row.flats,
      winRate: row.total ? parseFloat(((row.wins / row.total) * 100).toFixed(1)) : 0,
      sumPct: parseFloat(row.sumPct.toFixed(3)),
    }));
}

function getLiveSignalStats({ asset } = {}) {
  let items = _liveSignals;
  if (asset) items = items.filter(s => s.asset === asset);

  const resolved = items.filter(s => s.evaluation?.status && s.evaluation.status !== 'PENDING');
  const wins = resolved.filter(s => s.evaluation.status === 'WIN');
  const losses = resolved.filter(s => s.evaluation.status === 'LOSS');
  const flats = resolved.filter(s => s.evaluation.status === 'FLAT');

  const classifyBucket = (row) => {
    if (!row || row.total < 5) return 'LOW_SAMPLE';
    if (row.winRate >= 58 && row.sumPct > 0) return 'STRONG';
    if (row.winRate <= 45 && row.sumPct < 0) return 'WEAK';
    return 'MIXED';
  };

  const groupMetric = (keyFn) => {
    const map = {};
    resolved.forEach(item => {
      const key = keyFn(item) || 'N/A';
      if (!map[key]) map[key] = { total: 0, wins: 0, losses: 0, flats: 0, sumPct: 0 };
      map[key].total++;
      if (item.evaluation.status === 'WIN') map[key].wins++;
      else if (item.evaluation.status === 'LOSS') map[key].losses++;
      else map[key].flats++;
      map[key].sumPct += item.evaluation.realizedPct || 0;
    });
    Object.values(map).forEach(row => {
      row.winRate = row.total ? parseFloat(((row.wins / row.total) * 100).toFixed(1)) : 0;
      row.sumPct = parseFloat(row.sumPct.toFixed(2));
      row.health = classifyBucket(row);
    });
    return map;
  };

  const buildRanking = (groupName, groupMap) => Object.entries(groupMap || {})
    .map(([name, row]) => ({
      group: groupName,
      name,
      total: row.total,
      winRate: row.winRate,
      sumPct: row.sumPct,
      health: row.health,
      score: parseFloat((row.winRate + row.sumPct * 2).toFixed(2)),
    }))
    .sort((a, b) => (b.score - a.score) || (b.winRate - a.winRate) || (b.sumPct - a.sumPct));

  const byAsset = groupMetric(item => item.asset);
  const byRegime = groupMetric(item => item.audit?.regime);
  const bySession = groupMetric(item => item.audit?.session?.label);
  const byDirection = groupMetric(item => item.direction);
  const byOutcomeType = groupMetric(item => item.evaluation?.outcomeType);
  const resolvedOrdered = [...resolved].sort((a, b) =>
    ((a.evaluation?.evaluatedAt || a.createdAt || 0) - (b.evaluation?.evaluatedAt || b.createdAt || 0))
  );
  const drawdown = buildDrawdownStats(resolvedOrdered);
  const streaks = buildStreakStats(resolvedOrdered);
  const recent = buildRecentStats(resolvedOrdered, 20);
  const recentDaily = buildDailyBreakdown(resolvedOrdered, 7);
  const rankedContexts = [
    ...buildRanking('asset', byAsset),
    ...buildRanking('regime', byRegime),
    ...buildRanking('session', bySession),
    ...buildRanking('direction', byDirection),
  ];
  const strongContexts = rankedContexts.filter(r => r.health === 'STRONG').slice(0, 5);
  const weakContexts = rankedContexts.filter(r => r.health === 'WEAK').slice(0, 5);
  const bestAsset = pickBestRow('asset', byAsset, { preferPositive: true });
  const worstAsset = pickBestRow('asset', byAsset, { preferPositive: false });
  const bestSession = pickBestRow('session', bySession, { preferPositive: true });
  const worstRegime = pickBestRow('regime', byRegime, { preferPositive: false });

  let operationalStatus = 'ESTAVEL';
  if (recent.verdict === 'FRIO' || drawdown.currentDrawdownPct >= 1.5 || streaks.currentLoss >= 3) {
    operationalStatus = 'DEFENSIVO';
  } else if (recent.verdict === 'QUENTE' && drawdown.currentDrawdownPct <= 0.4 && streaks.currentLoss === 0) {
    operationalStatus = 'AGRESSIVO_CONTROLADO';
  }

  return {
    totalSignals: items.length,
    pending: items.filter(s => s.evaluation?.status === 'PENDING').length,
    evaluated: resolved.length,
    winRate: resolved.length ? parseFloat(((wins.length / resolved.length) * 100).toFixed(1)) : 0,
    wins: wins.length,
    losses: losses.length,
    flats: flats.length,
    avgPct: resolved.length ? parseFloat((resolved.reduce((a, s) => a + (s.evaluation.realizedPct || 0), 0) / resolved.length).toFixed(3)) : 0,
    byAsset,
    byRegime,
    bySession,
    byDirection,
    byOutcomeType,
    rankedContexts,
    strongContexts,
    weakContexts,
    recent,
    recentDaily,
    drawdown,
    streaks,
    executive: {
      bestAsset,
      worstAsset,
      bestSession,
      worstRegime,
      operationalStatus,
      historyStartAt: items[items.length - 1]?.createdAt || null,
      historyEndAt: items[0]?.createdAt || null,
      lastResolvedAt: resolvedOrdered[resolvedOrdered.length - 1]?.evaluation?.evaluatedAt || null,
    },
  };
}

// ===== TRADES =====
/**
 * Abre um novo trade VIP
 * @param {object} t - { asset, direction, entry, sl, tp, atr, rr, score, biasTf, entryTf, session, reason }
 * @returns {object} trade criado com id e timestamps
 */
function openTrade(t) {
  const trade = {
    id:        `vip-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    asset:     t.asset,
    direction: t.direction,   // 'BUY' | 'SELL'
    biasTf:    t.biasTf,
    entryTf:   t.entryTf,
    entry:     t.entry,
    sl:        t.sl,
    tp:        t.tp,
    atr:       t.atr,
    rr:        t.rr,
    score:     t.score,
    session:   t.session,
    reason:    t.reason || '',
    status:    'open',
    openedAt:  Date.now(),
    closedAt:  null,
    closePrice: null,
    pnlPct:   null,
    pnlR:     null,    // lucro em múltiplos de R (risco)
    outcome:  null,    // 'TP' | 'SL' | 'MANUAL'
  };
  _trades.open.push(trade);
  persistTrades();
  return trade;
}

/**
 * Fecha um trade aberto
 * @param {string} id - trade id
 * @param {object} opts - { closePrice, outcome } — outcome: 'TP'|'SL'|'MANUAL'
 * @returns {object|null} trade fechado ou null se não encontrado
 */
function closeTrade(id, { closePrice, outcome = 'MANUAL' } = {}) {
  if (closePrice == null || isNaN(closePrice)) return null;
  const idx = _trades.open.findIndex(t => t.id === id);
  if (idx === -1) return null;

  const trade = _trades.open[idx];
  _trades.open.splice(idx, 1);

  const risk = Math.abs(trade.entry - trade.sl);
  const rawPnl = trade.direction === 'BUY'
    ? closePrice - trade.entry
    : trade.entry - closePrice;

  const closed = {
    ...trade,
    status:     'closed',
    closedAt:   Date.now(),
    closePrice: closePrice,
    outcome:    outcome,
    pnlPct:     risk > 0 ? parseFloat(((rawPnl / trade.entry) * 100).toFixed(4)) : 0,
    pnlR:       risk > 0 ? parseFloat((rawPnl / risk).toFixed(2)) : 0,
  };
  _trades.closed.unshift(closed);
  // Limita histórico a 1000 trades fechados
  if (_trades.closed.length > 1000) _trades.closed.length = 1000;
  persistTrades();
  return closed;
}

/**
 * Lista trades (open | closed | all) por ativo
 * @param {object} opts - { asset?, status?, limit? }
 */
function listTrades({ asset, status, limit = 100 } = {}) {
  let items;
  if (status === 'open')        items = _trades.open;
  else if (status === 'closed') items = _trades.closed;
  else                          items = [..._trades.open, ..._trades.closed].sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));

  if (asset) items = items.filter(t => t.asset === asset);
  return items.slice(0, limit);
}

/**
 * Retorna métricas de performance dos trades fechados
 * @param {object} opts - { asset? }
 */
function getStats({ asset } = {}) {
  let closed = _trades.closed;
  if (asset) closed = closed.filter(t => t.asset === asset);

  if (closed.length === 0) {
    return { trades: 0, winRate: 0, avgR: 0, totalR: 0, bestR: 0, worstR: 0, byOutcome: {}, bySession: {}, byAsset: {} };
  }

  const wins = closed.filter(t => (t.pnlR || 0) > 0);
  const totalR = closed.reduce((s, t) => s + (t.pnlR || 0), 0);
  const avgR   = totalR / closed.length;
  const bestR  = Math.max(...closed.map(t => t.pnlR || 0));
  const worstR = Math.min(...closed.map(t => t.pnlR || 0));

  // Agrupa por outcome
  const byOutcome = {};
  closed.forEach(t => {
    const k = t.outcome || 'MANUAL';
    byOutcome[k] = (byOutcome[k] || 0) + 1;
  });

  // Agrupa por sessão
  const bySession = {};
  closed.forEach(t => {
    const k = t.session || 'Sem Sessão';
    if (!bySession[k]) bySession[k] = { trades: 0, totalR: 0 };
    bySession[k].trades++;
    bySession[k].totalR += (t.pnlR || 0);
  });
  Object.values(bySession).forEach(s => {
    s.totalR = parseFloat(s.totalR.toFixed(2));
    s.avgR   = parseFloat((s.totalR / s.trades).toFixed(2));
  });

  // Agrupa por asset
  const byAsset = {};
  closed.forEach(t => {
    const k = t.asset;
    if (!byAsset[k]) byAsset[k] = { trades: 0, totalR: 0 };
    byAsset[k].trades++;
    byAsset[k].totalR += (t.pnlR || 0);
  });
  Object.values(byAsset).forEach(a => {
    a.totalR = parseFloat(a.totalR.toFixed(2));
    a.avgR   = parseFloat((a.totalR / a.trades).toFixed(2));
  });

  return {
    trades:   closed.length,
    winRate:  parseFloat(((wins.length / closed.length) * 100).toFixed(1)),
    avgR:     parseFloat(avgR.toFixed(2)),
    totalR:   parseFloat(totalR.toFixed(2)),
    bestR:    parseFloat(bestR.toFixed(2)),
    worstR:   parseFloat(worstR.toFixed(2)),
    byOutcome,
    bySession,
    byAsset,
  };
}

// ===== HISTÓRICO DO SETUP ATUAL =====
/**
 * getSetupHistory({ asset, direction, regime, session })
 *
 * Filtra o histórico de sinais ao vivo pelo contexto exato do setup atual
 * e retorna estatísticas de performance desse cruzamento específico.
 *
 * Retorna null se não houver dados suficientes (< 3 sinais avaliados).
 */
function getSetupHistory({ asset, direction, regime, session } = {}) {
  try {
    const all = readJSON(LIVE_SIGNAL_FILE, []);
    if (!Array.isArray(all) || !all.length) return null;

    // Filtra por contexto — cada parâmetro é opcional (undefined = sem filtro)
    const resolved = all.filter(s => {
      if (s.evaluation?.status === 'PENDING') return false;
      if (asset     && s.asset                       !== asset)     return false;
      if (direction && s.direction                   !== direction) return false;
      if (regime    && s.audit?.regime               !== regime)    return false;
      if (session   && s.audit?.session?.label       !== session)   return false;
      return true;
    });

    if (resolved.length < 3) return null; // amostra insuficiente

    const wins   = resolved.filter(s => s.evaluation?.outcomeType === 'TP_HIT' ||
                                        (s.evaluation?.realizedPct ?? 0) > 0);
    const losses = resolved.filter(s => s.evaluation?.outcomeType === 'SL_HIT' ||
                                        (s.evaluation?.realizedPct ?? 0) < 0);

    const winRate  = parseFloat(((wins.length / resolved.length) * 100).toFixed(1));
    const avgPct   = resolved.reduce((acc, s) => acc + (s.evaluation?.realizedPct || 0), 0) / resolved.length;
    const health   = winRate >= 60 ? 'STRONG' : winRate >= 45 ? 'MIXED' : 'WEAK';
    const healthLabel = { STRONG: '✅ Forte', MIXED: '⚠️ Misto', WEAK: '❌ Fraco' }[health];

    // Últimos 5 resultados (do mais recente para o mais antigo)
    const recent = [...resolved]
      .sort((a, b) => (b.evaluation?.evaluatedAt || 0) - (a.evaluation?.evaluatedAt || 0))
      .slice(0, 5)
      .map(s => {
        const pct = s.evaluation?.realizedPct ?? 0;
        return pct > 0 ? 'W' : pct < 0 ? 'L' : 'B';
      });

    return {
      total:   resolved.length,
      wins:    wins.length,
      losses:  losses.length,
      winRate,
      avgPct:  parseFloat(avgPct.toFixed(3)),
      health,
      healthLabel,
      recent,        // ex: ['W','W','L','W','B']
      context: { asset, direction, regime, session },
    };
  } catch (e) {
    console.warn('⚠️  getSetupHistory erro:', e.message);
    return null;
  }
}

// ===== GESTÃO DE RISCO ADAPTATIVA =====
/**
 * getRiskState() — Lê o histórico de sinais ao vivo e retorna o nível de risco atual.
 *
 * Níveis:
 *  NORMAL    — operar normalmente (score >= 2)
 *  CAUTIOUS  — cautela (score == 3 obrigatório, aviso no Telegram)
 *  DEFENSIVE — defensivo (score == 3, apenas BTC/XAU, aviso forte no Telegram)
 *  BLOCKED   — bloqueado (não emitir sinais, alertar uma vez por transição)
 *
 * Regras (verificadas em ordem de severidade):
 *  BLOCKED   : streak >= 5 losses consecutivos  OU  drawdown atual >= 3%  OU  >= 4 perdas no dia
 *  DEFENSIVE : streak >= 3 losses               OU  drawdown atual >= 2%  OU  >= 3 perdas no dia
 *  CAUTIOUS  : streak >= 2 losses               OU  drawdown atual >= 1%  OU  recent.verdict === 'FRIO'
 *  NORMAL    : demais casos
 */
function getRiskState() {
  try {
    const stats = getLiveSignalStats();
    if (!stats) return _normalState('sem histórico');

    const streakLoss    = stats.streaks?.currentLoss  ?? 0;
    const drawdownPct   = stats.drawdown?.currentDrawdownPct ?? 0;
    const recentVerdict = stats.recent?.verdict ?? 'NEUTRO';

    // Perdas no dia atual
    const todayStr = new Date().toISOString().slice(0, 10);
    const dailyRow  = (stats.recentDaily || []).find(d => d.date === todayStr);
    const dailyLoss = dailyRow ? (dailyRow.losses ?? 0) : 0;

    // BLOCKED
    if (streakLoss >= 5 || drawdownPct >= 3 || dailyLoss >= 4) {
      return {
        level: 'BLOCKED',
        reason: streakLoss >= 5
          ? `${streakLoss} losses consecutivos`
          : drawdownPct >= 3
            ? `drawdown ${drawdownPct.toFixed(1)}%`
            : `${dailyLoss} perdas hoje`,
        streakLoss, drawdownPct, dailyLoss,
        sizingMultiplier: 0.0,
        minScore: Infinity,           // nenhum sinal passa
        allowedAssets: [],
      };
    }

    // DEFENSIVE
    if (streakLoss >= 3 || drawdownPct >= 2 || dailyLoss >= 3) {
      return {
        level: 'DEFENSIVE',
        reason: streakLoss >= 3
          ? `${streakLoss} losses consecutivos`
          : drawdownPct >= 2
            ? `drawdown ${drawdownPct.toFixed(1)}%`
            : `${dailyLoss} perdas hoje`,
        streakLoss, drawdownPct, dailyLoss,
        sizingMultiplier: 0.5,
        minScore: 3,                  // apenas score máximo
        allowedAssets: ['btc', 'xauusd'],  // só ativos líquidos
      };
    }

    // CAUTIOUS
    if (streakLoss >= 2 || drawdownPct >= 1 || recentVerdict === 'FRIO') {
      return {
        level: 'CAUTIOUS',
        reason: streakLoss >= 2
          ? `${streakLoss} losses consecutivos`
          : drawdownPct >= 1
            ? `drawdown ${drawdownPct.toFixed(1)}%`
            : 'performance recente fraca',
        streakLoss, drawdownPct, dailyLoss,
        sizingMultiplier: 0.75,
        minScore: 3,
        allowedAssets: null,          // todos os ativos permitidos
      };
    }

    // NORMAL
    return _normalState('condições normais', { streakLoss, drawdownPct, dailyLoss });

  } catch (e) {
    console.warn('⚠️  getRiskState erro:', e.message);
    return _normalState('erro interno');
  }
}

function _normalState(reason, extras = {}) {
  return {
    level: 'NORMAL',
    reason,
    streakLoss: extras.streakLoss ?? 0,
    drawdownPct: extras.drawdownPct ?? 0,
    dailyLoss: extras.dailyLoss ?? 0,
    sizingMultiplier: 1.0,
    minScore: 2,
    allowedAssets: null,
  };
}

module.exports = {
  openTrade,
  closeTrade,
  listTrades,
  getStats,
  appendSignal,
  listSignals,
  appendLiveSignal,
  evaluateLiveSignals,
  listLiveSignals,
  getLiveSignalStats,
  getRiskState,
  getSetupHistory,
};
