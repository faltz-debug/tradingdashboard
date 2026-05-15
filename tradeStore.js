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
            // Ambíguo: candle atingiu SL e TP no mesmo intervalo — impossível determinar qual veio primeiro
            exitPrice = item.entryPrice; exitCandle = candle;
            outcomeType = 'AMBIGUOUS'; resolvedByLevel = true; break;
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

      item.evaluation.status              = outcomeType === 'AMBIGUOUS' ? 'AMBIGUOUS'
                                          : rawPct > 0 ? 'WIN' : rawPct < 0 ? 'LOSS' : 'FLAT';
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
    // ── Métricas de live signals (simulação, horizon 4 candles) ─────────────
    // ATENÇÃO: live_signals NÃO são trades reais MT5. Usamos apenas streak e
    // drawdown como proxy de "mercado difícil", mas NUNCA dailyLoss de simulação
    // para bloquear o bot (falso-positivo: 16 sinais perdidos ≠ 16 SLs reais).
    const stats = getLiveSignalStats();
    const streakLoss    = stats?.streaks?.currentLoss  ?? 0;
    const drawdownPct   = stats?.drawdown?.currentDrawdownPct ?? 0;
    const recentVerdict = stats?.recent?.verdict ?? 'NEUTRO';

    // ── Métricas de trades reais MT5 (fechados hoje) ─────────────────────────
    const todayStartMs = new Date().setUTCHours(0, 0, 0, 0);
    const realTodayRows = db.prepare(
      `SELECT data FROM trades WHERE status='closed'
       AND json_extract(data,'$.mt5Ticket') IS NOT NULL
       AND json_extract(data,'$.closedAt') > ?`
    ).all(todayStartMs);

    let realDailyLoss = 0;
    let realDailyWin  = 0;
    for (const row of realTodayRows) {
      try {
        const t = JSON.parse(row.data);
        if (['LOSS','SL'].includes(t.outcome)) realDailyLoss++;
        else if (['WIN','TP'].includes(t.outcome)) realDailyWin++;
      } catch (_) {}
    }

    // Thresholds:
    //   BLOCKED:   streak >= 5  OU  drawdown >= 3%  OU  >= 6 SLs reais MT5 no dia
    //   DEFENSIVE: streak >= 3  OU  drawdown >= 2%  OU  >= 4 SLs reais MT5 no dia
    //   CAUTIOUS:  streak >= 2  OU  drawdown >= 1%  OU  verdict FRIO
    // dailyLoss exposto no retorno = perdas REAIS (não simulação)

    if (streakLoss >= 5 || drawdownPct >= 3 || realDailyLoss >= 6) {
      return {
        level: 'BLOCKED',
        reason: streakLoss >= 5 ? `${streakLoss} losses consecutivos (sinais)`
              : drawdownPct >= 3 ? `drawdown ${drawdownPct.toFixed(1)}%`
              : `${realDailyLoss} SLs reais hoje`,
        streakLoss, drawdownPct,
        dailyLoss: realDailyLoss, dailyWin: realDailyWin,
        sizingMultiplier: 0.0,
        minScore: Infinity,
        allowedAssets: [],
      };
    }

    if (streakLoss >= 3 || drawdownPct >= 2 || realDailyLoss >= 4) {
      return {
        level: 'DEFENSIVE',
        reason: streakLoss >= 3 ? `${streakLoss} losses consecutivos (sinais)`
              : drawdownPct >= 2 ? `drawdown ${drawdownPct.toFixed(1)}%`
              : `${realDailyLoss} SLs reais hoje`,
        streakLoss, drawdownPct,
        dailyLoss: realDailyLoss, dailyWin: realDailyWin,
        sizingMultiplier: 0.5,
        minScore: 3,
        allowedAssets: ['btc', 'xauusd'],
      };
    }

    if (streakLoss >= 2 || drawdownPct >= 1 || recentVerdict === 'FRIO') {
      return {
        level: 'CAUTIOUS',
        reason: streakLoss >= 2 ? `${streakLoss} losses consecutivos (sinais)`
              : drawdownPct >= 1 ? `drawdown ${drawdownPct.toFixed(1)}%`
              : 'performance recente fraca (sinais)',
        streakLoss, drawdownPct,
        dailyLoss: realDailyLoss, dailyWin: realDailyWin,
        sizingMultiplier: 0.75,
        minScore: 3,
        allowedAssets: null,
      };
    }

    return _normalState('condições normais', {
      streakLoss, drawdownPct,
      dailyLoss: realDailyLoss, dailyWin: realDailyWin,
    });

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

