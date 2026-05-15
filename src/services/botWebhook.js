'use strict';

/**
 * src/services/botWebhook.js
 *
 * Camada isolada para o webhook do bot MT5 (auto-open de posicoes).
 *
 * Extraido de src/services/alerts.js para que (a) a logica de risk-tier por
 * score, (b) o transporte HTTP via axios, (c) a atualizacao do trade com o
 * ticket MT5 e (d) a IDEMPOTENCIA fiquem num modulo unico, testavel sem o
 * resto da camada de alertas.
 *
 * IDEMPOTENCIA:
 * Chamadas com o mesmo `trade.id` dentro de uma janela de 24h sao deduzidas.
 * Estrategia: marcar PREEMPTIVAMENTE no cache antes do POST. Se o POST falhar
 * por excecao (rede caiu), removemos do cache pra permitir retry.
 *
 * @module services/botWebhook
 */

const axios      = require('axios');
const tradeStore = require('../../tradeStore');
const logger     = require('../../logger');
const { ASSETS } = require('./state');

// -- Config (env) ------------------------------------------------------------
const BOT_WEBHOOK_ENABLED       = process.env.BOT_WEBHOOK_ENABLED === 'true';
const BOT_WEBHOOK_URL           = process.env.BOT_WEBHOOK_URL || 'http://localhost:5000/webhook/signal';
const BOT_WEBHOOK_TOKEN         = process.env.BOT_WEBHOOK_TOKEN || '';
const AUTO_OPEN_SCORE_THRESHOLD = parseFloat(process.env.AUTO_OPEN_SCORE_THRESHOLD || '7.0');
const WEBHOOK_TIMEOUT_MS        = parseInt(process.env.BOT_WEBHOOK_TIMEOUT_MS || '8000', 10);

// -- Idempotency cache -------------------------------------------------------
// Map<tradeId, { sentAt, status, ticket?, reason? }>
const _idempotencyCache = new Map();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function _purgeIdempotency() {
  const now = Date.now();
  for (const [k, v] of _idempotencyCache.entries()) {
    if (now - v.sentAt > IDEMPOTENCY_TTL_MS) _idempotencyCache.delete(k);
  }
}

// -- Risk tier por score (proporcional ao threshold de auto-open) ------------
function _resolveRiskTier(score) {
  const thr = AUTO_OPEN_SCORE_THRESHOLD;
  if (score >= thr * 1.85) return '1.00';
  if (score >= thr * 1.30) return '0.75';
  return '0.50';
}

