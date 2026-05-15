'use strict';

const axios = require('axios');

/**
 * src/scheduler.js
 *
 * Camada de orquestracao em tempo real (timers + boot do WebSocket).
 *
 * Responsabilidades:
 *   - Loop principal de alertas / scan VIP / auto-trade (ALERT_INTERVAL_MS)
 *   - Job horario do relatorio semanal (segunda-feira >= 08:00 UTC)
 *   - Polling de fontes de mercado (Kraken / OANDA / Finnhub)
 *   - Boot do WebSocket /ws (delegado para src/ws/server.js)
 *
 * Estado mutavel mantido aqui (fora do server.js):
 *   - autoTradeState.enabled        (toggle runtime via /api/admin/auto-trade)
 *   - autoTradeState.lastAt         ({ [asset]: timestamp } — cooldown auto-trade)
 *   - lastWeeklyReportDay           (impede envio duplicado no mesmo dia)
 *
 * Estado do WSS (clients, push concorrente, auth) vive em src/ws/server.js.
 *
 * Padrao de injecao: igual ao usado em signals.js e alerts.js — start(ctx) recebe
 * todas as dependencias (services + config) para evitar circular requires.
 */

const wsServer = require('./ws/server');
const { buildVipTelegramMessage } = require('./services/telegram');
const { getPreferredMt5Snapshot } = require('./services/dataSources');
const { getCurrentSessions } = require('./services/context');

let _ctx = null;
let _started = false;

const mt5ReconcileState = new Map();
const BOT_STATUS_URL = process.env.BOT_STATUS_URL || 'http://localhost:5000/status';
const BOT_WEBHOOK_TOKEN = process.env.BOT_WEBHOOK_TOKEN || '';
const MT5_RECONCILE_CONFIRM_MS = parseInt(process.env.MT5_RECONCILE_CONFIRM_MS || '120000', 10);
const MT5_RECONCILE_CONFIRM_CYCLES = parseInt(process.env.MT5_RECONCILE_CONFIRM_CYCLES || '3', 10);
// Após este tempo sem encontrar o deal, fecha com preço do snapshot MT5 como fallback
const MT5_RECONCILE_DEAL_TIMEOUT_MS = parseInt(process.env.MT5_RECONCILE_DEAL_TIMEOUT_MS || String(15 * 60 * 1000), 10);
const BOT_BASE_URL = BOT_STATUS_URL.replace(/\/status\/?$/i, '');
const AUTO_TRADE_RISK_FILTER_ENABLED = process.env.AUTO_TRADE_RISK_FILTER_ENABLED === 'true'; // desligado por padrão
const AUTO_TRADE_RISK_NOTIFY_COOLDOWN_MS = parseInt(process.env.AUTO_TRADE_RISK_NOTIFY_COOLDOWN_MS || String(30 * 60 * 1000), 10);

// Inicializa auto-trade a partir do .env (AUTO_TRADE_MODE=true liga na startup,
// evitando que o bot fique desligado silenciosamente apos cada restart do servidor)
const autoTradeState    = { enabled: process.env.AUTO_TRADE_MODE === 'true', lastAt: {} };
const pyramidState      = { enabled: process.env.AUTO_TRADE_PYRAMID === 'true' };  // permite ate N trades por ativo
const trailingStopState = { enabled: false };  // trailing ATR — desligado por padrao
const autoTradeRiskFilterState = { enabled: AUTO_TRADE_RISK_FILTER_ENABLED };
const sessionBlockOverrideState = { enabled: false }; // quando true, ignora bloqueio de NY puro / sem sessão
const autoTradeRiskState = { paused: false, level: 'NORMAL', reason: 'condicoes normais', lastNotifiedAt: 0 };
let lastWeeklyReportDay = null;

const _intervals = [];

