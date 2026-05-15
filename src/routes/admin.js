'use strict';

/**
 * src/routes/admin.js
 *
 * Roteador Express com as 7 rotas administrativas:
 *   POST  /api/admin/weekly-report               — dispara relatorio semanal manual
 *   GET   /api/admin/users                       — lista usuarios (filtros: accessStatus/role)
 *   POST  /api/admin/users                       — cria usuario via admin
 *   PATCH /api/admin/users/:id                   — atualiza usuario
 *   POST  /api/admin/users/:id/revoke-sessions   — revoga todas as sessoes
 *   GET   /api/admin/auto-trade/status           — estado do auto-trade + cooldowns
 *   POST  /api/admin/auto-trade/toggle           — liga/desliga auto-trade em runtime
 *
 * Padrao de injecao identico ao routes/auth.js.
 *
 * @param {object} deps
 * @param {object} deps.authStore
 * @param {object} deps.scheduler                 — getAutoTradeEnabled / setAutoTradeEnabled / getAutoTradeLastAt
 * @param {Function} deps.sendWeeklyReport
 * @param {Function} deps.sendTelegram
 * @param {Function} deps.rateLimit
 * @param {Function} deps.requireAdmin
 * @param {Function} deps.buildPublicUser
 * @param {object}   deps.logger
 * @param {object}   deps.config
 * @param {boolean}  deps.config.BOT_WEBHOOK_ENABLED
 * @param {number}   deps.config.AUTO_OPEN_SCORE_THRESHOLD
 * @param {number}   deps.config.AUTO_TRADE_COOLDOWN_MS
 *
 * @returns {import('express').Router}
 */

const express = require('express');
const axios = require('axios');

const BOT_STATUS_URL = process.env.BOT_STATUS_URL || 'http://localhost:5000/status';
const BOT_WEBHOOK_TOKEN = process.env.BOT_WEBHOOK_TOKEN || '';

function getBotBaseUrl() {
  try {
    const u = new URL(BOT_STATUS_URL);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'http://localhost:5000';
  }
}

