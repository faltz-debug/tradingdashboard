'use strict';

/**
 * src/ws/server.js
 *
 * Camada isolada do WebSocket /ws do dashboard.
 *
 * Extraido de src/scheduler.js para que (a) o handshake do WSS,
 * (b) a auth opcional na conexao, (c) a montagem do snapshot consolidado
 * e (d) o broadcast com proteção contra push concorrente fiquem num
 * modulo unico, testavel sem o resto da camada de timers.
 *
 * ── AUTH WS (opcional) ──────────────────────────────────────────────────
 * Quando `WS_REQUIRE_AUTH=true` (padrao false — back-compat), a conexao
 * exige token valido. Token aceito via:
 *   - querystring:  ws://host/ws?token=XYZ
 *   - header HTTP:  Authorization: Bearer XYZ  (durante o upgrade)
 * Validacao na ordem:
 *   1) VIP_TOKEN (legacy estatico do .env)
 *   2) authStore.getUserBySessionToken(token)  — sessao ativa
 * Conexao sem token valido eh fechada com codigo 4401 (custom: unauthorized).
 *
 * ── PUSH CONCORRENTE ────────────────────────────────────────────────────
 * Como `buildSnapshot` faz I/O (getAsset = fetch + cache + indicadores),
 * dois pushes simultaneos podem disputar e desperdicar quota das fontes.
 * `_pushInFlight` serializa: o segundo push concorrente vira no-op.
 *
 * @module ws/server
 */

const WebSocket = require('ws');
const url       = require('url');

// ── Config (env) ────────────────────────────────────────────────────────────
const WS_REQUIRE_AUTH = process.env.WS_REQUIRE_AUTH === 'true';
const VIP_TOKEN       = process.env.VIP_TOKEN || '';

// ── Estado interno ──────────────────────────────────────────────────────────
let _ctx          = null;
let _wss          = null;
let _intervalId   = null;
let _pushInFlight = false;

// ──────────────────────────────────────────────────────────────────────────
// Auth helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Extrai o token da requisicao de upgrade.
 * Ordem: querystring `?token=` → header `Authorization: Bearer …`.
 * @param {import('http').IncomingMessage} req
 * @returns {string} token ou ''
 */
function _extractTokenFromRequest(req) {
  try {
    const parsed = url.parse(req.url || '', true);
    const qToken = typeof parsed.query?.token === 'string' ? parsed.query.token.trim() : '';
    if (qToken) return qToken;
  } catch (_) { /* parse falha → segue p/ header */ }

  const auth = req.headers['authorization'] || '';
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();

  return '';
}

/**
 * Valida o token contra VIP_TOKEN ou sessao ativa do authStore.
 * @param {string} token
 * @param {object} authStore  modulo authStore (pode ser null em testes)
 * @returns {{ type:string, user:object }|null}
 */