function _toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function _roundRisk(value) {
  return value > 0 ? parseFloat(value.toFixed(8)) : null;
}

function _getInitialRisk(trade) {
  const entry = _toFiniteNumber(trade?.entry);
  const initialSl = _toFiniteNumber(trade?.initialSl ?? trade?.sl);
  if (entry != null && initialSl != null) {
    const risk = Math.abs(entry - initialSl);
    if (risk > 0) return risk;
  }

  const initialTp = _toFiniteNumber(trade?.initialTp ?? trade?.tp);
  const plannedRr = _toFiniteNumber(trade?.plannedRr ?? trade?.rr);
  if (entry != null && initialTp != null && plannedRr != null && plannedRr > 0) {
    const risk = Math.abs(initialTp - entry) / plannedRr;
    if (risk > 0) return risk;
  }

  const liveSl = _toFiniteNumber(trade?.sl);
  if (entry != null && liveSl != null) {
    const risk = Math.abs(entry - liveSl);
    if (risk > 0) return risk;
  }

  return 0;
}

function _ensureTradeRiskSnapshot(trade) {
  if (!trade || typeof trade !== 'object') return trade;

  if (trade.initialSl == null && trade.sl != null) trade.initialSl = trade.sl;
  if (trade.initialTp == null && trade.tp != null) trade.initialTp = trade.tp;
  if (trade.plannedRr == null && trade.rr != null) trade.plannedRr = trade.rr;
  if (trade.managedByMt5 == null && trade.mt5Ticket != null) trade.managedByMt5 = true;

  const initialRisk = _getInitialRisk(trade);
  if (trade.initialRisk == null && initialRisk > 0) {
    trade.initialRisk = _roundRisk(initialRisk);
  }

  return trade;
}

function _recomputeClosedTradeMetrics(trade) {
  _ensureTradeRiskSnapshot(trade);

  const entry = _toFiniteNumber(trade?.entry);
  const closePrice = _toFiniteNumber(trade?.closePrice);
  const risk = _getInitialRisk(trade);
  if (entry == null || closePrice == null) return trade;

  const rawPnl = trade.direction === 'BUY'
    ? closePrice - entry
    : entry - closePrice;

  trade.pnlPct = entry !== 0 ? parseFloat(((rawPnl / entry) * 100).toFixed(4)) : 0;
  trade.pnlR = risk > 0 ? parseFloat((rawPnl / risk).toFixed(2)) : 0;
  return trade;
}

/**
 * Infere o outcome real (TP/SL) com base na proximidade do preço de fechamento
 * ao TP e ao SL do trade. Usado quando o outcome registrado é MT5_CLOSED ou MANUAL
 * (situações onde deal.reason do MT5 não era 3=TP ou 4=SL no momento da leitura).
 *
 * Lógica: se o preço de fechamento está dentro de 30% do range total tp↔sl
 * a partir do TP → foi TP. Mesmo critério do lado do SL → foi SL.
 * Empate ou região central → retorna null (mantém outcome original).
 */
