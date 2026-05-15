'use strict';

/**
 * src/routes/system.js
 *
 * Roteador Express com as rotas de saude/observabilidade do sistema:
 *   GET  /api/health                       — status agregado (ativos + risk + MT5 + versao)
 *   GET  /api/telegram/test                — envia mensagem de teste ao Telegram
 *   POST /api/telegram/test                — idem (compatibilidade botao dashboard)
 *   GET  /api/telegram/status              — config Telegram + cooldown por ativo
 *   GET  /api/news                         — calendario economico + status por ativo
 *   GET  /api/live-signals                 — lista sinais ao vivo persistidos
 *   GET  /api/live-signals/stats           — estatisticas agregadas
 *   GET  /api/live-signals/executive       — resumo executivo (drawdown/streaks/contextos)
 *   GET  /api/risk-state                   — estado de risco do sistema (NORMAL/.../BLOCKED)
 *
 * Padrao de injecao identico aos outros routers — todas as deps vem por
 * factory para evitar imports circulares (server.js define newsCache,
 * fetchEconomicCalendar, getNewsStatus localmente, esses sao injetados).
 *
 * @param {object} deps
 * @param {object}   deps.ASSETS
 * @param {object}   deps.cache
 * @param {object}   deps.tradeStore
 * @param {object}   deps.lastSignals
 * @param {number}   deps.ALERT_COOLDOWN_MS
 * @param {Function} deps.sendTelegram
 * @param {Function} deps.fetchEconomicCalendar
 * @param {Function} deps.getNewsStatus
 * @param {object}   deps.newsCacheRef             — { get: () => newsCache } pois newsCache eh reasignado
 * @param {Function} deps.normalizeEpochMs
 * @param {Function} deps.getPreferredMt5Snapshot
 * @param {Function} deps.rateLimit
 * @param {object}   deps.config
 * @param {string}   deps.config.VERSION
 * @param {string}   deps.config.TWELVE_DATA_KEY
 * @param {string}   deps.config.TELEGRAM_TOKEN
 * @param {string}   deps.config.TELEGRAM_CHAT_ID
 * @param {boolean}  deps.config.TELEGRAM_ENABLED
 * @param {boolean}  deps.config.LOCAL_SAFE
 * @param {string}   deps.config.OANDA_API_KEY
 * @param {boolean}  deps.config.OANDA_PRACTICE
 * @param {string}   deps.config.FINNHUB_API_KEY
 * @param {string}   deps.config.MT5_PUSH_TOKEN
 * @param {number}   deps.config.MT5_FEED_MAX_AGE_MS
 * @param {number}   deps.config.DASHBOARD_PUSH_MS
 * @param {boolean}  deps.config.AUTO_BLOCK_WEAK_CONTEXT
 * @param {number}   deps.config.ALERT_INTERVAL_MS
 *
 * @returns {import('express').Router}
 */

const express = require('express');

const RISK_LEVEL_EMOJI = { NORMAL: '🟢', CAUTIOUS: '🟡', DEFENSIVE: '🟠', BLOCKED: '🔴' };
const RISK_DESCRIPTIONS = {
  NORMAL:    'Sistema operando normalmente. Todos os sinais elegíveis emitidos.',
  CAUTIOUS:  'Cautela ativa. Apenas score 3 (máximo) permite emissão. Sizing 75%.',
  DEFENSIVE: 'Modo defensivo. Apenas BTC/XAU, score 3 obrigatório. Sizing 50%.',
  BLOCKED:   'Sistema pausado. Nenhum sinal emitido até recuperação.',
};

const TELEGRAM_TEST_MSG = '✅ <b>Trading Dashboard — Teste de conexão OK!</b>\n\nBot conectado ao grupo. Alertas automáticos serão enviados aqui quando os sinais mudarem.';