function _verifyToken(token, authStore) {
  if (!token) return null;

  if (VIP_TOKEN && token === VIP_TOKEN) {
    return {
      type: 'legacy_token',
      user: { id: 'legacy-vip-token', email: 'legacy-token@local', role: 'subscriber' },
    };
  }

  try {
    const user = authStore?.getUserBySessionToken?.(token);
    if (user) return { type: 'session', user };
  } catch (_) { /* authStore offline → trata como invalido */ }

  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Snapshot + push
// ──────────────────────────────────────────────────────────────────────────

/**
 * Monta o snapshot consolidado dos ativos (xau/btc/eur/jpy).
 * Tirado tal-qual de scheduler.js — formato preservado para o dashboard.
 */
async function buildSnapshot() {
  if (!_ctx) throw new Error('ws/server nao iniciado — chame start(ctx) primeiro');
  const { getAsset } = _ctx;
  const [xau, btc, eur, jpy] = await Promise.all([
    getAsset('xauusd'),
    getAsset('btc'),
    getAsset('eurusd'),
    getAsset('usdjpy'),
  ]);
  return {
    type: 'dashboard_snapshot',
    generatedAt: Date.now(),
    assets: { xau, btc, eur, jpy },
  };
}

/**
 * Faz broadcast do snapshot para todos os clients OPEN.
 * Protegido contra push concorrente (no-op se ja em andamento).
 */
async function pushSnapshot() {
  if (!_wss || !_ctx) return;
  const { logger } = _ctx;
  if (_pushInFlight) return;

  const clients = [..._wss.clients].filter(c => c.readyState === WebSocket.OPEN);
  if (!clients.length) return;

  _pushInFlight = true;
  try {
    const payload = JSON.stringify(await buildSnapshot());
    for (const client of clients) {
      try { client.send(payload); } catch (_) { /* socket fechou no meio */ }
    }
  } catch (err) {
    logger.warn('Dashboard WS push:', err.message);
  } finally {
    _pushInFlight = false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────────

/**
 * Sobe o WSS /ws sobre o http.Server passado e dispara o intervalo de push.
 *
 * @param {object} ctx
 * @param {import('http').Server} ctx.server     http.Server compartilhado com Express
 * @param {Function} ctx.getAsset                resolver async de candles+price por chave
 * @param {object}   ctx.logger                  logger.info/warn/error
 * @param {object}   [ctx.authStore]             modulo authStore — opcional (usado se WS_REQUIRE_AUTH)
 * @param {object}   ctx.config
 * @param {number}   ctx.config.DASHBOARD_PUSH_MS  intervalo de push em ms
 * @returns {WebSocket.Server}
 */
function start(ctx) {
  if (_wss) {
    (ctx?.logger || console).warn('ws/server.start chamado mais de uma vez — ignorando');
    return _wss;
  }
  _ctx = ctx;
  const { server, logger, config, authStore } = ctx;
  const { DASHBOARD_PUSH_MS } = config;

  _wss = new WebSocket.Server({ server, path: '/ws' });

  _wss.on('connection', async (socket, req) => {
    // ── Auth na conexao (opcional) ──────────────────────────────────────
    if (WS_REQUIRE_AUTH) {
      const token = _extractTokenFromRequest(req);
      const auth  = _verifyToken(token, authStore);
      if (!auth) {
        const ip = req.socket?.remoteAddress || 'unknown';
        try { socket.close(4401, 'unauthorized'); } catch (_) {}
        logger.warn(`WS unauthorized close: ${ip}`);
        return;
      }
      socket.auth = auth; // disponivel p/ futuras checagens por mensagem
    }

    // Snapshot inicial — preserva contrato com dashboard.html
    try {
      socket.send(JSON.stringify(await buildSnapshot()));
    } catch (err) {
      logger.warn('Dashboard WS init:', err.message);
    }

    socket.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === 'dashboard_ping') {
          socket.send(JSON.stringify({ type: 'dashboard_pong', ts: Date.now() }));
        } else if (msg?.type === 'dashboard_refresh') {
          socket.send(JSON.stringify(await buildSnapshot()));
        }
      } catch (_) {
        // ignora mensagens invalidas
      }
    });
  });

  _intervalId = setInterval(pushSnapshot, DASHBOARD_PUSH_MS);

  logger.info(`WSS /ws iniciado (auth=${WS_REQUIRE_AUTH ? 'REQUIRED' : 'opcional'}, push=${DASHBOARD_PUSH_MS}ms)`);
  return _wss;
}

/**
 * Para o intervalo de push e fecha o WSS (uso em testes / shutdown).
 */
function stop() {
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
  if (_wss) {
    try { _wss.close(); } catch (_) {}
    _wss = null;
  }
  _ctx          = null;
  _pushInFlight = false;
}

// ── Helpers de teste / observabilidade ──────────────────────────────────────
function getWss()         { return _wss; }
function getClientCount() { return _wss ? _wss.clients.size : 0; }

module.exports = {
  // Lifecycle
  start,
  stop,
  // Snapshot
  buildSnapshot,
  pushSnapshot,
  // Observabilidade / testes
  getWss,
  getClientCount,
  WS_REQUIRE_AUTH,
  // Internals expostos para testes (prefixo _ sinaliza nao-publico)
  _extractTokenFromRequest,
  _verifyToken,
};