function _inferOutcomeFromPrice(trade, closePrice) {
  const tp    = _toFiniteNumber(trade?.tp    ?? trade?.initialTp);
  const sl    = _toFiniteNumber(trade?.sl    ?? trade?.initialSl);
  const entry = _toFiniteNumber(trade?.entry);
  if (tp == null || sl == null || entry == null || closePrice == null) return null;
  if (tp === sl) return null;

  const tpDist    = Math.abs(closePrice - tp);
  const slDist    = Math.abs(closePrice - sl);
  const totalRange = Math.abs(tp - sl);
  const threshold  = totalRange * 0.30; // dentro de 30% do range a partir do TP/SL

  // Verificação direcional: TP deve estar no lado correto da entrada
  const isBuy = trade.direction === 'BUY';

  // Para BUY: TP > entry, SL < entry. Para SELL: TP < entry, SL > entry.
  const tpSideOk = isBuy ? (tp > entry) : (tp < entry);
  const slSideOk = isBuy ? (sl < entry) : (sl > entry);

  if (tpDist < threshold && tpDist < slDist && tpSideOk) return 'TP';
  if (slDist < threshold && slDist < tpDist && slSideOk) return 'SL';
  return null;
}

function _repairTradeSnapshots() {
  const rows = db.prepare('SELECT id, status, data FROM trades').all();
  if (!rows.length) return;

  const tx = db.transaction(() => {
    for (const row of rows) {
      let trade;
      try {
        trade = JSON.parse(row.data);
      } catch {
        continue;
      }

      const before = JSON.stringify(trade);
      _ensureTradeRiskSnapshot(trade);
      if (trade.status === 'closed' && trade.closePrice != null) {
        _recomputeClosedTradeMetrics(trade);
      }
      const after = JSON.stringify(trade);
      if (after !== before) {
        _stmtTradeUpdate.run(row.status, after, row.id);
      }
    }
  });

  tx();
}

