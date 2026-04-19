'use strict';
/**
 * tradeStore.js — Persistência SQLite para a Área VIP
 * Gerencia: sinais VIP, trades abertos/fechados, sinais ao vivo auditáveis
 *
 * DATABASE_PATH (env) → Railway Volume (persistente entre deploys)
 * fallback            → ./data/trades.db (local dev)
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// ── Caminho do banco ────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = process.env.DATABASE_PATH || path.join(DATA_DIR, 'trades.db');
// Garante que o diretório do arquivo de banco existe (Railway Volume pode ser /data/trades.db)
const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');   // melhor performance com múltiplos leitores
db.pragma('synchronous = NORMAL'); // durabilidade boa sem custo total de FULL

// ── Schema ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id        TEXT PRIMARY KEY,
    asset     TEXT NOT NULL,
    status    TEXT NOT NULL DEFAULT 'open',
    openedAt  INTEGER NOT NULL,
    data      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trades_asset  ON trades(asset);
  CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

  CREATE TABLE IF NOT EXISTS vip_signals (
    rowid    INTEGER PRIMARY KEY AUTOINCREMENT,
    asset    TEXT,
    savedAt  INTEGER NOT NULL,
    data     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_vsig_asset   ON vip_signals(asset);
  CREATE INDEX IF NOT EXISTS idx_vsig_savedAt ON vip_signals(savedAt DESC);

  CREATE TABLE IF NOT EXISTS live_signals (
    id                 TEXT PRIMARY KEY,
    asset              TEXT NOT NULL,
    tf                 TEXT NOT NULL,
    direction          TEXT,
    emittedCandleTime  INTEGER,
    createdAt          INTEGER NOT NULL,
    eval_status        TEXT NOT NULL DEFAULT 'PENDING',
    data               TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ls_asset       ON live_signals(asset);
  CREATE INDEX IF NOT EXISTS idx_ls_eval_status ON live_signals(eval_status);
  CREATE INDEX IF NOT EXISTS idx_ls_createdAt   ON live_signals(createdAt DESC);
`);

// ── Migração de JSON → SQLite (executada uma vez, na primeira inicialização) ─
(function migrateFromJSON() {
  try {
    const STORE_FILE       = path.join(DATA_DIR, 'vip_trades.json');
    const SIGNAL_FILE      = path.join(DATA_DIR, 'vip_signals.json');
    const LIVE_SIGNAL_FILE = path.join(DATA_DIR, 'live_signal_audit.json');

    // Só migra se o DB estiver vazio (primeira execução após upgrade)
    const hasAny = db.prepare('SELECT 1 FROM trades LIMIT 1').get()
                || db.prepare('SELECT 1 FROM vip_signals LIMIT 1').get()
                || db.prepare('SELECT 1 FROM live_signals LIMIT 1').get();
    if (hasAny) return;

    let migrated = 0;

    // trades
    if (fs.existsSync(STORE_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
        const all = [...(raw.open || []), ...(raw.closed || [])];
        const ins = db.prepare('INSERT OR IGNORE INTO trades(id,asset,status,openedAt,data) VALUES(?,?,?,?,?)');
        const tx  = db.transaction(() => all.forEach(t =>
          ins.run(t.id, t.asset || '', t.status || 'open', t.openedAt || Date.now(), JSON.stringify(t))
        ));
        tx();
        migrated += all.length;
        console.log(`✅ tradeStore: migrados ${all.length} trades do JSON`);
      } catch(e) { console.warn('⚠️  migração trades:', e.message); }
    }

    // vip_signals
    if (fs.existsSync(SIGNAL_FILE)) {
      try {
        const arr = JSON.parse(fs.readFileSync(SIGNAL_FILE, 'utf-8'));
        const ins = db.prepare('INSERT INTO vip_signals(asset,savedAt,data) VALUES(?,?,?)');
        const tx  = db.transaction(() => arr.forEach(s =>
          ins.run(s.asset || '', s.savedAt || Date.now(), JSON.stringify(s))
        ));
        tx();
        migrated += arr.length;
        console.log(`✅ tradeStore: migrados ${arr.length} VIP signals do JSON`);
      } catch(e) { console.warn('⚠️  migração vip_signals:', e.message); }
    }

    // live_signals
    if (fs.existsSync(LIVE_SIGNAL_FILE)) {
      try {
        const arr = JSON.parse(fs.readFileSync(LIVE_SIGNAL_FILE, 'utf-8'));
        const ins = db.prepare(`
          INSERT OR IGNORE INTO live_signals(id,asset,tf,direction,emittedCandleTime,createdAt,eval_status,data)
          VALUES(?,?,?,?,?,?,?,?)
        `);
        const tx = db.transaction(() => arr.forEach(s => ins.run(
          s.id,
          s.asset || '',
          s.tf || '15m',
          s.direction || null,
          s.emittedCandleTime || null,
          s.createdAt || s.emittedAt || Date.now(),
          s.evaluation?.status || 'PENDING',
          JSON.stringify(s)
        )));
        tx();
        migrated += arr.length;
        console.log(`✅ tradeStore: migrados ${arr.length} live signals do JSON`);
      } catch(e) { console.warn('⚠️  migração live_signals:', e.message); }
    }

    if (migrated > 0) console.log(`✅ tradeStore: migração completa — ${migrated} registros importados para SQLite`);
  } catch(e) {
    console.warn('⚠️  tradeStore: erro na migração JSON→SQLite:', e.message);
  }
})();

// ═══════════════════════════════════════════════════════════════════════════
// SINAIS VIP
// ═══════════════════════════════════════════════════════════════════════════

const _stmtSignalInsert = db.prepare('INSERT INTO vip_signals(asset,savedAt,data) VALUES(?,?,?)');
const _stmtSignalPrune  = db.prepare('DELETE FROM vip_signals WHERE rowid NOT IN (SELECT rowid FROM vip_signals ORDER BY savedAt DESC LIMIT 500)');

function appendSignal(signalObj) {
  const obj = { ...signalObj, savedAt: Date.now() };
  _stmtSignalInsert.run(obj.asset || '', obj.savedAt, JSON.stringify(obj));
  _stmtSignalPrune.run();
}

function listSignals({ asset, status, limit = 100 } = {}) {
  let rows;
  if (asset) {
    rows = db.prepare('SELECT data FROM vip_signals WHERE asset = ? ORDER BY savedAt DESC LIMIT ?').all(asset, limit);
  } else {
    rows = db.prepare('SELECT data FROM vip_signals ORDER BY savedAt DESC LIMIT ?').all(limit);
  }
  let items = rows.map(r => JSON.parse(r.data));
  if (status) items = items.filter(s => s.status === status);
  return items;
}

// ═══════════════════════════════════════════════════════════════════════════
// SINAIS AO VIVO AUDITÁVEIS
// ═══════════════════════════════════════════════════════════════════════════

const LIVE_SIGNAL_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // 180 dias
const LIVE_SIGNAL_LIMIT      = 5000;

const _stmtLSInsert = db.prepare(`
  INSERT OR IGNORE INTO live_signals(id,asset,tf,direction,emittedCandleTime,createdAt,eval_status,data)
  VALUES(?,?,?,?,?,?,?,?)
`);
const _stmtLSUpdateEval = db.prepare(`
  UPDATE live_signals SET eval_status = ?, data = ? WHERE id = ?
`);
const _stmtLSPrune = db.prepare(`
  DELETE FROM live_signals
  WHERE createdAt < ?
     OR id NOT IN (SELECT id FROM live_signals ORDER BY createdAt DESC LIMIT ?)
`);

function appendLiveSignal(signalObj) {
  // Verifica duplicata pelo emittedCandleTime + asset + tf + label
  const dup = db.prepare(`
    SELECT id FROM live_signals
    WHERE asset = ? AND tf = ? AND emittedCandleTime = ?
    LIMIT 1
  `).get(signalObj.asset, signalObj.tf || '15m', signalObj.emittedCandleTime || 0);
  if (dup) return JSON.parse(db.prepare('SELECT data FROM live_signals WHERE id = ?').get(dup.id).data);

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
    },
  };

  _stmtLSInsert.run(
    item.id,
    item.asset || '',
    item.tf || '15m',
    item.direction || null,
    item.emittedCandleTime || null,
    item.createdAt,
    'PENDING',
    JSON.stringify(item)
  );

  // Poda periódica
  _stmtLSPrune.run(Date.now() - LIVE_SIGNAL_MAX_AGE_MS, LIVE_SIGNAL_LIMIT);
  return item;
}

function evaluateLiveSignals({ asset, candles, tf = '15m', horizonCandles = 4 } = {}) {
  if (!asset || !Array.isArray(candles) || !candles.length) return 0;

  const indexByTime = new Map(candles.map((c, i) => [c.time, i]));
  const pending = db.prepare(`
    SELECT id, data FROM live_signals
    WHERE asset = ? AND tf = ? AND eval_status = 'PENDING'
  `).all(asset, tf);

  let updates = 0;

  const evaluate = db.transaction(() => {
    for (const row of pending) {
      const item = JSON.parse(row.data);
      const entryIdx = indexByTime.get(item.emittedCandleTime);
      if (entryIdx == null) continue;

      const horizon    = item.evaluation?.horizonCandles || horizonCandles;
      const targetIdx  = entryIdx + horizon;
      if (targetIdx >= candles.length) continue;

      const futureCandles   = candles.slice(entryIdx + 1, targetIdx + 1);
      const hasLevels       = item.slPrice != null && item.tpPrice != null;
      let resolvedByLevel   = false;
      let exitPrice         = null;
      let exitCandle        = null;
      let outcomeType       = 'HORIZON';

      if (hasLevels) {
        for (const candle of futureCandles) {
          const hitTp = item.direction === 'BUY'
            ? candle.high >= item.tpPrice
            : candle.low  <= item.tpPrice;
          const hitSl = item.direction === 'BUY'
            ? candle.low  <= item.slPrice
            : candle.high >= item.slPrice;

          if (hitTp && hitSl) {
            // Conservador: assume SL primeiro quando TP e SL cabem na mesma vela
            exitPrice = item.slPrice; exitCandle = candle;
            outcomeType = 'SL_HIT_SAME_BAR'; resolvedByLevel = true; break;
          }
          if (hitSl) {
            exitPrice = item.slPrice; exitCandle = candle;
            outcomeType = 'SL_HIT'; resolvedByLevel = true; break;
          }
          if (hitTp) {
            exitPrice = item.tpPrice; exitCandle = candle;
            outcomeType = 'TP_HIT'; resolvedByLevel = true; break;
          }
        }
      }

      if (!resolvedByLevel) {
        exitCandle  = candles[targetIdx];
        exitPrice   = exitCandle.close;
        outcomeType = 'HORIZON';
      }

      const rawPct = item.direction === 'BUY'
        ? ((exitPrice - item.entryPrice) / item.entryPrice) * 100
        : ((item.entryPrice - exitPrice) / item.entryPrice) * 100;

      item.evaluation.status              = rawPct > 0 ? 'WIN' : rawPct < 0 ? 'LOSS' : 'FLAT';
      item.evaluation.outcomeType         = outcomeType;
      item.evaluation.evaluatedAt         = Date.now();
      item.evaluation.evaluationPrice     = exitPrice;
      item.evaluation.evaluationCandleTime = exitCandle.time;
      item.evaluation.realizedPct         = parseFloat(rawPct.toFixed(4));
      item.evaluation.candlesElapsed      = Math.max(1, indexByTime.get(exitCandle.time) - entryIdx);

      _stmtLSUpdateEval.run(item.evaluation.status, JSON.stringify(item), row.id);
      updates++;
    }
  });

  evaluate();
  return updates;
}

function listLiveSignals({ asset, status, limit = 100 } = {}) {
  let rows;
  if (asset && status) {
    rows = db.prepare('SELECT data FROM live_signals WHERE asset = ? AND eval_status = ? ORDER BY createdAt DESC LIMIT ?').all(asset, status, limit);
  } else if (asset) {
    rows = db.prepare('SELECT data FROM live_signals WHERE asset = ? ORDER BY createdAt DESC LIMIT ?').all(asset, limit);
  } else if (status) {
    rows = db.prepare('SELECT data FROM live_signals WHERE eval_status = ? ORDER BY createdAt DESC LIMIT ?').all(status, limit);
  } else {
    rows = db.prepare('SELECT data FROM live_signals ORDER BY createdAt DESC LIMIT ?').all(limit);
  }
  return rows.map(r => JSON.parse(r.data));
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS DE ESTATÍSTICAS (lógica 100% preservada)
// ═══════════════════════════════════════════════════════════════════════════

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
  let equity = 0, peak = 0, troughFromPeak = 0, maxDrawdownPct = 0;
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
    cumulativePct:    parseFloat(equity.toFixed(3)),
    maxDrawdownPct:   parseFloat(Math.abs(maxDrawdownPct).toFixed(3)),
    currentDrawdownPct: parseFloat(Math.abs(troughFromPeak).toFixed(3)),
  };
}

function buildStreakStats(resolved) {
  let currentWin = 0, currentLoss = 0, maxWin = 0, maxLoss = 0;
  resolved.forEach(item => {
    const status = item.evaluation?.status;
    if (status === 'WIN')  { currentWin += 1; currentLoss = 0; }
    else if (status === 'LOSS') { currentLoss += 1; currentWin = 0; }
    else { currentWin = 0; currentLoss = 0; }
    maxWin  = Math.max(maxWin,  currentWin);
    maxLoss = Math.max(maxLoss, currentLoss);
  });
  return { currentWin, currentLoss, maxWin, maxLoss };
}

function buildRecentStats(resolved, windowSize = 20) {
  const recent = resolved.slice(-windowSize);
  const wins   = recent.filter(i => i.evaluation?.status === 'WIN').length;
  const losses = recent.filter(i => i.evaluation?.status === 'LOSS').length;
  const flats  = recent.filter(i => i.evaluation?.status === 'FLAT').length;
  const total  = recent.length;
  const avgPct = total ? recent.reduce((s, i) => s + (i.evaluation?.realizedPct || 0), 0) / total : 0;

  let verdict = 'NEUTRO';
  if (total >= 5 && wins / total >= 0.58 && avgPct > 0) verdict = 'QUENTE';
  else if (total >= 5 && losses / total >= 0.5 && avgPct < 0) verdict = 'FRIO';

  return {
    windowSize, total, wins, losses, flats,
    winRate: total ? parseFloat(((wins / total) * 100).toFixed(1)) : 0,
    avgPct: parseFloat(avgPct.toFixed(3)),
    verdict,
  };
}

function buildDailyBreakdown(resolved, maxDays = 7) {
  const map = {};
  resolved.forEach(item => {
    const ts  = item.evaluation?.evaluatedAt || item.createdAt;
    if (!ts) return;
    const key = new Date(ts).toISOString().slice(0, 10);
    if (!map[key]) map[key] = { total: 0, wins: 0, losses: 0, flats: 0, sumPct: 0 };
    const row = map[key];
    row.total++;
    if (item.evaluation?.status === 'WIN')  row.wins++;
    else if (item.evaluation?.status === 'LOSS') row.losses++;
    else row.flats++;
    row.sumPct += item.evaluation?.realizedPct || 0;
  });
  return Object.entries(map)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-maxDays)
    .map(([date, row]) => ({
      date,
      total: row.total, wins: row.wins, losses: row.losses, flats: row.flats,
      winRate: row.total ? parseFloat(((row.wins / row.total) * 100).toFixed(1)) : 0,
      sumPct: parseFloat(row.sumPct.toFixed(3)),
    }));
}

function getLiveSignalStats({ asset } = {}) {
  // Carrega do SQLite — apenas sinais dos últimos 180 dias para eficiência
  const cutoff = Date.now() - LIVE_SIGNAL_MAX_AGE_MS;
  const rows = asset
    ? db.prepare('SELECT data FROM live_signals WHERE asset = ? AND createdAt >= ? ORDER BY createdAt ASC').all(asset, cutoff)
    : db.prepare('SELECT data FROM live_signals WHERE createdAt >= ? ORDER BY createdAt ASC').all(cutoff);
  const items = rows.map(r => JSON.parse(r.data));

  const resolved = items.filter(s => s.evaluation?.status && s.evaluation.status !== 'PENDING');
  const wins     = resolved.filter(s => s.evaluation.status === 'WIN');
  const losses   = resolved.filter(s => s.evaluation.status === 'LOSS');
  const flats    = resolved.filter(s => s.evaluation.status === 'FLAT');

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
      if (item.evaluation.status === 'WIN')       map[key].wins++;
      else if (item.evaluation.status === 'LOSS') map[key].losses++;
      else                                         map[key].flats++;
      map[key].sumPct += item.evaluation.realizedPct || 0;
    });
    Object.values(map).forEach(row => {
      row.winRate = row.total ? parseFloat(((row.wins / row.total) * 100).toFixed(1)) : 0;
      row.sumPct  = parseFloat(row.sumPct.toFixed(2));
      row.health  = classifyBucket(row);
    });
    return map;
  };

  const buildRanking = (groupName, groupMap) => Object.entries(groupMap || {})
    .map(([name, row]) => ({
      group: groupName, name,
      total: row.total, winRate: row.winRate, sumPct: row.sumPct, health: row.health,
      score: parseFloat((row.winRate + row.sumPct * 2).toFixed(2)),
    }))
    .sort((a, b) => (b.score - a.score) || (b.winRate - a.winRate) || (b.sumPct - a.sumPct));

  const byAsset       = groupMetric(item => item.asset);
  const byRegime      = groupMetric(item => item.audit?.regime);
  const bySession     = groupMetric(item => item.audit?.session?.label);
  const byDirection   = groupMetric(item => item.direction);
  const byOutcomeType = groupMetric(item => item.evaluation?.outcomeType);

  const resolvedOrdered = [...resolved].sort((a, b) =>
    ((a.evaluation?.evaluatedAt || a.createdAt || 0) - (b.evaluation?.evaluatedAt || b.createdAt || 0))
  );

  const drawdown = buildDrawdownStats(resolvedOrdered);
  const streaks  = buildStreakStats(resolvedOrdered);
  const recent   = buildRecentStats(resolvedOrdered, 20);
  const recentDaily = buildDailyBreakdown(resolvedOrdered, 7);

  const rankedContexts = [
    ...buildRanking('asset',     byAsset),
    ...buildRanking('regime',    byRegime),
    ...buildRanking('session',   bySession),
    ...buildRanking('direction', byDirection),
  ];
  const strongContexts = rankedContexts.filter(r => r.health === 'STRONG').slice(0, 5);
  const weakContexts   = rankedContexts.filter(r => r.health === 'WEAK').slice(0, 5);
  const bestAsset      = pickBestRow('asset',  byAsset,  { preferPositive: true });
  const worstAsset     = pickBestRow('asset',  byAsset,  { preferPositive: false });
  const bestSession    = pickBestRow('session',bySession,{ preferPositive: true });
  const worstRegime    = pickBestRow('regime', byRegime, { preferPositive: false });

  let operationalStatus = 'ESTAVEL';
  if (recent.verdict === 'FRIO' || drawdown.currentDrawdownPct >= 1.5 || streaks.currentLoss >= 3) {
    operationalStatus = 'DEFENSIVO';
  } else if (recent.verdict === 'QUENTE' && drawdown.currentDrawdownPct <= 0.4 && streaks.currentLoss === 0) {
    operationalStatus = 'AGRESSIVO_CONTROLADO';
  }

  return {
    totalSignals: items.length,
    pending:   items.filter(s => s.evaluation?.status === 'PENDING').length,
    evaluated: resolved.length,
    winRate:   resolved.length ? parseFloat(((wins.length / resolved.length) * 100).toFixed(1)) : 0,
    wins:      wins.length,
    losses:    losses.length,
    flats:     flats.length,
    avgPct:    resolved.length ? parseFloat((resolved.reduce((a, s) => a + (s.evaluation.realizedPct || 0), 0) / resolved.length).toFixed(3)) : 0,
    byAsset, byRegime, bySession, byDirection, byOutcomeType,
    rankedContexts, strongContexts, weakContexts,
    recent, recentDaily, drawdown, streaks,
    executive: {
      bestAsset, worstAsset, bestSession, worstRegime,
      operationalStatus,
      historyStartAt: items[items.length - 1]?.createdAt || null,
      historyEndAt:   items[0]?.createdAt || null,
      lastResolvedAt: resolvedOrdered[resolvedOrdered.length - 1]?.evaluation?.evaluatedAt || null,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTÓRICO DO SETUP ATUAL
// ═══════════════════════════════════════════════════════════════════════════

function getSetupHistory({ asset, direction, regime, session } = {}) {
  try {
    const cutoff = Date.now() - LIVE_SIGNAL_MAX_AGE_MS;
    const rows = db.prepare('SELECT data FROM live_signals WHERE createdAt >= ? AND eval_status != ? ORDER BY createdAt ASC').all(cutoff, 'PENDING');
    const all  = rows.map(r => JSON.parse(r.data));
    if (!all.length) return null;

    const resolved = all.filter(s => {
      if (asset     && s.asset                 !== asset)     return false;
      if (direction && s.direction             !== direction) return false;
      if (regime    && s.audit?.regime         !== regime)    return false;
      if (session   && s.audit?.session?.label !== session)   return false;
      return true;
    });

    if (resolved.length < 3) return null;

    const wins   = resolved.filter(s => s.evaluation?.outcomeType === 'TP_HIT' || (s.evaluation?.realizedPct ?? 0) > 0);
    const losses = resolved.filter(s => s.evaluation?.outcomeType === 'SL_HIT' || (s.evaluation?.realizedPct ?? 0) < 0);
    const winRate  = parseFloat(((wins.length / resolved.length) * 100).toFixed(1));
    const avgPct   = resolved.reduce((acc, s) => acc + (s.evaluation?.realizedPct || 0), 0) / resolved.length;
    const health   = winRate >= 60 ? 'STRONG' : winRate >= 45 ? 'MIXED' : 'WEAK';
    const healthLabel = { STRONG: '✅ Forte', MIXED: '⚠️ Misto', WEAK: '❌ Fraco' }[health];

    const recent = [...resolved]
      .sort((a, b) => (b.evaluation?.evaluatedAt || 0) - (a.evaluation?.evaluatedAt || 0))
      .slice(0, 5)
      .map(s => {
        const pct = s.evaluation?.realizedPct ?? 0;
        return pct > 0 ? 'W' : pct < 0 ? 'L' : 'B';
      });

    return {
      total: resolved.length,
      wins: wins.length, losses: losses.length,
      winRate,
      avgPct: parseFloat(avgPct.toFixed(3)),
      health, healthLabel, recent,
      context: { asset, direction, regime, session },
    };
  } catch (e) {
    console.warn('⚠️  getSetupHistory erro:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GESTÃO DE RISCO ADAPTATIVA
// ═══════════════════════════════════════════════════════════════════════════

function _normalState(reason, extras = {}) {
  return {
    level: 'NORMAL', reason,
    streakLoss:  extras.streakLoss  ?? 0,
    drawdownPct: extras.drawdownPct ?? 0,
    dailyLoss:   extras.dailyLoss   ?? 0,
    sizingMultiplier: 1.0,
    minScore: 2,
    allowedAssets: null,
  };
}

function getRiskState() {
  try {
    const stats = getLiveSignalStats();
    if (!stats) return _normalState('sem histórico');

    const streakLoss    = stats.streaks?.currentLoss  ?? 0;
    const drawdownPct   = stats.drawdown?.currentDrawdownPct ?? 0;
    const recentVerdict = stats.recent?.verdict ?? 'NEUTRO';

    const todayStr  = new Date().toISOString().slice(0, 10);
    const dailyRow  = (stats.recentDaily || []).find(d => d.date === todayStr);
    const dailyLoss = dailyRow ? (dailyRow.losses ?? 0) : 0;

    if (streakLoss >= 5 || drawdownPct >= 3 || dailyLoss >= 4) {
      return {
        level: 'BLOCKED',
        reason: streakLoss >= 5 ? `${streakLoss} losses consecutivos`
              : drawdownPct >= 3 ? `drawdown ${drawdownPct.toFixed(1)}%`
              : `${dailyLoss} perdas hoje`,
        streakLoss, drawdownPct, dailyLoss,
        sizingMultiplier: 0.0,
        minScore: Infinity,
        allowedAssets: [],
      };
    }

    if (streakLoss >= 3 || drawdownPct >= 2 || dailyLoss >= 3) {
      return {
        level: 'DEFENSIVE',
        reason: streakLoss >= 3 ? `${streakLoss} losses consecutivos`
              : drawdownPct >= 2 ? `drawdown ${drawdownPct.toFixed(1)}%`
              : `${dailyLoss} perdas hoje`,
        streakLoss, drawdownPct, dailyLoss,
        sizingMultiplier: 0.5,
        minScore: 3,
        allowedAssets: ['btc', 'xauusd'],
      };
    }

    if (streakLoss >= 2 || drawdownPct >= 1 || recentVerdict === 'FRIO') {
      return {
        level: 'CAUTIOUS',
        reason: streakLoss >= 2 ? `${streakLoss} losses consecutivos`
              : drawdownPct >= 1 ? `drawdown ${drawdownPct.toFixed(1)}%`
              : 'performance recente fraca',
        streakLoss, drawdownPct, dailyLoss,
        sizingMultiplier: 0.75,
        minScore: 3,
        allowedAssets: null,
      };
    }

    return _normalState('condições normais', { streakLoss, drawdownPct, dailyLoss });

  } catch (e) {
    console.warn('⚠️  getRiskState erro:', e.message);
    return _normalState('erro interno');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADES VIP
// ═══════════════════════════════════════════════════════════════════════════

const _stmtTradeInsert = db.prepare('INSERT INTO trades(id,asset,status,openedAt,data) VALUES(?,?,?,?,?)');
const _stmtTradeUpdate = db.prepare('UPDATE trades SET status = ?, data = ? WHERE id = ?');

function openTrade(t) {
  const trade = {
    id:        `vip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    asset:     t.asset,
    direction: t.direction,
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
    pnlPct:    null,
    pnlR:      null,
    outcome:   null,
  };
  _stmtTradeInsert.run(trade.id, trade.asset || '', 'open', trade.openedAt, JSON.stringify(trade));
  return trade;
}

function closeTrade(id, { closePrice, outcome = 'MANUAL' } = {}) {
  if (closePrice == null || isNaN(closePrice)) return null;

  const row = db.prepare("SELECT data FROM trades WHERE id = ? AND status = 'open'").get(id);
  if (!row) return null;

  const trade = JSON.parse(row.data);
  const risk   = Math.abs(trade.entry - trade.sl);
  const rawPnl = trade.direction === 'BUY'
    ? closePrice - trade.entry
    : trade.entry - closePrice;

  const closed = {
    ...trade,
    status:     'closed',
    closedAt:   Date.now(),
    closePrice,
    outcome,
    pnlPct:     risk > 0 ? parseFloat(((rawPnl / trade.entry) * 100).toFixed(4)) : 0,
    pnlR:       risk > 0 ? parseFloat((rawPnl / risk).toFixed(2)) : 0,
  };

  _stmtTradeUpdate.run('closed', JSON.stringify(closed), id);
  return closed;
}

function listTrades({ asset, status, limit = 100 } = {}) {
  let rows;
  if (status === 'open') {
    rows = asset
      ? db.prepare("SELECT data FROM trades WHERE status='open' AND asset=? ORDER BY openedAt DESC LIMIT ?").all(asset, limit)
      : db.prepare("SELECT data FROM trades WHERE status='open' ORDER BY openedAt DESC LIMIT ?").all(limit);
  } else if (status === 'closed') {
    rows = asset
      ? db.prepare("SELECT data FROM trades WHERE status='closed' AND asset=? ORDER BY openedAt DESC LIMIT ?").all(asset, limit)
      : db.prepare("SELECT data FROM trades WHERE status='closed' ORDER BY openedAt DESC LIMIT ?").all(limit);
  } else {
    rows = asset
      ? db.prepare('SELECT data FROM trades WHERE asset=? ORDER BY openedAt DESC LIMIT ?').all(asset, limit)
      : db.prepare('SELECT data FROM trades ORDER BY openedAt DESC LIMIT ?').all(limit);
  }
  return rows.map(r => JSON.parse(r.data));
}

// Atualiza campos opcionais de um trade (notes, tags) sem alterar status/pnl
function updateTrade(id, fields) {
  const ALLOWED = ['notes', 'tags'];
  const row = db.prepare('SELECT data, status FROM trades WHERE id = ?').get(id);
  if (!row) return null;
  const trade = JSON.parse(row.data);
  for (const k of ALLOWED) {
    if (fields[k] !== undefined) trade[k] = String(fields[k]).slice(0, 2000); // max 2k chars
  }
  _stmtTradeUpdate.run(row.status, JSON.stringify(trade), id);
  return trade;
}

// Atualiza o SL e peakPrice de um trade aberto (usado pelo trailing stop)
// Retorna o trade atualizado ou null se não encontrado
function updateTradeSL(id, { sl, peakPrice } = {}) {
  const row = db.prepare("SELECT data FROM trades WHERE id = ? AND status = 'open'").get(id);
  if (!row) return null;
  const trade = JSON.parse(row.data);
  if (sl        !== undefined) trade.sl        = sl;
  if (peakPrice !== undefined) trade.peakPrice = peakPrice;
  _stmtTradeUpdate.run('open', JSON.stringify(trade), id);
  return trade;
}

function getStats({ asset } = {}) {
  const rows = asset
    ? db.prepare("SELECT data FROM trades WHERE status='closed' AND asset=?").all(asset)
    : db.prepare("SELECT data FROM trades WHERE status='closed'").all();
  const closed = rows.map(r => JSON.parse(r.data));

  if (closed.length === 0) {
    return { trades: 0, winRate: 0, avgR: 0, totalR: 0, bestR: 0, worstR: 0, byOutcome: {}, bySession: {}, byAsset: {} };
  }

  const wins    = closed.filter(t => (t.pnlR || 0) > 0);
  const totalR  = closed.reduce((s, t) => s + (t.pnlR || 0), 0);
  const avgR    = totalR / closed.length;
  const bestR   = Math.max(...closed.map(t => t.pnlR || 0));
  const worstR  = Math.min(...closed.map(t => t.pnlR || 0));

  const byOutcome = {};
  closed.forEach(t => { const k = t.outcome || 'MANUAL'; byOutcome[k] = (byOutcome[k] || 0) + 1; });

  const bySession = {};
  closed.forEach(t => {
    const k = t.session || 'Sem Sessão';
    if (!bySession[k]) bySession[k] = { trades: 0, totalR: 0 };
    bySession[k].trades++;
    bySession[k].totalR += t.pnlR || 0;
  });

  const byAsset = {};
  closed.forEach(t => {
    const k = t.asset || 'N/A';
    if (!byAsset[k]) byAsset[k] = { trades: 0, totalR: 0 };
    byAsset[k].trades++;
    byAsset[k].totalR += t.pnlR || 0;
  });

  return {
    trades:  closed.length,
    winRate: parseFloat(((wins.length / closed.length) * 100).toFixed(1)),
    avgR:    parseFloat(avgR.toFixed(2)),
    totalR:  parseFloat(totalR.toFixed(2)),
    bestR:   parseFloat(bestR.toFixed(2)),
    worstR:  parseFloat(worstR.toFixed(2)),
    byOutcome, bySession, byAsset,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  openTrade,
  closeTrade,
  updateTrade,
  updateTradeSL,
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