function createAdminRouter(deps) {
  const {
    authStore,
    scheduler,
    sendWeeklyReport,
    sendTelegram,
    rateLimit,
    requireAdmin,
    buildPublicUser,
    logger,
    mt5BridgeState,
    MT5_FEED_MAX_AGE_MS,
    config,
  } = deps;

  const {
    BOT_WEBHOOK_ENABLED,
    AUTO_OPEN_SCORE_THRESHOLD,
    AUTO_TRADE_COOLDOWN_MS,
    AUTO_TRADE_MAX_PER_ASSET,
    AUTO_TRADE_PYRAMID_COOLDOWN_MS,
  } = config;

  const router = express.Router();

  // ── Relatorio semanal sob demanda ───────────────────────────────────────
  router.post('/weekly-report', rateLimit, requireAdmin, async (req, res) => {
    try {
      await sendWeeklyReport();
      res.json({ success: true, message: 'Relatório semanal enviado via Telegram' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── CRUD de usuarios ────────────────────────────────────────────────────
  router.get('/users', rateLimit, requireAdmin, (req, res) => {
    const { accessStatus, role, limit } = req.query;
    const users = authStore.listUsers({
      accessStatus: accessStatus ? String(accessStatus) : undefined,
      role: role ? String(role) : undefined,
      limit: parseInt(limit, 10) || 100,
    });
    res.json({ success: true, count: users.length, users });
  });

  router.post('/users', rateLimit, requireAdmin, (req, res) => {
    const {
      email,
      password,
      role = 'subscriber',
      accessStatus = 'active',
      planCode = 'vip',
      name,
      telegramHandle,
      notes,
    } = req.body || {};

    try {
      const user = authStore.createUser({
        email,
        password,
        role,
        accessStatus,
        planCode,
        profile: { name, telegramHandle, notes, createdVia: 'admin' },
      });
      res.status(201).json({ success: true, user: buildPublicUser(user) });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.patch('/users/:id', rateLimit, requireAdmin, (req, res) => {
    const { id } = req.params;
    const {
      email,
      password,
      role,
      accessStatus,
      planCode,
      name,
      telegramHandle,
      notes,
      revokeSessions,
    } = req.body || {};

    try {
      const updated = authStore.updateUser(id, {
        email,
        password,
        role,
        accessStatus,
        planCode,
        profile: { name, telegramHandle, notes },
      });

      if (!updated) {
        return res.status(404).json({ success: false, error: 'Usuario nao encontrado' });
      }

      if (revokeSessions || password != null || accessStatus === 'canceled' || accessStatus === 'inactive') {
        authStore.revokeSessionsForUser(id);
      }

      res.json({ success: true, user: buildPublicUser(updated) });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.post('/users/:id/revoke-sessions', rateLimit, requireAdmin, (req, res) => {
    const { id } = req.params;
    const revoked = authStore.revokeSessionsForUser(id);
    res.json({ success: true, revoked });
  });

  // ── AUTO-TRADE toggle ───────────────────────────────────────────────────
  router.get('/auto-trade/status', rateLimit, requireAdmin, (req, res) => {
    const lastAt = scheduler.getAutoTradeLastAt();
    const riskState = scheduler.getAutoTradeRiskState ? scheduler.getAutoTradeRiskState() : null;
    res.json({
      autoTradeEnabled:   scheduler.getAutoTradeEnabled(),
      pyramidEnabled:     scheduler.getPyramidEnabled(),
      webhookEnabled:     BOT_WEBHOOK_ENABLED,
      scoreThreshold:     AUTO_OPEN_SCORE_THRESHOLD,
      cooldownHours:      AUTO_TRADE_COOLDOWN_MS / 3600000,
      maxPerAsset:        AUTO_TRADE_MAX_PER_ASSET,
      pyramidCooldownMin: AUTO_TRADE_PYRAMID_COOLDOWN_MS / 60000,
      lastTrades: Object.fromEntries(
        Object.entries(lastAt).map(([k, v]) => [k, new Date(v).toISOString()])
      ),
      riskPause: riskState ? {
        enabled: !!riskState.enabled,
        paused: !!riskState.paused,
        level: riskState.level,
        reason: riskState.reason,
      } : null,
      sessionBlockOverride: scheduler.getSessionBlockOverride ? scheduler.getSessionBlockOverride() : false,
    });
  });

  router.post('/auto-trade/risk-filter', rateLimit, requireAdmin, (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: '"enabled" deve ser true ou false' });
    }
    if (!scheduler.setAutoTradeRiskFilterEnabled) {
      return res.status(501).json({ success: false, error: 'Controle de risco indisponivel neste build' });
    }

    scheduler.setAutoTradeRiskFilterEnabled(enabled);
    const state = enabled ? '🟢 LIGADO' : '🔴 DESLIGADO';
    logger.info(`Filtro de risco do auto-trade ${state} por ${req.auth?.user?.email || 'admin'}`);
    sendTelegram(`🛡️ <b>Filtro de Risco ${state}</b>\n<i>Alterado pelo painel admin</i>`).catch(() => {});

    res.json({
      success: true,
      riskFilterEnabled: enabled,
      riskPause: scheduler.getAutoTradeRiskState ? scheduler.getAutoTradeRiskState() : null,
    });
  });

  // ── SESSION BLOCK OVERRIDE ──────────────────────────────────────────────────
  // Ignora temporariamente o bloqueio de NY puro / sem sessão para testes manuais
  router.post('/auto-trade/session-override', rateLimit, requireAdmin, (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: '"enabled" deve ser true ou false' });
    }
    if (!scheduler.setSessionBlockOverride) {
      return res.status(501).json({ success: false, error: 'Session override indisponivel neste build' });
    }
    scheduler.setSessionBlockOverride(enabled);
    const state = enabled ? '🟡 OVERRIDE ATIVO' : '🔵 NORMAL';
    logger.info(`Session block override ${state} por ${req.auth?.user?.email || 'admin'}`);
    if (enabled) {
      sendTelegram(`⚠️ <b>Bloqueio de Sessão IGNORADO</b>\n<i>Override manual ativo — auto-trade opera em qualquer horário</i>`).catch(() => {});
    }
    res.json({ success: true, sessionBlockOverride: enabled });
  });

  router.post('/auto-trade/pyramid', rateLimit, requireAdmin, (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: '"enabled" deve ser true ou false' });
    }
    scheduler.setPyramidEnabled(enabled);
    const state = enabled ? 'LIGADO' : 'DESLIGADO';
    logger.info(`Pyramid mode ${state} por ${req.auth?.user?.email || 'admin'}`);
    sendTelegram([
      `🔺 <b>Pyramid Mode ${state}</b>`,
      enabled
        ? `Ate ${AUTO_TRADE_MAX_PER_ASSET} trades por ativo | cooldown ${AUTO_TRADE_PYRAMID_COOLDOWN_MS/60000}min`
        : `Modo normal: 1 trade por ativo`,
    ].join('\n')).catch(() => {});
    res.json({ success: true, pyramidEnabled: scheduler.getPyramidEnabled() });
  });

  router.post('/auto-trade/toggle', rateLimit, requireAdmin, (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: '"enabled" deve ser true ou false' });
    }

    scheduler.setAutoTradeEnabled(enabled);
    const state = enabled ? '🟢 LIGADO' : '🔴 DESLIGADO';
    logger.info(`Auto-trade ${state} por ${req.auth?.user?.email || 'admin'}`);

    // Notifica no Telegram também
    sendTelegram(`⚙️ <b>Auto-Trade ${state}</b>\n<i>Alterado pelo painel admin</i>`).catch(() => {});

    res.json({ success: true, autoTradeEnabled: scheduler.getAutoTradeEnabled() });
  });

    // ── TRAILING STOP toggle ────────────────────────────────────────────────
  router.get('/trailing-stop/status', rateLimit, requireAdmin, (req, res) => {
    res.json({ success: true, trailingStopEnabled: scheduler.getTrailingStopEnabled() });
  });

  router.post('/trailing-stop/toggle', rateLimit, requireAdmin, (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: '"enabled" deve ser true ou false' });
    }
    scheduler.setTrailingStopEnabled(enabled);
    const state = enabled ? '🟢 LIGADO' : '🔴 DESLIGADO';
    logger.info(`Trailing Stop ${state} por ${req.auth?.user?.email || 'admin'}`);
    sendTelegram(`📐 <b>Trailing Stop ${state}</b>\n<i>Alterado pelo painel admin</i>`).catch(() => {});
    res.json({ success: true, trailingStopEnabled: scheduler.getTrailingStopEnabled() });
  });

  // ── RESET de operações (apaga todos os trades/sinais) ───────────────────
  router.get('/profit-lock/status', rateLimit, requireAdmin, async (req, res) => {
    try {
      const headers = {};
      if (BOT_WEBHOOK_TOKEN) headers['x-webhook-token'] = BOT_WEBHOOK_TOKEN;
      const resp = await axios.get(`${getBotBaseUrl()}/config/profit-lock`, { headers, timeout: 5000 });
      const data = resp.data || {};
      res.json({
        success: true,
        profitLockEnabled: !!data.profitLockEnabled,
        triggerPct: data.triggerPct,
        securePct: data.securePct,
      });
    } catch (err) {
      res.status(502).json({ success: false, error: err.response?.data?.error || err.message });
    }
  });

  router.post('/profit-lock/toggle', rateLimit, requireAdmin, async (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: '"enabled" deve ser true ou false' });
    }
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (BOT_WEBHOOK_TOKEN) headers['x-webhook-token'] = BOT_WEBHOOK_TOKEN;
      const resp = await axios.post(`${getBotBaseUrl()}/config/profit-lock`, { enabled }, { headers, timeout: 5000 });
      const data = resp.data || {};
      const state = data.profitLockEnabled ? '🟢 LIGADO' : '🔴 DESLIGADO';
      logger.info(`Profit Lock ${state} por ${req.auth?.user?.email || 'admin'}`);
      sendTelegram(`🔐 <b>Profit Lock ${state}</b>\n<i>80% do alvo -> trava 20% do ganho</i>\n<i>Alterado pelo painel admin</i>`).catch(() => {});
      res.json({
        success: true,
        profitLockEnabled: !!data.profitLockEnabled,
        triggerPct: data.triggerPct,
        securePct: data.securePct,
      });
    } catch (err) {
      res.status(502).json({ success: false, error: err.response?.data?.error || err.message });
    }
  });

  router.get('/bot-status', rateLimit, requireAdmin, async (req, res) => {
    try {
      const headers = {};
      if (BOT_WEBHOOK_TOKEN) headers['x-webhook-token'] = BOT_WEBHOOK_TOKEN;
      const botResp = await axios.get(`${getBotBaseUrl()}/status`, { headers, timeout: 5000 });
      const bot = botResp.data || {};
      const profit = bot.profit_lock || {};
      res.json({
        success: true,
        botStatus: bot.bot_status || 'UNKNOWN',
        account: bot.account || null,
        positions: Array.isArray(bot.positions) ? bot.positions : [],
        profitLockEnabled: !!profit.profitLockEnabled,
        profitLockTriggerPct: profit.triggerPct,
        profitLockSecurePct: profit.securePct,
        autoTradeEnabled: scheduler.getAutoTradeEnabled(),
        trailingStopEnabled: scheduler.getTrailingStopEnabled(),
        timestamp: bot.timestamp || new Date().toISOString(),
      });
    } catch (err) {
      // Bot HTTP server unreachable — fall back to MT5 push data if fresh
      const remoteReceivedAt = mt5BridgeState?.remoteReceivedAt || null;
      const maxAge = MT5_FEED_MAX_AGE_MS || 600000;
      const pushFresh = remoteReceivedAt && (Date.now() - remoteReceivedAt) <= maxAge;
      if (pushFresh) {
        const snap = mt5BridgeState.remoteSnapshot || {};
        const account = snap.account || null;
        return res.json({
          success: true,
          botStatus: 'OK',
          account,
          positions: [],
          profitLockEnabled: scheduler.getAutoTradeEnabled ? false : false,
          autoTradeEnabled: scheduler.getAutoTradeEnabled(),
          trailingStopEnabled: scheduler.getTrailingStopEnabled(),
          timestamp: new Date().toISOString(),
          source: 'mt5_push',
        });
      }
      res.status(502).json({ success: false, error: err.response?.data?.error || err.message });
    }
  });

  router.post('/trades/reset', rateLimit, requireAdmin, (req, res) => {
    try {
      const tradeStore = require('../../tradeStore');
      const result = tradeStore.resetAll();
      logger.info(`Reset de operações por ${req.auth?.user?.email || 'admin'}: ${JSON.stringify(result)}`);
      res.json({ success: true, deleted: result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── REPAIR OUTCOMES ──────────────────────────────────────────────────────────
  // Corrige trades fechados com outcome MT5_CLOSED/MANUAL inferindo TP ou SL
  // pelo preço de fechamento vs TP/SL do trade (dentro de 30% do range tp↔sl).
  router.post('/trades/repair-outcomes', rateLimit, requireAdmin, (req, res) => {
    try {
      const tradeStore = require('../../tradeStore');
      if (!tradeStore.repairOutcomes) {
        return res.status(501).json({ success: false, error: 'repairOutcomes indisponível neste build' });
      }
      const result = tradeStore.repairOutcomes();
      logger.info(`Repair outcomes por ${req.auth?.user?.email || 'admin'}: ${JSON.stringify(result)}`);
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── MT5 HISTORY (via bot Python) ─────────────────────────────────────────────
  // Busca deals fechados no MT5 nas últimas N horas para comparação com dashboard
  // GET /api/admin/mt5-history?hours=168   (default: 7 dias, max: 30 dias)
  router.get('/mt5-history', rateLimit, requireAdmin, async (req, res) => {
    try {
      const hours = Math.min(parseInt(req.query.hours || '168', 10), 720);
      const headers = {};
      if (BOT_WEBHOOK_TOKEN) headers['x-webhook-token'] = BOT_WEBHOOK_TOKEN;
      const resp = await axios.get(
        `${getBotBaseUrl()}/history/deals?hours=${hours}`,
        { headers, timeout: 10000 }
      );
      res.json(resp.data);
    } catch (err) {
      res.status(502).json({ success: false, error: err.response?.data?.error || err.message });
    }
  });

  // ── REPAIR PRICES FROM MT5 ────────────────────────────────────────────────────
  // Busca histórico real do MT5, cruza por mt5Ticket e corrige closePrice + outcome
  // POST /api/admin/trades/repair-prices-from-mt5?hours=336
  router.post('/trades/repair-prices-from-mt5', rateLimit, requireAdmin, async (req, res) => {
    try {
      const tradeStore = require('../../tradeStore');
      if (!tradeStore.repairPricesFromMt5) {
        return res.status(501).json({ success: false, error: 'repairPricesFromMt5 indisponível neste build' });
      }

      // Busca histórico MT5 (default 14 dias)
      const hours = Math.min(parseInt(req.query.hours || '336', 10), 720);
      const headers = {};
      if (BOT_WEBHOOK_TOKEN) headers['x-webhook-token'] = BOT_WEBHOOK_TOKEN;

      let deals = [];
      try {
        const resp = await axios.get(
          `${getBotBaseUrl()}/history/deals?hours=${hours}`,
          { headers, timeout: 15000 }
        );
        deals = resp.data?.deals || [];
      } catch (botErr) {
        return res.status(502).json({
          success: false,
          error: `Falha ao buscar histórico MT5: ${botErr.response?.data?.error || botErr.message}`,
        });
      }

      const result = tradeStore.repairPricesFromMt5(deals);
      logger.info(
        `Repair prices from MT5 por ${req.auth?.user?.email || 'admin'}: ` +
        `${JSON.stringify(result)} (${deals.length} deals MT5 recebidos)`
      );
      res.json({ success: true, dealsReceived: deals.length, ...result });
    } catch (e) {
      logger.error('repair-prices-from-mt5 error:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