function openTrade(t) {
  // Deduplicacao: evita abrir trade identico (mesmo asset+direction+entry+sl+tp) que ja existe aberto.
  // REGRA: trades gerenciados pelo MT5 (managedByMt5=true, criados pelo scheduler + webhook)
  // NAO sao deduplicados contra trades locais de monitoramento (managedByMt5=false, criados por signals.js).
  // Sem essa separacao, signals.js criava o trade local primeiro e o scheduler nunca conseguia
  // chamar o bot webhook porque o openTrade retornava _deduplicated=true antes de ir ao MT5.
  const DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 horas (cobre o cooldown normal e o pyramid)
  const existing = listTrades({ asset: t.asset, status: 'open' });
  const duplicate = (existing || []).find(ot =>
    ot.direction === t.direction &&
    Math.abs(ot.entry - t.entry) < 0.0001 &&
    Math.abs(ot.sl    - t.sl)    < 0.0001 &&
    Math.abs(ot.tp    - t.tp)    < 0.0001 &&
    (Date.now() - (ot.openedAt || 0)) < DEDUP_WINDOW_MS &&
    // Nao deduplica entre trade local (signal_monitor) e trade MT5 (scheduler+webhook)
    !!ot.managedByMt5 === !!t.managedByMt5
  );
  if (duplicate) return { ...duplicate, _deduplicated: true };

  const trade = {
    id:        `vip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    asset:     t.asset,
    direction: t.direction,
    biasTf:    t.biasTf,
    entryTf:   t.entryTf,
    entry:     t.entry,
    sl:        t.sl,
    tp:        t.tp,
    initialSl: t.sl,
    initialTp: t.tp,
    initialRisk: _roundRisk(Math.abs((t.entry ?? 0) - (t.sl ?? 0))),
    atr:       t.atr,
    rr:        t.rr,
    plannedRr: t.rr,
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
    source:    t.source || 'auto',  // 'auto' | 'manual'
    managedByMt5: !!t.managedByMt5,
    mt5VerifiedClose: false,
    webhookSent: false,             // true quando confirmado enviado ao MT5
    // ── MFE TRACKING (1RR / 2RR / etc.) ────────────────────────────────────
    // maxFavorableR  = pico de excursao favoravel (em multiplos de R) durante
    //                  a vida do trade. Atualizado via candles 15M ou ticks MT5.
    // reached1R/2R   = flags derivadas (true se MFE >= 1.0 / 2.0).
    // peakAt1R/2R    = timestamp ms em que o pico foi alcancado pela 1a vez.
    maxFavorableR: 0,
    reached1R: false,
    reached2R: false,
    peakAt1R: null,
    peakAt2R: null,
  };
  _ensureTradeRiskSnapshot(trade);
  _stmtTradeInsert.run(trade.id, trade.asset || '', 'open', trade.openedAt, JSON.stringify(trade));
  return trade;
}

/**
 * Marca um trade como confirmado enviado ao MT5 (webhookSent=true).
 * Chamado pelo scheduler apos callBotWebhook resolver sem erro.
 * Necessario para o sistema de deduplicacao nao bloquear trades legitimamente abertos.
 */
function markWebhookSent(id) {
  if (!id) return false;
  const row = db.prepare('SELECT data FROM trades WHERE id = ?').get(id);
  if (!row) return false;
  try {
    const t = JSON.parse(row.data);
    t.webhookSent = true;
    db.prepare('UPDATE trades SET data = ? WHERE id = ?').run(JSON.stringify(t), id);
    return true;
  } catch { return false; }
}

function closeTrade(id, { closePrice, outcome = 'MANUAL', closedAt = null, mt5VerifiedClose = false, managedByMt5 = null } = {}) {
  if (closePrice == null || isNaN(closePrice)) return null;

  const row = db.prepare("SELECT data FROM trades WHERE id = ? AND status = 'open'").get(id);
  if (!row) return null;

  const trade = _ensureTradeRiskSnapshot(JSON.parse(row.data));
  const risk   = _getInitialRisk(trade);
  const rawPnl = trade.direction === 'BUY'
    ? closePrice - trade.entry
    : trade.entry - closePrice;

  // Auto-infere TP/SL quando o sistema não conseguiu ler deal.reason do MT5
  // (situação comum quando o deal ainda não estava no histórico no momento da leitura)
  let finalOutcome = outcome;
  if (['MT5_CLOSED', 'MANUAL'].includes(outcome)) {
    const inferred = _inferOutcomeFromPrice(trade, closePrice);
    if (inferred) finalOutcome = inferred;
  }

  const closed = {
    ...trade,
    status:     'closed',
    closedAt:   (closedAt != null && !isNaN(parseFloat(closedAt))) ? parseFloat(closedAt) : Date.now(),
    closePrice,
    outcome:    finalOutcome,
    pnlPct:     risk > 0 ? parseFloat(((rawPnl / trade.entry) * 100).toFixed(4)) : 0,
    pnlR:       risk > 0 ? parseFloat((rawPnl / risk).toFixed(2)) : 0,
    mt5VerifiedClose: !!mt5VerifiedClose,
  };
  if (managedByMt5 != null) closed.managedByMt5 = !!managedByMt5;

  _stmtTradeUpdate.run('closed', JSON.stringify(closed), id);
  return closed;
}

// WEBHOOK_PENDING_GRACE_MS: janela em que um trade managedByMt5 com webhookSent=false
// ainda e considerado "aguardando confirmacao" e e ocultado do dashboard.
// Apos essa janela, o trade e exibido mesmo sem confirmacao (pode ser orfao de restart).
const WEBHOOK_PENDING_GRACE_MS = parseInt(process.env.BOT_WEBHOOK_TIMEOUT_MS || '8000', 10) + 5000;

function listTrades({ asset, status, limit = 100, includePending = false } = {}) {
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
  const parsed = rows.map(r => _ensureTradeRiskSnapshot(JSON.parse(r.data)));
  if (includePending || status !== 'open') return parsed;

  // Oculta apenas trades MT5-managed SEM confirmacao E dentro da janela de graca
  // (tipicamente 13s = timeout 8s + buffer 5s). Apos isso, exibe mesmo sem confirmacao
  // pois o servidor pode ter reiniciado e o handler nunca rodou — trade pode estar no MT5.
  const now = Date.now();
  return parsed.filter(t => {
    if (!t.managedByMt5) return true;          // trade local: sempre visivel
    if (t.webhookSent === true) return true;   // confirmado: visivel
    // Pendente: oculta so se for muito recente (ainda dentro do timeout do webhook)
    return (now - (t.openedAt || 0)) > WEBHOOK_PENDING_GRACE_MS;
  });
}

function getTradeById(id) {
  if (!id || typeof id !== 'string') return null;
  const row = db.prepare('SELECT data FROM trades WHERE id = ?').get(id);
  if (!row) return null;
  return _ensureTradeRiskSnapshot(JSON.parse(row.data));
}

// Atualiza campos opcionais de um trade (notes, tags) sem alterar status/pnl
function updateTrade(id, fields) {
  const ALLOWED = ['notes', 'tags', 'mt5Ticket', 'mt5Size', 'webhookError'];
  const row = db.prepare('SELECT data, status FROM trades WHERE id = ?').get(id);
  if (!row) return null;
  const trade = _ensureTradeRiskSnapshot(JSON.parse(row.data));
  for (const k of ALLOWED) {
    if (fields[k] === undefined) continue;
    if (k === 'mt5Ticket') trade[k] = Number(fields[k]);
    else if (k === 'mt5Size') trade[k] = Number(fields[k]);
    else trade[k] = String(fields[k]).slice(0, 2000); // max 2k chars
  }
  _stmtTradeUpdate.run(row.status, JSON.stringify(trade), id);
  return trade;
}

/**
 * updateTradeMfe — atualiza Max Favorable Excursion (em multiplos de R)
 * de um trade aberto. Chamado pelo loop de candles (alerts.js) e pelo
 * monitor MT5 (bot_webhook_receiver.py via /api/vip/bot/progress).
 *
 * @param {string} id            — trade.id
 * @param {object} args
 * @param {number} args.priceHigh — preco maximo observado desde o ultimo update
 * @param {number} args.priceLow  — preco minimo observado desde o ultimo update
 * @returns {object|null} trade atualizado, ou null se nao encontrado.
 */
function updateTradeMfe(id, { priceHigh, priceLow } = {}) {
  const row = db.prepare("SELECT data FROM trades WHERE id = ? AND status = 'open'").get(id);
  if (!row) return null;
  const trade = _ensureTradeRiskSnapshot(JSON.parse(row.data));
  const risk = _getInitialRisk(trade);
  if (!risk || risk <= 0) return trade;

  // Para BUY a excursao favoravel eh (priceHigh - entry); para SELL eh (entry - priceLow)
  const isBuy = trade.direction === 'BUY';
  const favPrice = isBuy ? priceHigh : priceLow;
  if (favPrice == null || isNaN(favPrice)) return trade;

  const favR = isBuy
    ? (favPrice - trade.entry) / risk
    : (trade.entry - favPrice) / risk;

  // Apenas avanca o pico — nunca regride.
  if (favR > (trade.maxFavorableR || 0)) {
    trade.maxFavorableR = parseFloat(favR.toFixed(3));
    if (!trade.reached1R && favR >= 1.0) { trade.reached1R = true; trade.peakAt1R = Date.now(); }
    if (!trade.reached2R && favR >= 2.0) { trade.reached2R = true; trade.peakAt2R = Date.now(); }
    _stmtTradeUpdate.run('open', JSON.stringify(trade), id);
  }
  return trade;
}

// Atualiza o SL e peakPrice de um trade aberto (usado pelo trailing stop)
// Retorna o trade atualizado ou null se não encontrado
function updateTradeSL(id, { sl, peakPrice } = {}) {
  const row = db.prepare("SELECT data FROM trades WHERE id = ? AND status = 'open'").get(id);
  if (!row) return null;
  const trade = _ensureTradeRiskSnapshot(JSON.parse(row.data));
  if (sl        !== undefined) trade.sl        = sl;
  if (peakPrice !== undefined) trade.peakPrice = peakPrice;
  _stmtTradeUpdate.run('open', JSON.stringify(trade), id);
  return trade;
}

function getStats({ asset } = {}) {
  const rows = asset
    ? db.prepare("SELECT data FROM trades WHERE status='closed' AND asset=?").all(asset)
    : db.prepare("SELECT data FROM trades WHERE status='closed'").all();
  const closed = rows.map(r => _ensureTradeRiskSnapshot(JSON.parse(r.data)));

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

  [bySession, byAsset].forEach(group => {
    Object.values(group).forEach(row => {
      row.totalR = parseFloat(row.totalR.toFixed(2));
      row.avgR = row.trades ? parseFloat((row.totalR / row.trades).toFixed(2)) : 0;
    });
  });

  // ── 1RR / 2RR (MFE) ───────────────────────────────────────────────────
  // Quantos trades atingiram 1R / 2R em algum momento da vida util.
  // Trades sem MFE registrado (legado / pre-feature) vao para 'unknown'.
  const withMfe   = closed.filter(t => typeof t.maxFavorableR === 'number');
  const reached1  = withMfe.filter(t => t.reached1R).length;
  const reached2  = withMfe.filter(t => t.reached2R).length;
  const hitRate1R = withMfe.length ? parseFloat(((reached1 / withMfe.length) * 100).toFixed(1)) : null;
  const hitRate2R = withMfe.length ? parseFloat(((reached2 / withMfe.length) * 100).toFixed(1)) : null;

  // Comparacao de expectativa (R por trade) entre 3 modelos:
  //   model2R     = atual: TP fixo em 2R, SL em 1R → +2R por win, -1R por loss
  //   model1R     = sair em 1R sempre → +1R por trade que atingiu 1R, -1R nos outros
  //   modelTrail  = sair em 1R quando atinge, mas se chegou a 2R captura 2R
  //                 (proxy de breakeven + trailing) → maxFavorableR como teto
  const sample = withMfe;
  const expectancy2R    = sample.length ? sample.reduce((a, t) => a + (t.pnlR || 0), 0) / sample.length : null;
  const expectancy1R    = sample.length ? sample.reduce((a, t) => a + (t.reached1R ? 1 : -1), 0) / sample.length : null;
  const expectancyTrail = sample.length ? sample.reduce((a, t) => {
    if (t.reached2R) return a + 2;
    if (t.reached1R) return a + 1;
    return a - 1;
  }, 0) / sample.length : null;

  return {
    trades:  closed.length,
    winRate: parseFloat(((wins.length / closed.length) * 100).toFixed(1)),
    avgR:    parseFloat(avgR.toFixed(2)),
    totalR:  parseFloat(totalR.toFixed(2)),
    bestR:   parseFloat(bestR.toFixed(2)),
    worstR:  parseFloat(worstR.toFixed(2)),
    byOutcome, bySession, byAsset,
    // MFE / 1RR vs 2RR (so vale para trades com tracking ativo)
    mfe: {
      sampleSize:    sample.length,
      legacyCount:   closed.length - sample.length,
      hitRate1R,
      hitRate2R,
      reached1R:     reached1,
      reached2R:     reached2,
      expectancy2R:  expectancy2R  != null ? parseFloat(expectancy2R.toFixed(3))  : null,
      expectancy1R:  expectancy1R  != null ? parseFloat(expectancy1R.toFixed(3))  : null,
      expectancyTrail: expectancyTrail != null ? parseFloat(expectancyTrail.toFixed(3)) : null,
    },
  };
}

// ── deleteTrade ──────────────────────────────────────────────────────────────
// Remove permanentemente um trade (qualquer status). Retorna true se deletado.
function deleteTrade(id) {
  if (!id || typeof id !== 'string') return false;
  const result = db.prepare("DELETE FROM trades WHERE id = ?").run(id);
  return result.changes > 0;
}

// ── editTrade ─────────────────────────────────────────────────────────────────
// Edita campos de um trade fechado: outcome, closePrice, pnlR, reason.
// Recalcula pnlR automaticamente se closePrice for fornecido.
function editTrade(id, fields = {}) {
  if (!id || typeof id !== 'string') return null;
  const row = db.prepare("SELECT status, data FROM trades WHERE id = ?").get(id);
  if (!row) return null;

  const trade = JSON.parse(row.data);
  _ensureTradeRiskSnapshot(trade);
  const { outcome, closePrice, reason, notes, closedAt, mt5VerifiedClose, managedByMt5 } = fields;

  if (outcome  !== undefined) trade.outcome    = outcome;
  if (reason   !== undefined) trade.reason     = reason;
  if (notes    !== undefined) trade.notes      = notes;
  if (mt5VerifiedClose !== undefined) trade.mt5VerifiedClose = !!mt5VerifiedClose;
  if (managedByMt5 !== undefined) trade.managedByMt5 = !!managedByMt5;
  if (closedAt !== undefined && closedAt !== null && !isNaN(parseFloat(closedAt))) {
    trade.closedAt = parseFloat(closedAt);
  }
  if (closePrice != null && !isNaN(parseFloat(closePrice))) {
    trade.closePrice = parseFloat(closePrice);
    _recomputeClosedTradeMetrics(trade);
  }

  db.prepare("UPDATE trades SET data = ? WHERE id = ?").run(JSON.stringify(trade), id);
  return trade;
}

// -- repairOutcomes -------------------------------------------------------------------
// Varre todos os trades fechados com outcome MT5_CLOSED ou MANUAL e tenta inferir
// o outcome real (TP/SL) com base na proximidade do preço de fechamento ao TP/SL.
// Retorna { repaired: N, skipped: M } — "repaired" = trades com outcome corrigido.
// Seguro de rodar múltiplas vezes (idempotente).
function repairOutcomes() {
  const rows = db.prepare(
    `SELECT id, data FROM trades WHERE status='closed'
     AND (json_extract(data,'$.outcome') = 'MT5_CLOSED'
       OR json_extract(data,'$.outcome') = 'MANUAL')`
  ).all();

  let repaired = 0;
  let skipped  = 0;

  const tx = db.transaction(() => {
    for (const row of rows) {
      let trade;
      try { trade = JSON.parse(row.data); } catch { skipped++; continue; }

      const closePrice = _toFiniteNumber(trade.closePrice);
      if (closePrice == null) { skipped++; continue; }

      const inferred = _inferOutcomeFromPrice(trade, closePrice);
      if (!inferred) { skipped++; continue; }

      trade.outcome = inferred;
      _recomputeClosedTradeMetrics(trade);
      db.prepare('UPDATE trades SET data = ? WHERE id = ?').run(JSON.stringify(trade), row.id);
      repaired++;
    }
  });

  tx();
  return { repaired, skipped };
}

// -- repairPricesFromMt5 --------------------------------------------------------------
// Recebe o array de deals retornado por /history/deals (Python bot) e:
//   1. Cruza cada deal com o trade do dashboard via mt5Ticket (= deal.position_id ou deal.ticket)
//   2. Atualiza closePrice com o preço real do deal MT5
//   3. Re-infere outcome (TP/SL) a partir do deal.reason ou da proximidade de preço
//   4. Recomputa pnlR, pnlPct, markFarFromSl etc.
//   5. Marca mt5VerifiedClose = true
// Retorna { repaired, skipped, notFound }
// Seguro de rodar múltiplas vezes (idempotente — reaplica mesmo preço se já correto).
function repairPricesFromMt5(deals = []) {
  if (!Array.isArray(deals) || !deals.length) return { repaired: 0, skipped: 0, notFound: 0 };

  // Constrói mapa ticketStr → deal para busca rápida
  const dealMap = new Map();
  for (const d of deals) {
    if (d.position_id) dealMap.set(String(d.position_id), d);
    if (d.ticket)      dealMap.set(String(d.ticket), d);
  }

  const rows = db.prepare(
    `SELECT id, data FROM trades WHERE status='closed'
     AND json_extract(data,'$.mt5Ticket') IS NOT NULL`
  ).all();

  let repaired = 0, skipped = 0, notFound = 0;

  const tx = db.transaction(() => {
    for (const row of rows) {
      let trade;
      try { trade = JSON.parse(row.data); } catch { skipped++; continue; }

      const ticketStr = String(trade.mt5Ticket ?? '');
      const deal = dealMap.get(ticketStr);
      if (!deal) { notFound++; continue; }

      const newClose = _toFiniteNumber(deal.price);
      if (newClose == null) { skipped++; continue; }

      // Atualiza preço e timestamps
      trade.closePrice      = newClose;
      trade.mt5VerifiedClose = true;
      if (deal.time_iso) {
        const ts = Date.parse(deal.time_iso);
        if (!isNaN(ts)) trade.closedAt = ts;
      }

      // Resolve outcome: prefere deal.reason (MT5 nativo), depois inferência por preço
      let newOutcome = trade.outcome;
      if (deal.outcome === 'TP' || deal.outcome === 'SL' || deal.outcome === 'MANUAL') {
        newOutcome = deal.outcome;
      } else {
        const inferred = _inferOutcomeFromPrice(trade, newClose);
        if (inferred) newOutcome = inferred;
        else if (['MT5_CLOSED'].includes(trade.outcome)) newOutcome = 'MANUAL';
      }
      trade.outcome = newOutcome;

      // Recomputa pnlR, pnlPct, markFarFromSl etc.
      _recomputeClosedTradeMetrics(trade);

      db.prepare('UPDATE trades SET data = ? WHERE id = ?').run(JSON.stringify(trade), row.id);
      repaired++;
    }
  });

  tx();
  return { repaired, skipped, notFound };
}

// -- resetAll -------------------------------------------------------------------------
// Apaga TODOS os trades, sinais VIP e live_signals. Mantem users e auth_sessions.
function resetAll() {
  const r1 = db.prepare('DELETE FROM trades').run();
  const r2 = db.prepare('DELETE FROM vip_signals').run();
  const r3 = db.prepare('DELETE FROM live_signals').run();
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('vip_signals','live_signals')").run(); } catch (_) {}
  return { trades: r1.changes, vip_signals: r2.changes, live_signals: r3.changes};
}

_repairTradeSnapshots();

// Repair silencioso de outcomes incorretos (MT5_CLOSED/MANUAL → TP/SL)
// Executa na startup, idempotente. Só altera trades onde o preço bate claramente.
try {
  const _repairResult = repairOutcomes();
  if (_repairResult.repaired > 0) {
    console.log(`✅ tradeStore: ${_repairResult.repaired} outcome(s) corrigido(s) na startup (MT5_CLOSED/MANUAL → TP/SL)`);
  }
} catch(e) {
  console.warn('⚠️  tradeStore: erro no repair de outcomes:', e.message);
}

// =========================================================================
// EXPORTS
// =========================================================================

module.exports = {
  openTrade,
  closeTrade,
  updateTrade,
  updateTradeSL,
  updateTradeMfe,
  getTradeById,
  deleteTrade,
  editTrade,
  markWebhookSent,
  resetAll,
  repairOutcomes,
  repairPricesFromMt5,
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
