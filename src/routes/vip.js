'use strict';

/**
 * src/routes/vip.js
 *
 * Roteador Express com as 8 rotas VIP:
 *   GET   /api/vip/signal           — sinal VIP do ativo (com cache 2min)
 *   GET   /api/vip/signals          — historico de sinais persistidos
 *   POST  /api/vip/trades/open      — abre trade (valida via computeVipSignal)
 *   POST  /api/vip/trades/close     — fecha trade + notifica Telegram
 *   GET   /api/vip/trades           — lista trades
 *   GET   /api/vip/stats            — stats agregadas
 *   PATCH /api/vip/trades/:id       — atualiza notas/tags do trade
 *   GET   /api/vip/scan             — varre todos ativos e popula cache
 *
 * Cache de sinais (_signalCache) e SIGNAL_CACHE_TTL vem injetados (vivem em
 * src/services/signals.js — compartilhados com o scheduler).
 *
 * @param {object} deps
 * @param {Function} deps.computeVipSignal
 * @param {object}   deps._signalCache              — cache compartilhado
 * @param {number}   deps.SIGNAL_CACHE_TTL          — TTL em ms
 * @param {object}   deps.tradeStore
 * @param {Function} deps.callBotWebhook
 * @param {Function} deps.sendTelegram
 * @param {object}   deps.ASSETS
 * @param {Function} deps.rateLimit
 * @param {Function} deps.requireVipAccess
 * @param {object}   deps.logger
 * @param {object}   deps.config
 * @param {boolean}  deps.config.BOT_WEBHOOK_ENABLED
 *
 * @returns {import('express').Router}
 */

const express = require('express');

const VALID_TFS = ['15m', '1h', '4h', 'daily', '1d'];
const COMPUTE_TIMEOUT_MS = 20_000;

