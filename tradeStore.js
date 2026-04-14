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

function persistTrades() {
  writeJSON(STORE_FILE, _trades, _saveTradeTimer, (t) => { _saveTradeTimer = t; });
}
function persistSignals() {
  writeJSON(SIGNAL_FILE, _signals, _saveSignalTimer, (t) => { _saveSignalTimer = t; });
}
function persistLiveSignals() {
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
  if (_liveSignals.length > 3000) _liveSignals.length = 3000;
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

function getLiveSignalStats({ asset } = {}) {
  let items = _liveSignals;
  if (asset) items = items.filter(s => s.asset === asset);

  const resolved = items.filter(s => s.evaluation?.status && s.evaluation.status !== 'PENDING');
  const wins = resolved.filter(s => s.evaluation.status === 'WIN');
  const losses = resolved.filter(s => s.evaluation.status === 'LOSS');
  const flats = resolved.filter(s => s.evaluation.status === 'FLAT');

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
    });
    return map;
  };

  return {
    totalSignals: items.length,
    pending: items.filter(s => s.evaluation?.status === 'PENDING').length,
    evaluated: resolved.length,
    winRate: resolved.length ? parseFloat(((wins.length / resolved.length) * 100).toFixed(1)) : 0,
    wins: wins.length,
    losses: losses.length,
    flats: flats.length,
    avgPct: resolved.length ? parseFloat((resolved.reduce((a, s) => a + (s.evaluation.realizedPct || 0), 0) / resolved.length).toFixed(3)) : 0,
    byAsset: groupMetric(item => item.asset),
    byRegime: groupMetric(item => item.audit?.regime),
    bySession: groupMetric(item => item.audit?.session?.label),
    byDirection: groupMetric(item => item.direction),
    byOutcomeType: groupMetric(item => item.evaluation?.outcomeType),
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
};