// ---------------------------------------------------------------------------
// callBotWebhook -- POST autenticado para o bot MT5 com idempotencia
//
// @param {object} trade  -- objeto persistido pelo tradeStore.openTrade
// @returns {Promise<object>} resultado:
//   - { skipped: true, reason: 'webhook_disabled' }            -- flag off
//   - { skipped: true, reason: 'duplicate', priorStatus, ... } -- dedup hit
//   - { ok: true,  ticket, size }                              -- bot abriu
//   - { ok: false, rejected: true, reason }                    -- bot rejeitou
// Lanca excecao em caso de erro de rede / timeout (caller deve tratar).
// ---------------------------------------------------------------------------
async function callBotWebhook(trade) {
  if (!BOT_WEBHOOK_ENABLED || !BOT_WEBHOOK_URL) {
    return { skipped: true, reason: 'webhook_disabled' };
  }

  const idempKey = trade?.id;
  if (!idempKey) {
    logger.warn('Bot webhook chamado sem trade.id -- idempotency desativada para esta chamada');
  } else {
    _purgeIdempotency();
    const prior = _idempotencyCache.get(idempKey);
    if (prior) {
      logger.info(`Bot webhook deduped: trade ${idempKey} ja enviado em ${new Date(prior.sentAt).toISOString()} (status=${prior.status})`);
      return {
        skipped:      true,
        reason:       'duplicate',
        priorStatus:  prior.status,
        priorSentAt:  prior.sentAt,
        priorTicket:  prior.ticket || null,
      };
    }
  }

  const score    = trade.score || 0;
  const riskTier = _resolveRiskTier(score);

  // Resolve o simbolo MT5 correto (ex: 'btc' -> 'BTCUSD', 'xauusd' -> 'XAUUSD')
  const mt5Symbol = ASSETS[trade.asset]?.name || (trade.asset || '').toUpperCase();

  const payload = {
    asset:       mt5Symbol,
    direction:   trade.direction,        // 'BUY' | 'SELL'
    entry:       trade.entry,
    sl:          trade.sl,
    tp:          trade.tp,
    score,
    riskPercent: parseFloat(riskTier),
    tradeId:     trade.id,
    autoOpen:    true,
    timestamp:   new Date().toISOString(),
  };

  logger.info(`Bot webhook -> ${mt5Symbol} ${payload.direction} score=${score} risk=${riskTier}%`);

  const headers = { 'Content-Type': 'application/json' };
  if (BOT_WEBHOOK_TOKEN) headers['x-webhook-token']    = BOT_WEBHOOK_TOKEN;
  if (idempKey)          headers['x-idempotency-key'] = idempKey;

  // Marca preemptivamente para evitar race de chamadas concorrentes.
  if (idempKey) _idempotencyCache.set(idempKey, { sentAt: Date.now(), status: 'pending' });

  try {
    const resp = await axios.post(BOT_WEBHOOK_URL, payload, { headers, timeout: WEBHOOK_TIMEOUT_MS });

    if (resp.data?.ok) {
      const ticket = resp.data.ticket;
      const size   = resp.data.size;
      logger.info(`Bot abriu posicao MT5: ticket=${ticket} size=${size}lots`);
      if (ticket) {
        try {
          tradeStore.updateTrade(trade.id, { mt5Ticket: ticket, mt5Size: size });
        } catch (_) { /* nao critico */ }
      }
      if (idempKey) _idempotencyCache.set(idempKey, { sentAt: Date.now(), status: 'opened', ticket });
      return { ok: true, ticket, size };
    } else {
      const reason = resp.data?.reason || resp.data?.error || 'motivo desconhecido';
      logger.warn(`Bot webhook respondeu sem abrir: ${reason}`);
      // Mantemos no cache: chamadas repetidas seriam rejeitadas igual.
      if (idempKey) _idempotencyCache.set(idempKey, { sentAt: Date.now(), status: 'rejected', reason });
      return { ok: false, rejected: true, reason };
    }
  } catch (err) {
    // Se o bot retornou 4xx = rejeicao de negocio (No money, invalid lot, etc.)
    // MANTEMOS no cache para nao retentar o mesmo trade no proximo ciclo.
    if (err.response) {
      const status = err.response.status;
      const body   = err.response.data;
      const errMsg = body?.error || body?.reason || JSON.stringify(body);
      logger.warn(`Bot webhook ${status}: ${errMsg}`);
      if (idempKey) {
        // 4xx = rejeicao permanente → fica no cache por 24h
        // 5xx = erro interno do bot  → remove para permitir retry
        if (status >= 400 && status < 500) {
          _idempotencyCache.set(idempKey, { sentAt: Date.now(), status: 'rejected_broker', reason: errMsg });
        } else {
          _idempotencyCache.delete(idempKey);
        }
      }
      return { ok: false, rejected: true, reason: errMsg, httpStatus: status };
    }
    // Falha de rede / timeout: remove do cache pra permitir retry manual.
    if (idempKey) _idempotencyCache.delete(idempKey);
    throw err;
  }
}

// -- Helpers de teste / observabilidade -------------------------------------
function _getIdempotencyCacheSize() { return _idempotencyCache.size; }
function _hasIdempotencyKey(key)    { return _idempotencyCache.has(key); }
function _clearIdempotencyCache()   { _idempotencyCache.clear(); }

module.exports = {
  callBotWebhook,
  // (somente leitura -- uteis em testes / observabilidade)
  AUTO_OPEN_SCORE_THRESHOLD,
  IDEMPOTENCY_TTL_MS,
  _getIdempotencyCacheSize,
  _hasIdempotencyKey,
  _clearIdempotencyCache,
};