function createVipRouter(deps) {
  const {
    computeVipSignal,
    _signalCache,
    SIGNAL_CACHE_TTL,
    tradeStore,
    callBotWebhook,
    sendTelegram,
    ASSETS,
    rateLimit,
    requireVipAccess,
    logger,
    config,
  } = deps;

  const { BOT_WEBHOOK_ENABLED } = config;

  const router = express.Router();

  // ── GET /signal ─────────────────────────────────────────────────────────
  router.get('/signal', rateLimit, requireVipAccess, async (req, res) => {
    const asset   = (req.query.asset   || 'xauusd').toLowerCase();
    const entryTf = (req.query.entryTf || '15m').toLowerCase();
    const biasTf  = (req.query.biasTf  || '1h').toLowerCase();
    if (!ASSETS[asset]) return res.status(404).json({ success: false, error: `Ativo não encontrado: ${asset}` });
    if (!VALID_TFS.includes(entryTf)) return res.status(400).json({ success: false, error: `entryTf inválido` });
    if (!VALID_TFS.includes(biasTf))  return res.status(400).json({ success: false, error: `biasTf inválido` });

    const cacheKey     = `${asset}:${entryTf}:${biasTf}`;
    const cached       = _signalCache[cacheKey];
    const forceRefresh = req.query.force === '1';

    if (!forceRefresh && cached && (Date.now() - cached.cachedAt) < SIGNAL_CACHE_TTL) {
      return res.json({ ...cached.data, _cached: true, _cachedAt: cached.cachedAt });
    }

    try {
      const signal = await Promise.race([
        computeVipSignal(asset, entryTf, biasTf, { skipPersist: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout ao calcular sinal (>20s)')), COMPUTE_TIMEOUT_MS)),
      ]);
      _signalCache[cacheKey] = { data: signal, cachedAt: Date.now() };
      res.json(signal);
    } catch (err) {
      logger.error('VIP signal error:', err.message);
      if (cached) return res.json({ ...cached.data, _cached: true, _stale: true, _staleReason: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── GET /signals (historico persistido) ─────────────────────────────────
  router.get('/signals', rateLimit, requireVipAccess, (req, res) => {
    const { asset, status, limit } = req.query;
    const signals = tradeStore.listSignals({ asset, status, limit: parseInt(limit) || 100 });
    res.json({ success: true, count: signals.length, signals });
  });

  // ── POST /trades/open ───────────────────────────────────────────────────
  router.post('/trades/open', rateLimit, requireVipAccess, async (req, res) => {
    const { asset, direction, entry, sl, tp, atr, rr, score, biasTf, entryTf, session, reason } = req.body;
    if (!asset || !direction || entry == null || sl == null || tp == null)
      return res.status(400).json({ success: false, error: 'Campos obrigatórios: asset, direction, entry, sl, tp' });
    if (!['BUY', 'SELL'].includes((direction || '').toUpperCase()))
      return res.status(400).json({ success: false, error: 'direction deve ser BUY ou SELL' });
    if (!ASSETS[asset.toLowerCase()])
      return res.status(404).json({ success: false, error: `Ativo não encontrado: ${asset}` });

    try {
      const freshSignal = await computeVipSignal(asset.toLowerCase(), entryTf || '15m', biasTf || '1h', { skipPersist: true });
      const blockedStatuses = ['NEWS_BLOCKED', 'CONTEXT_BLOCKED', 'NO_SIGNAL', 'NO_BIAS', 'INSUFFICIENT_DATA', 'SIMULATION_BLOCKED', 'MARKET_CLOSED'];
      if (blockedStatuses.includes(freshSignal.status)) {
        return res.status(409).json({
          success: false,
          error: `Trade bloqueado: ${freshSignal.meta?.reason || freshSignal.status}`,
          status: freshSignal.status,
        });
      }
    } catch (validationErr) {
      return res.status(500).json({ success: false, error: `Falha ao validar sinal VIP: ${validationErr.message}` });
    }

    const trade = tradeStore.openTrade({
      asset: asset.toLowerCase(), direction: direction.toUpperCase(),
      entry: parseFloat(entry), sl: parseFloat(sl), tp: parseFloat(tp),
      atr: parseFloat(atr) || 0, rr: parseFloat(rr) || 2,
      score: parseInt(score) || 0, biasTf, entryTf, session, reason,
      managedByMt5: !!BOT_WEBHOOK_ENABLED,
      source: 'manual',  // identifica abertura manual — considerado como enviado para dedup
    });

    if (BOT_WEBHOOK_ENABLED) {
      try {
        const botResult = await callBotWebhook(trade);
        if (botResult?.ok) {
          if (tradeStore.markWebhookSent) tradeStore.markWebhookSent(trade.id);
        } else {
          if (tradeStore.deleteTrade) tradeStore.deleteTrade(trade.id);
          return res.status(502).json({
            success: false,
            error: `Bot MT5 nao abriu a operacao: ${botResult?.reason || 'webhook nao confirmou abertura'}`,
          });
        }
      } catch (err) {
        if (tradeStore.deleteTrade) tradeStore.deleteTrade(trade.id);
        return res.status(502).json({ success: false, error: `Bot MT5 erro: ${err.message}` });
      }
    } else if (tradeStore.markWebhookSent) {
      // Sem webhook, o trade e apenas controlado pelo dashboard.
      tradeStore.markWebhookSent(trade.id);
    }

    // Alerta Telegram: trade aberto
    const dirEmoji = trade.direction === 'BUY' ? '📈' : '📉';
    const openMsg = [
      `⭐ <b>VIP — TRADE ABERTO</b> ${dirEmoji}`,
      ``,
      `<b>${(trade.asset || '').toUpperCase()}</b>  ${trade.direction}`,
      `Entry: <b>${trade.entry}</b>`,
      `Stop:  <b>${trade.sl}</b>`,
      `Alvo:  <b>${trade.tp}</b>`,
      `Score VIP: ${trade.score}/7  |  R:R 1:${trade.rr}`,
      trade.session ? `Sessão: ${trade.session}` : '',
      trade.reason  ? `Obs: ${trade.reason}` : '',
    ].filter(Boolean).join('\n');
    sendTelegram(openMsg).catch(() => {});

    res.json({ success: true, trade });
  });

  // ── POST /trades/close ──────────────────────────────────────────────────
  router.post('/trades/close', rateLimit, requireVipAccess, (req, res) => {
    const { id, closePrice, outcome } = req.body;
    if (!id || closePrice == null)
      return res.status(400).json({ success: false, error: 'Campos obrigatórios: id, closePrice' });
    const existing = tradeStore.getTradeById ? tradeStore.getTradeById(id) : null;
    if (existing?.mt5Ticket || existing?.managedByMt5) {
      return res.status(409).json({
        success: false,
        error: 'Trade gerido pelo MT5. O fechamento deve vir do broker para manter o dashboard fiel.',
      });
    }
    const trade = tradeStore.closeTrade(id, { closePrice: parseFloat(closePrice), outcome: outcome || 'MANUAL' });
    if (!trade) return res.status(404).json({ success: false, error: `Trade não encontrado: ${id}` });

    // Alerta Telegram: trade fechado
    const pnlPos = (trade.pnlR || 0) >= 0;
    const outcomeEmoji = trade.outcome === 'TP' ? '✅' : trade.outcome === 'SL' ? '❌' : '✏️';
    const pnlEmoji = pnlPos ? '💰' : '📉';
    const closeMsg = [
      `⭐ <b>VIP — TRADE FECHADO</b> ${outcomeEmoji}`,
      ``,
      `<b>${(trade.asset || '').toUpperCase()}</b>  ${trade.direction}  →  ${trade.outcome}`,
      `Entry: ${trade.entry}  |  Close: <b>${trade.closePrice}</b>`,
      `Resultado: ${pnlEmoji} <b>${pnlPos ? '+' : ''}${trade.pnlR}R</b>  (${pnlPos ? '+' : ''}${trade.pnlPct}%)`,
      trade.session ? `Sessão: ${trade.session}` : '',
    ].filter(Boolean).join('\n');
    sendTelegram(closeMsg).catch(() => {});

    res.json({ success: true, trade });
  });

  // ── GET /trades ─────────────────────────────────────────────────────────
  router.get('/trades', rateLimit, requireVipAccess, (req, res) => {
    const { asset, status, limit } = req.query;
    const trades = tradeStore.listTrades({ asset, status, limit: parseInt(limit) || 100 });
    res.json({ success: true, count: trades.length, trades });
  });

  // ── GET /stats ──────────────────────────────────────────────────────────
  router.get('/stats', rateLimit, requireVipAccess, (req, res) => {
    const { asset } = req.query;
    const stats = tradeStore.getStats({ asset });
    res.json({ success: true, stats });
  });

  // ── PATCH /trades/:id ───────────────────────────────────────────────────
  router.patch('/trades/:id', rateLimit, requireVipAccess, (req, res) => {
    const { id } = req.params;
    if (!id || typeof id !== 'string') return res.status(400).json({ success: false, error: 'ID inválido' });
    const updated = tradeStore.updateTrade(id, req.body || {});
    if (!updated) return res.status(404).json({ success: false, error: 'Trade não encontrado' });
    res.json({ success: true, trade: updated });
  });

  // ── PUT /trades/:id ── editar outcome / closePrice / reason ─────────────
  router.put('/trades/:id', rateLimit, requireVipAccess, (req, res) => {
    const { id } = req.params;
    if (!id || typeof id !== 'string') return res.status(400).json({ success: false, error: 'ID inválido' });
    const existing = tradeStore.getTradeById ? tradeStore.getTradeById(id) : null;
    if (existing?.mt5Ticket || existing?.managedByMt5) {
      const forbidden = ['closePrice', 'outcome', 'closedAt'];
      const hasForbidden = forbidden.some(k => Object.prototype.hasOwnProperty.call(req.body || {}, k));
      if (hasForbidden) {
        return res.status(409).json({
          success: false,
          error: 'Trade gerido pelo MT5. Resultado e horário de fechamento devem refletir apenas o broker.',
        });
      }
    }
    const edited = tradeStore.editTrade(id, req.body || {});
    if (!edited) return res.status(404).json({ success: false, error: 'Trade não encontrado' });
    res.json({ success: true, trade: edited });
  });

  // ── DELETE /trades/:id ── exclui trade permanentemente ──────────────────
  router.delete('/trades/:id', rateLimit, requireVipAccess, (req, res) => {
    const { id } = req.params;
    if (!id || typeof id !== 'string') return res.status(400).json({ success: false, error: 'ID inválido' });
    const deleted = tradeStore.deleteTrade(id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Trade não encontrado' });
    res.json({ success: true, id });
  });

  // ── GET /scan ───────────────────────────────────────────────────────────
  router.get('/scan', rateLimit, requireVipAccess, async (req, res) => {
    const entryTf = (req.query.entryTf || '15m').toLowerCase();
    const biasTf  = (req.query.biasTf  || '1h').toLowerCase();
    if (!VALID_TFS.includes(entryTf)) return res.status(400).json({ success: false, error: 'entryTf inválido' });
    if (!VALID_TFS.includes(biasTf))  return res.status(400).json({ success: false, error: 'biasTf inválido' });

    const results = {};
    await Promise.all(Object.keys(ASSETS).map(async (key) => {
      try {
        const sig = await computeVipSignal(key, entryTf, biasTf, { skipPersist: true });
        // Popula _signalCache para que /api/vip/signal retorne do cache imediatamente apos o scan
        _signalCache[`${key}:${entryTf}:${biasTf}`] = { data: sig, cachedAt: Date.now() };
        results[key] = {
          asset:     key,
          name:      ASSETS[key].name,
          status:    sig.status,
          direction: sig.direction,
          score:     sig.score,
          maxScore:  sig.maxScore,
          adx:       sig.meta?.adx,
          session:   sig.meta?.session,
          price:     sig.meta?.price,
          levels:    sig.levels,
          operationalContext: sig.operationalContext || null,
        };
      } catch (e) {
        results[key] = { asset: key, name: ASSETS[key].name, status: 'ERROR', score: 0, error: e.message };
      }
    }));
    res.json({ success: true, entryTf, biasTf, scannedAt: Date.now(), results });
  });

  // ── POST /bot/progress — bot reporta MFE/MAE de uma posicao aberta ──────
  // Chamado periodicamente pelo monitor MT5 (Python) com priceHigh/priceLow
  // observados desde a ultima chamada. Avanca apenas o pico — nunca regride.
  router.post('/bot/progress', (req, res) => {
    const token = req.headers['x-webhook-token'] || '';
    if (config.BOT_WEBHOOK_TOKEN && token !== config.BOT_WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { tradeId, priceHigh, priceLow } = req.body || {};
    if (!tradeId) return res.status(400).json({ error: 'tradeId obrigatorio' });
    const updated = tradeStore.updateTradeMfe(tradeId, {
      priceHigh: priceHigh != null ? parseFloat(priceHigh) : undefined,
      priceLow:  priceLow  != null ? parseFloat(priceLow)  : undefined,
    });
    if (!updated) return res.status(404).json({ error: 'Trade nao encontrado ou ja fechado' });
    res.json({
      success: true,
      tradeId,
      maxFavorableR: updated.maxFavorableR,
      reached1R: updated.reached1R,
      reached2R: updated.reached2R,
    });
  });

  // ── POST /bot/result — bot notifica fechamento real de trade no MT5 ───────
  // Chamado pelo bot Python quando MT5 fecha a posição (TP/SL/manual).
  // Usa o preço real do broker (FTMO) em vez de estimativa por candle de API.
  router.post('/bot/result', (req, res) => {
    // Valida token do bot (mesmo token do webhook de abertura)
    const token = req.headers['x-webhook-token'] || '';
    if (config.BOT_WEBHOOK_TOKEN && token !== config.BOT_WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tradeId, ticket, closePrice, outcome, closedAt } = req.body || {};
    if (!tradeId || closePrice == null || isNaN(parseFloat(closePrice))) {
      return res.status(400).json({ error: 'tradeId e closePrice sao obrigatorios' });
    }

    const validOutcomes = ['TP', 'SL', 'MANUAL', 'BOT_MANAGED'];
    const resolvedOutcome = validOutcomes.includes(outcome) ? outcome : 'BOT_MANAGED';

    const brokerClosedAt = closedAt ? Date.parse(closedAt) : Date.now();
    const existing = tradeStore.getTradeById ? tradeStore.getTradeById(tradeId) : null;
    if (!existing) {
      logger.info(`Bot resultado: trade ${tradeId} nao encontrado`);
      return res.status(404).json({ error: 'Trade nao encontrado' });
    }

    if (ticket && existing.mt5Ticket && Number(existing.mt5Ticket) !== Number(ticket)) {
      logger.warn(`Bot resultado ignorado: trade ${tradeId} ticket divergente (dashboard=${existing.mt5Ticket} broker=${ticket})`);
      return res.status(409).json({ error: 'Ticket divergente para este trade' });
    }

    let closed = null;
    if (existing.status === 'open') {
      closed = tradeStore.closeTrade(tradeId, {
        closePrice: parseFloat(closePrice),
        outcome:    resolvedOutcome,
        closedAt:   brokerClosedAt,
        mt5VerifiedClose: true,
        managedByMt5: true,
      });
    } else {
      closed = tradeStore.editTrade
        ? tradeStore.editTrade(tradeId, {
            closePrice: parseFloat(closePrice),
            outcome: resolvedOutcome,
            closedAt: brokerClosedAt,
            mt5VerifiedClose: true,
            managedByMt5: true,
          })
        : existing;
    }

    if (!closed) {
      logger.info(`Bot resultado: trade ${tradeId} nao pode ser reconciliado`);
      return res.status(404).json({ error: 'Trade nao encontrado ou nao reconciliado' });
    }

    if (brokerClosedAt && Number.isFinite(brokerClosedAt)) {
      closed.closedAt = brokerClosedAt;
      if (tradeStore.editTrade) {
          tradeStore.editTrade(tradeId, { closedAt: brokerClosedAt });
        }
      }

    const successMsg = `Bot resultado: ${tradeId} fechado ${resolvedOutcome} @ ${closePrice} (broker verified)`;
    logger.info(successMsg);
    return res.json({
      success: true,
      tradeId,
      outcome: resolvedOutcome,
      closePrice: parseFloat(closePrice),
      closedAt: closed.closedAt,
      mt5VerifiedClose: true,
    });
  });

  // -- GET /scan
  router.get('/scan', rateLimit, requireVipAccess, async (req, res) => {
    const entryTf = (req.query.entryTf || '15m').toLowerCase();
    const biasTf  = (req.query.biasTf  || '1h').toLowerCase();
    if (!VALID_TFS.includes(entryTf)) return res.status(400).json({ success: false, error: 'entryTf invalido' });
    if (!VALID_TFS.includes(biasTf))  return res.status(400).json({ success: false, error: 'biasTf invalido' });

    const results = {};
    await Promise.all(Object.keys(ASSETS).map(async (key) => {
      try {
        const sig = await computeVipSignal(key, entryTf, biasTf, { skipPersist: true });
        _signalCache[`${key}:${entryTf}:${biasTf}`] = { data: sig, cachedAt: Date.now() };
        results[key] = {
          asset:     key,
          name:      ASSETS[key].name,
          status:    sig.status,
          direction: sig.direction,
          score:     sig.score,
          maxScore:  sig.maxScore,
          adx:       sig.meta?.adx,
          session:   sig.meta?.session,
          price:     sig.meta?.price,
          levels:    sig.levels,
          operationalContext: sig.operationalContext || null,
        };
      } catch (e) {
        results[key] = { asset: key, name: ASSETS[key].name, status: 'ERROR', score: 0, error: e.message };
      }
    }));
    res.json({ success: true, entryTf, biasTf, scannedAt: Date.now(), results });
  });

  return router;
}

module.exports = { createVipRouter };
