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

// Garante estrutura mínima
if (!_trades.open)   _trades.open   = [];
if (!_trades.closed) _trades.closed = [];
if (!Array.isArray(_signals)) _signals = [];

function persistTrades() {
  writeJSON(STORE_FILE, _trades, _saveTradeTimer, (t) => { _saveTradeTimer = t; });
}
function persistSignals() {
  writeJSON(SIGNAL_FILE, _signals, _saveSignalTimer, (t) => { _saveSignalTimer = t; });
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

module.exports = { openTrade, closeTrade, listTrades, getStats, appendSignal, listSignals };