function createSystemRouter(deps) {
  const {
    ASSETS,
    cache,
    tradeStore,
    lastSignals,
    ALERT_COOLDOWN_MS,
    sendTelegram,
    fetchEconomicCalendar,
    getNewsStatus,
    newsCacheRef,
    normalizeEpochMs,
    getPreferredMt5Snapshot,
    rateLimit,
    config,
  } = deps;

  const {
    VERSION,
    TWELVE_DATA_KEY,
    TELEGRAM_TOKEN,
    TELEGRAM_CHAT_ID,
    TELEGRAM_ENABLED,
    LOCAL_SAFE,
    OANDA_API_KEY,
    OANDA_PRACTICE,
    FINNHUB_API_KEY,
    MT5_PUSH_TOKEN,
    MT5_FEED_MAX_AGE_MS,
    DASHBOARD_PUSH_MS,
    AUTO_BLOCK_WEAK_CONTEXT,
    ALERT_INTERVAL_MS,
  } = config;

  const router = express.Router();

  // ── GET /health ────────────────────────────────────────────────────────
  router.get('/health', rateLimit, (_req, res) => {
    const status = {};
    Object.entries(ASSETS).forEach(([key, cfg]) => {
      const c   = cache[key];
      const age = c.updatedAt ? Math.round((Date.now() - c.updatedAt) / 60000) : null;
      status[cfg.name] = c.data?.price
        ? `${c.data.price.toFixed(cfg.decimals)} (${age}min atrás) [${c.data.source || 'n/a'}]`
        : 'carregando...';
    });
    const risk           = tradeStore.getRiskState();
    const preferredMt5   = getPreferredMt5Snapshot();
    const mt5GeneratedAt = normalizeEpochMs(preferredMt5.snapshot?.generatedAt);
    const mt5AgeMs       = mt5GeneratedAt ? Date.now() - mt5GeneratedAt : null;

    res.json({
      status:        'ok',
      version:       VERSION,
      twelveDataKey: TWELVE_DATA_KEY === 'COLE_SUA_CHAVE_AQUI' ? '❌ não configurado' : '✅ ok',
      btcFonte:      cache['btc']?.data?.source || 'carregando...',
      oanda:         OANDA_API_KEY  ? `✅ configurado (${OANDA_PRACTICE ? 'prática' : 'real'})` : 'ℹ️ não configurado',
      finnhub:       FINNHUB_API_KEY ? '✅ configurado (preço spot 2min)' : 'ℹ️ não configurado',
      mt5Bridge: {
        source:           preferredMt5.source || 'offline',
        fresh:            mt5AgeMs != null ? mt5AgeMs <= MT5_FEED_MAX_AGE_MS : false,
        ageMs:            mt5AgeMs,
        tokenConfigured:  !!MT5_PUSH_TOKEN,
        dashboardPushMs:  DASHBOARD_PUSH_MS,
      },
      autoBlockWeakContext: AUTO_BLOCK_WEAK_CONTEXT ? '✅ ativo' : '⏸ desativado',
      yahooFinance:  '⏸ desativado',
      alertInterval: `${ALERT_INTERVAL_MS / 60000} min`,
      riskManagement: {
        level:            risk.level,
        emoji:            RISK_LEVEL_EMOJI[risk.level] || '⚪',
        reason:           risk.reason,
        streakLoss:       risk.streakLoss,
        drawdownPct:      risk.drawdownPct,
        dailyLoss:        risk.dailyLoss,
        sizingMultiplier: risk.sizingMultiplier,
      },
      ativos: status,
    });
  });

  // ── /telegram/test (GET + POST, mesma logica) ──────────────────────────
  async function telegramTestHandler(_req, res) {
    if (LOCAL_SAFE) {
      return res.json({ ok: false, error: 'Telegram desativado localmente: LOCAL_SAFE=true' });
    }
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.json({ ok: false, error: 'TELEGRAM_TOKEN ou TELEGRAM_CHAT_ID não configurado no .env' });
    }
    try {
      await sendTelegram(TELEGRAM_TEST_MSG);
      res.json({ ok: true, message: 'Mensagem enviada com sucesso ao Telegram!' });
    } catch (err) {
      const detail = err.response?.data?.description || err.message;
      res.json({ ok: false, error: `Falha na entrega ao Telegram: ${detail}` });
    }
  }
  router.get( '/telegram/test', rateLimit, telegramTestHandler);
  router.post('/telegram/test', rateLimit, telegramTestHandler);

  // ── GET /telegram/status ───────────────────────────────────────────────
  router.get('/telegram/status', rateLimit, (_req, res) => {
    const now = Date.now();
    const signalStatus = {};
    Object.entries(lastSignals).forEach(([k, v]) => {
      const remainMs = v.lastSentAt ? Math.max(0, ALERT_COOLDOWN_MS - (now - v.lastSentAt)) : 0;
      signalStatus[k] = {
        lastLabel:        v.masterLabel,
        cooldownRestante: remainMs > 0 ? `${Math.ceil(remainMs / 60000)}min` : 'livre',
      };
    });
    res.json({
      configured: TELEGRAM_ENABLED,
      localSafe:  LOCAL_SAFE,
      botToken:   TELEGRAM_TOKEN ? (LOCAL_SAFE ? '🛡️ presente, mas bloqueado por LOCAL_SAFE' : '✅ configurado') : '❌ faltando TELEGRAM_TOKEN no .env',
      chatId:     TELEGRAM_CHAT_ID ? (LOCAL_SAFE ? '🛡️ presente, mas bloqueado por LOCAL_SAFE' : '✅ configurado') : '❌ faltando TELEGRAM_CHAT_ID no .env',
      cooldownPorAtivo: signalStatus,
    });
  });

  // ── GET /news ──────────────────────────────────────────────────────────
  router.get('/news', rateLimit, async (_req, res) => {
    try {
      const events = await fetchEconomicCalendar();
      const statusByAsset = {};
      for (const key of Object.keys(ASSETS)) {
        statusByAsset[key] = getNewsStatus(key);
      }
      const newsCache = newsCacheRef.get();
      res.json({
        success: true,
        events,
        statusByAsset,
        cacheAge: newsCache.updatedAt ? Math.round((Date.now() - newsCache.updatedAt) / 60000) + 'min' : 'n/a',
      });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ── GET /live-signals ──────────────────────────────────────────────────
  router.get('/live-signals', rateLimit, (req, res) => {
    const { asset, status, limit } = req.query;
    const signals = tradeStore.listLiveSignals({
      asset,
      status,
      limit: parseInt(limit, 10) || 100,
    });
    res.json({ success: true, count: signals.length, signals });
  });

  router.get('/live-signals/stats', rateLimit, (req, res) => {
    const { asset } = req.query;
    const stats = tradeStore.getLiveSignalStats({ asset });
    res.json({ success: true, stats });
  });

  router.get('/live-signals/executive', rateLimit, (req, res) => {
    const { asset } = req.query;
    const stats = tradeStore.getLiveSignalStats({ asset });
    res.json({
      success:        true,
      executive:      stats.executive   || {},
      recent:         stats.recent      || {},
      recentDaily:    stats.recentDaily || [],
      drawdown:       stats.drawdown    || {},
      streaks:        stats.streaks     || {},
      strongContexts: stats.strongContexts || [],
      weakContexts:   stats.weakContexts   || [],
    });
  });

  // ── GET /risk-state ────────────────────────────────────────────────────
  router.get('/risk-state', rateLimit, (_req, res) => {
    try {
      const risk = tradeStore.getRiskState();
      res.json({
        success:           true,
        level:             risk.level,
        emoji:             RISK_LEVEL_EMOJI[risk.level] || '⚪',
        reason:            risk.reason,
        streakLoss:        risk.streakLoss,
        drawdownPct:       risk.drawdownPct,
        dailyLoss:         risk.dailyLoss,
        sizingMultiplier:  risk.sizingMultiplier,
        minScore:          risk.minScore === Infinity ? null : risk.minScore,
        allowedAssets:     risk.allowedAssets,
        description:       RISK_DESCRIPTIONS[risk.level],
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
}

module.exports = { createSystemRouter };