function _normalizeMt5Symbol(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function _assetFromMt5Symbol(symbol, ASSETS) {
  const normalized = _normalizeMt5Symbol(symbol);
  const found = Object.entries(ASSETS || {}).find(([key, cfg]) =>
    _normalizeMt5Symbol(cfg?.name || key) === normalized
  );
  return found?.[0] || normalized;
}

function _toFinitePrice(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

async function _resolveFallbackClosePrice(trade, snapshot, ASSETS, getAsset) {
  const assetKey = trade.asset || _assetFromMt5Symbol(trade.symbol, ASSETS);
  const asset = snapshot?.assets?.[assetKey];
  const bid = _toFinitePrice(asset?.bid);
  const ask = _toFinitePrice(asset?.ask);
  const live = _toFinitePrice(asset?.price);

  if (trade.direction === 'BUY') {
    if (bid != null) return bid;
  } else if (trade.direction === 'SELL') {
    if (ask != null) return ask;
  }

  if (live != null) return live;

  if (typeof getAsset === 'function') {
    try {
      const marketData = await getAsset(assetKey);
      const altBid = _toFinitePrice(marketData?.bid ?? marketData?.live?.bid ?? marketData?.tick?.bid);
      const altAsk = _toFinitePrice(marketData?.ask ?? marketData?.live?.ask ?? marketData?.tick?.ask);
      const altLive = _toFinitePrice(marketData?.price ?? marketData?.live?.price);
      if (trade.direction === 'BUY' && altBid != null) return altBid;
      if (trade.direction === 'SELL' && altAsk != null) return altAsk;
      if (altLive != null) return altLive;
    } catch (_) {
      // Sem preço alternativo, deixa para o próximo ciclo.
    }
  }

  const existingClose = _toFinitePrice(trade.closePrice);
  if (existingClose != null) return existingClose;
  return null;
}

async function _fetchBotStatus() {
  const headers = {};
  if (BOT_WEBHOOK_TOKEN) headers['x-webhook-token'] = BOT_WEBHOOK_TOKEN;
  const resp = await axios.get(BOT_STATUS_URL, { headers, timeout: 5000 });
  return resp.data || null;
}

async function _fetchBotCloseDeal(ticket) {
  if (!ticket) return null;
  const headers = {};
  if (BOT_WEBHOOK_TOKEN) headers['x-webhook-token'] = BOT_WEBHOOK_TOKEN;
  const url = `${BOT_BASE_URL}/position-close/${encodeURIComponent(ticket)}`;
  const resp = await axios.get(url, {
    headers,
    timeout: 5000,
    validateStatus: () => true,
  });
  if (resp.status !== 200 || !resp.data?.found) return null;
  return resp.data;
}

async function _reconcileMt5ClosedTrades() {
  const { ASSETS, tradeStore, logger, getAsset } = _ctx || {};
  if (!tradeStore?.listTrades || !tradeStore?.closeTrade) return;

  let botStatus;
  try {
    botStatus = await _fetchBotStatus();
  } catch (err) {
    logger?.warn?.(`MT5 reconcile: bot status indisponivel (${err.message})`);
    return;
  }

  const botPositions = Array.isArray(botStatus?.positions) ? botStatus.positions : null;
  if (botStatus?.bot_status !== 'OK' || !botPositions) return;

  let snapshot;
  try {
    snapshot = getPreferredMt5Snapshot()?.snapshot;
  } catch (err) {
    logger?.warn?.(`MT5 reconcile: feed indisponivel (${err.message})`);
    return;
  }

  const openTickets = new Set(botPositions.map(p => String(p.ticket)).filter(Boolean));
  const openTrades = tradeStore.listTrades({ status: 'open', limit: 500 });
  const now = Date.now();

  for (const trade of openTrades) {
    if (!trade.mt5Ticket) continue;
    const ticketKey = String(trade.mt5Ticket);
    if (openTickets.has(ticketKey)) {
      mt5ReconcileState.delete(ticketKey);
      continue;
    }
    if (now - (trade.openedAt || 0) < 60 * 1000) continue;

    const prior = mt5ReconcileState.get(ticketKey) || { count: 0, firstMissingAt: now };
    prior.count += 1;
    prior.lastMissingAt = now;
    mt5ReconcileState.set(ticketKey, prior);
    if (prior.count < MT5_RECONCILE_CONFIRM_CYCLES) continue;
    if ((now - prior.firstMissingAt) < MT5_RECONCILE_CONFIRM_MS) continue;

    const closeDeal = await _fetchBotCloseDeal(trade.mt5Ticket);
    // FIX: Python /position-close retorna { found, deal: { price, reason, time, ... } }
    // closeDeal?.closePrice não existe — o preço real está em closeDeal?.deal?.price
    const closePrice = _toFinitePrice(closeDeal?.deal?.price ?? closeDeal?.closePrice);
    if (closePrice == null) {
      // Registra quando começamos a não encontrar o deal
      if (!prior.dealNotFoundAt) {
        prior.dealNotFoundAt = now;
        mt5ReconcileState.set(ticketKey, prior);
      }

      const waitingMs = now - prior.dealNotFoundAt;

      if (waitingMs < MT5_RECONCILE_DEAL_TIMEOUT_MS) {
        const waitingMin = Math.floor(waitingMs / 60000);
        logger?.info?.(
          `MT5 reconcile aguardando deal real: ${String(trade.asset).toUpperCase()} ` +
          `${trade.direction} ticket=${trade.mt5Ticket} (${waitingMin}min / ` +
          `${Math.floor(MT5_RECONCILE_DEAL_TIMEOUT_MS / 60000)}min timeout)`
        );
        continue;
      }

      // Timeout atingido — usa preço do snapshot como fallback
      logger?.warn?.(
        `MT5 reconcile timeout aguardando deal (${Math.floor(MT5_RECONCILE_DEAL_TIMEOUT_MS / 60000)}min): ` +
        `${String(trade.asset).toUpperCase()} ${trade.direction} ticket=${trade.mt5Ticket} — usando preço fallback`
      );

      const fallbackPrice = await _resolveFallbackClosePrice(trade, snapshot, ASSETS, _ctx?.getAsset);
      if (fallbackPrice == null) {
        logger?.warn?.(
          `MT5 reconcile sem preço fallback disponível para ${String(trade.asset).toUpperCase()} ` +
          `ticket=${trade.mt5Ticket} — aguardando próximo ciclo`
        );
        continue;
      }

      // Fecha com preço fallback (snapshot MT5 / bid/ask ao vivo)
      let closed = tradeStore.closeTrade(trade.id, {
        closePrice: fallbackPrice,
        outcome: 'MT5_CLOSED',
        closedAt: undefined,
        mt5VerifiedClose: false,
        managedByMt5: true,
      });
      if (closed) {
        if (tradeStore.editTrade) {
          closed = tradeStore.editTrade(trade.id, {
            closePrice: fallbackPrice,
            outcome: 'MT5_CLOSED',
            mt5VerifiedClose: false,
            managedByMt5: true,
          }) || closed;
        }
        mt5ReconcileState.delete(ticketKey);
        logger?.warn?.(
          `MT5 reconcile fechou (FALLBACK) ticket=${trade.mt5Ticket} ` +
          `${String(trade.asset).toUpperCase()} ${trade.direction} @ ${fallbackPrice} (sem deal confirmado)`
        );
      }
      continue;
    }

    // FIX: derivar outcome do deal.reason (3=TP, 4=SL, outros=MT5_CLOSED)
    const _dealReason  = closeDeal?.deal?.reason;
    const _outcome     = _dealReason === 3 ? 'TP'
                       : _dealReason === 4 ? 'SL'
                       : (closeDeal?.outcome || 'MT5_CLOSED');
    // FIX: closedAt vem de deal.time (ISO string UTC sem 'Z')
    const _dealTimeIso = closeDeal?.deal?.time;
    const _closedAtMs  = _dealTimeIso
      ? new Date(_dealTimeIso.endsWith('Z') ? _dealTimeIso : _dealTimeIso + 'Z').getTime()
      : (closeDeal?.closedAt ? Number(closeDeal.closedAt) : null);

    let closed = tradeStore.closeTrade(trade.id, {
      closePrice,
      outcome: _outcome,
      closedAt: _closedAtMs || undefined,
      mt5VerifiedClose: true,
      managedByMt5: true,
    });
    if (closed) {
      if (tradeStore.editTrade && Number.isFinite(_closedAtMs)) {
        closed = tradeStore.editTrade(trade.id, {
          closePrice,
          outcome: _outcome,
          closedAt: _closedAtMs,
          mt5VerifiedClose: true,
          managedByMt5: true,
        }) || closed;
      }
      mt5ReconcileState.delete(ticketKey);
      logger?.info?.(
        `MT5 reconcile fechou trade ausente: ${String(trade.asset).toUpperCase()} ` +
        `${trade.direction} ticket=${trade.mt5Ticket} @ ${closePrice}`
      );
    }
  }
}

// ------------------------------------------------------------------------------
// _reconcileNewMt5Positions — importa posicoes MT5 que nao estao no DB
// Cenario: servidor reiniciou, callBotWebhook retornou ok mas markWebhookSent
// nao foi gravado, ou trade foi deletado incorretamente. O bot abriu a posicao
// no MT5 mas o dashboard perdeu o rastro.
// Executa junto com _reconcileMt5ClosedTrades a cada ciclo do scheduler.
// ------------------------------------------------------------------------------
async function _reconcileNewMt5Positions() {
  const { ASSETS, tradeStore, logger } = _ctx || {};
  if (!tradeStore?.listTrades || !tradeStore?.openTrade || !tradeStore?.updateTrade) return;

  let botStatus;
  try {
    botStatus = await _fetchBotStatus();
  } catch (err) { return; }

  const botPositions = Array.isArray(botStatus?.positions) ? botStatus.positions : null;
  if (botStatus?.bot_status !== 'OK' || !botPositions || botPositions.length === 0) return;

  // Mapa de tickets ja conhecidos no DB (abertos)
  const openTrades = tradeStore.listTrades({ status: 'open', limit: 500, includePending: true });
  const knownTickets = new Set(
    openTrades.map(t => String(t.mt5Ticket)).filter(Boolean)
  );

  for (const pos of botPositions) {
    const ticket = String(pos.ticket || '');
    if (!ticket || knownTickets.has(ticket)) continue;

    // Posicao MT5 sem entrada no DB — importa como trade rastreado
    const assetKey = Object.keys(ASSETS || {}).find(k =>
      (ASSETS[k].name || '').toUpperCase() === (pos.symbol || '').toUpperCase()
    ) || (pos.symbol || '').toLowerCase().replace('usd','').replace('xau','xauusd').replace('btcusd','btc');

    const direction = (pos.type === 'buy' || pos.type === 0) ? 'BUY' : 'SELL';
    const entry     = parseFloat(pos.price_open || pos.entry || 0);
    const sl        = parseFloat(pos.sl || 0);
    const tp        = parseFloat(pos.tp || 0);
    const openedAt  = pos.time ? (pos.time * 1000) : Date.now();

    if (!entry || !assetKey) continue;

    try {
      const trade = tradeStore.openTrade({
        asset:        assetKey,
        direction,
        entry,
        sl,
        tp,
        atr:          0,
        rr:           sl && tp && entry ? Math.abs(tp - entry) / Math.abs(entry - sl) : 2,
        score:        0,
        managedByMt5: true,
        source:       'mt5_reconcile',
        reason:       `Importado pelo reconcile — ticket ${ticket} ja estava aberto no MT5`,
        openedAt,
      });

      if (trade && !trade._deduplicated) {
        // Marca como confirmado e associa o ticket
        if (tradeStore.markWebhookSent) tradeStore.markWebhookSent(trade.id);
        tradeStore.updateTrade(trade.id, { mt5Ticket: parseInt(ticket), mt5Size: pos.volume });
        logger?.info?.(
          `MT5 reconcile importou posicao orfã: ${(pos.symbol || '').toUpperCase()} ` +
          `${direction} ticket=${ticket} entry=${entry}`
        );
      }
    } catch (err) {
      logger?.warn?.(`MT5 reconcile erro ao importar ticket ${ticket}: ${err.message}`);
    }
  }
}

// ------------------------------------------------------------------------------
// API publica de estado (consumida pelas rotas admin em server.js)
// ------------------------------------------------------------------------------

function setAutoTradeEnabled(value) {
  autoTradeState.enabled = !!value;
}

function getAutoTradeEnabled() {
  return autoTradeState.enabled;
}

function getAutoTradeLastAt() {
  return autoTradeState.lastAt;
}

function getAutoTradeRiskState() {
  return { ...autoTradeRiskState, enabled: !!autoTradeRiskFilterState.enabled };
}

function setAutoTradeRiskFilterEnabled(value) {
  autoTradeRiskFilterState.enabled = !!value;
}

function setPyramidEnabled(value) {
  pyramidState.enabled = !!value;
}

function getPyramidEnabled() {
  return pyramidState.enabled;
}

function setTrailingStopEnabled(value) {
  trailingStopState.enabled = !!value;
  // Sincroniza com alerts.js (que aplica o flag em checkOpenTradesForExit)
  try { require('./services/alerts').setTrailingStopEnabled(value); } catch (_) {}
}

function setSessionBlockOverride(value) {
  sessionBlockOverrideState.enabled = !!value;
  // Propaga para filters.js: desativa/ativa isHourBlocked() também
  // Assim o scanner mostra sinais reais em vez de HARD_BLOCK_HOUR
  try { require('./services/filters').setHourBlockOverride(value); } catch (_) {}
  // Invalida imediatamente o cache de sinais VIP (_signalCache em signals.js).
  // Sem isso, o scanner continua exibindo HARD_BLOCK_HOUR até o próximo ciclo
  // do scheduler (pode levar minutos). Ao limpar, a próxima requisição à rota
  // /api/vip/signal (ou o próximo push WS via attachSignals) força recálculo
  // com isHourBlocked() = false — mostrando o sinal real imediatamente.
  try {
    const { _signalCache } = require('./services/signals');
    if (_signalCache && typeof _signalCache === 'object') {
      for (const k of Object.keys(_signalCache)) delete _signalCache[k];
    }
  } catch (_) {}
}

function getSessionBlockOverride() {
  return sessionBlockOverrideState.enabled;
}

function getTrailingStopEnabled() {
  return trailingStopState.enabled;
}

// ------------------------------------------------------------------------------
// Snapshot do dashboard — re-exportado de src/ws/server para back-compat.
// (Modulos antigos importavam estas funcoes diretamente de scheduler.)
// ------------------------------------------------------------------------------

async function buildDashboardSnapshot() { return wsServer.buildSnapshot(); }
async function pushDashboardSnapshot()  { return wsServer.pushSnapshot();  }

// ------------------------------------------------------------------------------
// Jobs internos
// ------------------------------------------------------------------------------

function _scheduleWeeklyReport() {
  const { sendWeeklyReport, logger } = _ctx;

  const id = setInterval(async () => {
    try {
      const now      = new Date();
      const day      = now.getUTCDay();    // 1 = segunda
      const hour     = now.getUTCHours();
      const todayStr = now.toISOString().slice(0, 10);

      if (day === 1 && hour >= 8 && lastWeeklyReportDay !== todayStr) {
        lastWeeklyReportDay = todayStr;
        await sendWeeklyReport();
      }
    } catch (e) {
      logger.warn('Erro no job de relatorio semanal:', e.message);
    }
  }, 60 * 60 * 1000); // 1h

  _intervals.push(id);
}

function _scheduleAlertScan() {
  const {
    ASSETS,
    getAsset,
    checkAndSendAlerts,
    checkOpenTradesForExit,
    attachSignals,
    tradeStore,
    computeVipSignal,
    _signalCache,
    callBotWebhook,
    sendTelegram,
    logger,
    config,
  } = _ctx;

  const {
    ALERT_INTERVAL_MS,
    BOT_WEBHOOK_ENABLED,
    AUTO_OPEN_SCORE_THRESHOLD,
    AUTO_TRADE_COOLDOWN_MS,
    AUTO_TRADE_MAX_PER_ASSET,
    AUTO_TRADE_PYRAMID_COOLDOWN_MS,
  } = config;

  // Cooldown para logs/Telegram de "bloqueado por trade aberto"
  // Evita spam: só notifica uma vez a cada 30 minutos por ativo
  const BLOCK_LOG_COOLDOWN_MS = 30 * 60 * 1000;
  const _lastBlockLog = {};

  const id = setInterval(async () => {
    await _reconcileMt5ClosedTrades();
    await _reconcileNewMt5Positions();

    for (const key of Object.keys(ASSETS)) {
      try {
        const data = await getAsset(key);
        await checkAndSendAlerts(key, data);

        // Atualiza sinais no cache para que o push WebSocket sempre inclua signals
        if (!data.isSimulation && !data.isMarketClosed && data['15m']?.length) {
          if (typeof attachSignals === 'function') attachSignals(data, key);
        }

        if (!data.isSimulation && !data.isMarketClosed) {
          await checkOpenTradesForExit(key, data);
        }

        if (data['15m']?.length) {
          tradeStore.evaluateLiveSignals({ asset: key, candles: data['15m'], tf: '15m', horizonCandles: 4 });
        }

        if (!data.isSimulation && !data.isMarketClosed) {
          try {
            const sig = await computeVipSignal(key, '15m', '1h', { skipPersist: false });
            // Pre-aquece o cache da rota /api/vip/signal para troca de ativo instantanea
            _signalCache[`${key}:15m:1h`] = { data: sig, cachedAt: Date.now() };

            // -- AUTO-TRADE: abre posicao automaticamente se ligado e score >= threshold --

            // ── FILTRO DE SESSÃO ──────────────────────────────────────────────
            // Bloqueia entradas em NY puro (16:00–21:00 UTC) e Sem sessão (21:00–00:00 UTC).
            // Estas janelas têm WR histórico de 18% e 17% respectivamente — sem edge confirmado.
            // London (07–16 UTC) ou Tokyo (00–09 UTC) ou Overlap (13–16 UTC) têm que estar activos.
            // Decisão tomada em 06/05/2026 com base em 117 trades MT5 confirmados.
            const _sess          = getCurrentSessions();
            const _isNyPure      = _sess.ny && !_sess.london && !_sess.overlap && !_sess.tokyo;
            const _isNoSession   = !_sess.ny && !_sess.london && !_sess.overlap && !_sess.tokyo;
            // Override manual desativa o filtro de sessão temporariamente
            const _sessionBlocked = !sessionBlockOverrideState.enabled && (_isNyPure || _isNoSession);

            if (_sessionBlocked) {
              // Loga uma vez por ciclo (não por ativo para não encher o log)
              if (key === Object.keys(ASSETS)[0]) {
                const _sessLabel = _isNyPure ? 'NY puro (16:00–21:00 UTC)' : 'Sem sessão (21:00–00:00 UTC)';
                logger.info(`Auto-trade bloqueado por sessão fraca: ${_sessLabel} — aguardando London/Tokyo/Overlap`);
              }
            } else if (sessionBlockOverrideState.enabled && (_isNyPure || _isNoSession)) {
              if (key === Object.keys(ASSETS)[0]) {
                logger.info('Auto-trade: bloqueio de sessão IGNORADO por override manual ativo');
              }
            }

            const risk = autoTradeRiskFilterState.enabled && tradeStore.getRiskState
              ? tradeStore.getRiskState()
              : { level: 'NORMAL', reason: 'filtro de risco desativado' };
            const riskPaused = !!autoTradeRiskFilterState.enabled && ['DEFENSIVE', 'BLOCKED'].includes(risk?.level);
            autoTradeRiskState.paused = !!riskPaused;
            autoTradeRiskState.level = risk?.level || 'NORMAL';
            autoTradeRiskState.reason = risk?.reason || 'condicoes normais';

            if (riskPaused && key === Object.keys(ASSETS)[0]) {
              const now = Date.now();
              if ((now - autoTradeRiskState.lastNotifiedAt) >= AUTO_TRADE_RISK_NOTIFY_COOLDOWN_MS) {
                autoTradeRiskState.lastNotifiedAt = now;
                logger.info(`Auto-trade pausado por risco: ${risk.level} — ${risk.reason}`);
                const ddValue = Number.isFinite(Number(risk.drawdownPct)) ? Number(risk.drawdownPct).toFixed(1) : '0.0';
                const riskMsg = [
                  `🛑 <b>AUTO-TRADE EM PAUSA</b>`,
                  ``,
                  `Motivo: ${risk.level} — ${risk.reason}`,
                  `Streak loss: ${risk.streakLoss ?? 0} | DD: ${ddValue}% | Losses hoje: ${risk.dailyLoss ?? 0}`,
                  `<i>Retoma automaticamente quando o risco normalizar.</i>`,
                ].join('\n');
                sendTelegram(riskMsg).catch(() => {});
              }
            }

            if (autoTradeState.enabled && BOT_WEBHOOK_ENABLED && !_sessionBlocked && !riskPaused) {
              const validAutoStatuses   = ['VALID_SIGNAL'];  // PARTIAL_SIGNAL ignorado — so envia Telegram e abre trade em sinal 100% valido
              const blockedAutoStatuses = ['NEWS_BLOCKED', 'CONTEXT_BLOCKED', 'SIMULATION_BLOCKED', 'MARKET_CLOSED'];
              const score = sig.score || 0;
              // Cooldown efetivo: em modo pyramid usa o cooldown menor (entre entradas);
              // em modo normal usa o cooldown padrao de 4h (1 trade por ativo).
              const effectiveCooldown = pyramidState.enabled
                ? (AUTO_TRADE_PYRAMID_COOLDOWN_MS || 60 * 60 * 1000)
                : AUTO_TRADE_COOLDOWN_MS;
              const cooldownOk =
                !autoTradeState.lastAt[key] ||
                (Date.now() - autoTradeState.lastAt[key]) >= effectiveCooldown;

              if (
                validAutoStatuses.includes(sig.status) &&
                !blockedAutoStatuses.includes(sig.status) &&
                score >= AUTO_OPEN_SCORE_THRESHOLD &&
                ['BUY', 'SELL'].includes(sig.direction) &&
                sig.levels?.entry && sig.levels?.sl && sig.levels?.tp &&
                cooldownOk
              ) {
                const openTrades = tradeStore.listTrades({ asset: key, status: 'open' });
                // Em modo pyramid, permite ate AUTO_TRADE_MAX_PER_ASSET trades abertos.
                // Em modo normal, so abre se nao ha trade aberto.
                const maxAllowed = pyramidState.enabled ? (AUTO_TRADE_MAX_PER_ASSET || 3) : 1;
                const canOpen = !openTrades || openTrades.length < maxAllowed;
                if (canOpen) {
                  autoTradeState.lastAt[key] = Date.now();
                  const pyramidIdx   = pyramidState.enabled && openTrades?.length > 0 ? openTrades.length + 1 : 0;
                  const pyramidLabel = pyramidIdx > 0 ? `Pyramid: entrada ${pyramidIdx} de ${maxAllowed}` : null;
                  const pyramidLogTag = pyramidIdx > 0 ? ` [PYRAMID ${pyramidIdx}/${maxAllowed}]` : '';

                  const trade = tradeStore.openTrade({
                    asset: key,
                    direction: sig.direction,
                    entry: sig.levels.entry,
                    sl:    sig.levels.sl,
                    tp:    sig.levels.tp,
                    atr:   sig.levels.atr || 0,
                    rr:    sig.levels.rr  || 2,
                    score,
                    biasTf:  sig.biasTf  || '1h',
                    entryTf: sig.entryTf || '15m',
                    session: sig.meta?.session || '',
                    managedByMt5: !!BOT_WEBHOOK_ENABLED,
                    reason:  `[AUTO] Score ${score} — ${sig.meta?.reason || ''}`,
                  });

                  // Deduplicacao: tradeStore retornou trade existente (mesmo sinal aberto recentemente)
                  if (trade._deduplicated) {
                    logger.info(`Auto-trade ${key} deduplicado — trade identico ja existe (${trade.id?.slice(-6)})`);
                  } else {
                    logger.info(`AUTO-TRADE disparado: ${key.toUpperCase()} ${sig.direction} score=${score}${pyramidLogTag}`);

                    // Envia ao bot Python para executar no MT5
                    // Apos confirmar envio, marca webhookSent=true para o sistema de dedup saber
                    // que esse trade chegou ao MT5 (evita "phantom trades" bloquearem novas entradas)
                    callBotWebhook(trade).then(result => {
                      if (result?.ok) {
                        if (tradeStore.markWebhookSent) tradeStore.markWebhookSent(trade.id);
                        const autoMsg = buildVipTelegramMessage(sig, ASSETS[key], {
                          pyramidLabel,
                          footerLines: ['⚙️ <i>Ordem aberta automaticamente pelo bot no MT5</i>'],
                        });
                        sendTelegram(autoMsg).catch(() => {});
                      } else {
                        if (tradeStore.deleteTrade) tradeStore.deleteTrade(trade.id);
                        logger.warn(`Auto-trade removido sem abertura MT5: ${result?.reason || 'webhook nao confirmou abertura'}`);
                      }
                    }).catch(err => {
                      if (tradeStore.deleteTrade) tradeStore.deleteTrade(trade.id);
                      logger.warn(`Auto-trade webhook erro; trade removido do painel: ${err.message}`);
                    });

                  }
                } else {
                  const existingCount = openTrades?.length || 0;
                  const blockReason = `limite de ${maxAllowed} trade(s) atingido (${existingCount} aberto[s])`;
                  // Só loga e notifica uma vez a cada 30 minutos por ativo (evita spam)
                  const now = Date.now();
                  const lastLog = _lastBlockLog[key] || 0;
                  if (now - lastLog >= BLOCK_LOG_COOLDOWN_MS) {
                    _lastBlockLog[key] = now;
                    logger.info(`Auto-trade ${key} bloqueado: ${blockReason}`);
                    const blockMsg = [
                      `⚠️ <b>AUTO-TRADE BLOQUEADO</b> — ${key.toUpperCase()}`,
                      ``,
                      `Motivo: ${blockReason}`,
                      `<i>Novas entradas aguardam fechamento das posicoes existentes.</i>`,
                    ].join('\n');
                    sendTelegram(blockMsg).catch(() => {});
                  }
                }
              }
            }
          } catch (vipErr) {
            logger.warn(`VIP scan ${key}:`, vipErr.message);
          }
        }
      } catch (err) {
        logger.warn(`Erro no ciclo de ${key}:`, err.message);
      }
    }
  }, ALERT_INTERVAL_MS);

  _intervals.push(id);
}

function _schedulePolling() {
  const { pollBtcKraken, pollOanda, pollFinnhub, logger, config } = _ctx;
  const { OANDA_API_KEY, OANDA_POLL_MS, FINNHUB_API_KEY } = config;

  // Kraken polling BTC a cada 2 min
  _intervals.push(setInterval(pollBtcKraken, 2 * 60 * 1000));

  // OANDA polling separado (independente do ciclo de alertas)
  if (OANDA_API_KEY) {
    _intervals.push(setInterval(pollOanda, OANDA_POLL_MS));
  }

  // Finnhub polling a cada 2 min (alternativa ao OANDA para preco spot)
  if (FINNHUB_API_KEY && !OANDA_API_KEY) {
    _intervals.push(setInterval(pollFinnhub, 2 * 60 * 1000));
    logger.info('Finnhub configurado — preco spot EUR/USD, USD/JPY, XAU/USD, BTC a cada 2 min');
  }

  // Yahoo Finance polling desativado: Twelve Data voltou a ser o fallback principal
}

function _setupDashboardWss() {
  // Delega para src/ws/server.js — encapsula handshake, auth opcional,
  // snapshot inicial, handlers de message e o intervalo interno de push.
  const { server, logger, config, authStore, getAsset } = _ctx;
  wsServer.start({
    server,
    logger,
    authStore,
    getAsset,
    config: { DASHBOARD_PUSH_MS: config.DASHBOARD_PUSH_MS },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// API publica
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Inicia todos os timers e o WebSocket de dashboard.
 *
 * @param {object} ctx
 * @param {object} ctx.ASSETS
 * @param {Function} ctx.getAsset
 * @param {Function} ctx.checkAndSendAlerts
 * @param {Function} ctx.checkOpenTradesForExit
 * @param {Function} ctx.sendWeeklyReport
 * @param {Function} ctx.callBotWebhook
 * @param {Function} ctx.computeVipSignal
 * @param {object}   ctx._signalCache         — referencia ao cache de signals.js
 * @param {Function} ctx.sendTelegram
 * @param {Function} ctx.pollBtcKraken
 * @param {Function} ctx.pollOanda
 * @param {Function} ctx.pollFinnhub
 * @param {object}   ctx.tradeStore
 * @param {object}   ctx.server               — http.Server (para WSS)
 * @param {object}   [ctx.authStore]          — modulo authStore (opcional, usado se WS_REQUIRE_AUTH)
 * @param {object}   ctx.logger
 * @param {object}   ctx.config
 * @param {number}   ctx.config.ALERT_INTERVAL_MS
 * @param {boolean}  ctx.config.BOT_WEBHOOK_ENABLED
 * @param {number}   ctx.config.AUTO_OPEN_SCORE_THRESHOLD
 * @param {number}   ctx.config.AUTO_TRADE_COOLDOWN_MS
 * @param {string}   ctx.config.OANDA_API_KEY
 * @param {number}   ctx.config.OANDA_POLL_MS
 * @param {string}   ctx.config.FINNHUB_API_KEY
 * @param {number}   ctx.config.DASHBOARD_PUSH_MS
 */
function start(ctx) {
  if (_started) {
    (ctx?.logger || console).warn('scheduler.start chamado mais de uma vez — ignorando');
    return;
  }
  _ctx = ctx;
  _started = true;

  _scheduleWeeklyReport();
  _scheduleAlertScan();
  _schedulePolling();
  _setupDashboardWss();
}

/**
 * Para todos os timers (uso em testes / shutdown gracioso).
 */
function stop() {
  for (const id of _intervals) clearInterval(id);
  _intervals.length = 0;
  wsServer.stop();
  _started = false;
}

module.exports = {
  start,
  stop,
  setAutoTradeEnabled,
  getAutoTradeEnabled,
  getAutoTradeLastAt,
  getAutoTradeRiskState,
  setAutoTradeRiskFilterEnabled,
  setPyramidEnabled,
  getPyramidEnabled,
  setTrailingStopEnabled,
  getTrailingStopEnabled,
  buildDashboardSnapshot,
  pushDashboardSnapshot,
  setSessionBlockOverride,
  getSessionBlockOverride,
};
