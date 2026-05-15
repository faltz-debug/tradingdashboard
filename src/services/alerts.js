'use strict';

/**
 * ALERTS — Camada de alertas, exit-management e relatório semanal.
 *
 * Este módulo concentra as funções que ficam entre o motor de sinais
 * (src/services/signals.js) e o canal de saída (Telegram/Webhook), bem
 * como as rotinas de manutenção de trades abertos e do relatório
 * semanal. Cinco funções foram extraídas do server.js:
 *
 *   - checkAndSendAlerts(key, data)
 *       Avalia a vela 15M de um ativo, aplica filtros (ADX, confluência,
 *       contexto operacional, risco adaptativo) e dispara alerta no
 *       Telegram + grava live signal quando todas as gates passam.
 *
 *   - attachSignals(data, key)
 *       Anexa `data.signals` com computeSignals para 15M/1H/4H/Daily
 *       e marca a confluência de timeframes. Usado por rotas /api/<asset>
 *       que servem o dashboard.
 *
 *   - callBotWebhook(trade)
 *       Notifica o bot MT5 (via HTTP POST) com risk-tier por score.
 *
 *   - checkOpenTradesForExit(asset, data)
 *       Trailing stop por ATR + verificação de TP/SL na vela anterior +
 *       alerta de breakeven e auto-close. Estado vem do tradeStore.
 *
 *   - sendWeeklyReport()
 *       Gera o relatório semanal (live_signals + vip_signals do SQLite)
 *       e envia no Telegram. Idempotente quanto a tradeStore.
 *
 * Dependências externas (módulos):
 *   - axios                       (HTTP — bot webhook)
 *   - logger                      (logger estruturado)
 *   - tradeStore                  (persistência SQLite)
 *   - signals.js                  (computeSignals)
 *   - state.js                    (ASSETS)
 *   - indicators.js               (calcATR)
 *   - telegram.js                 (sendTelegram, buildTelegramMessage,
 *                                   lastSignals, saveLastSignals,
 *                                   ALERT_COOLDOWN_MS, STARTUP_GRACE_MS,
 *                                   SERVER_START_AT)
 *
 * Sessoes + calendario economico vem direto de src/services/context.js
 * (padrao setContextProviders foi eliminado — agora import explicito).
 *
 * Configuração via process.env (lida no carregamento do módulo):
 *   - TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, LOCAL_SAFE → TELEGRAM_ENABLED
 *   - AUTO_BLOCK_WEAK_CONTEXT (default: ativo)
 *
 * NOTA: callBotWebhook + BOT_WEBHOOK_* + AUTO_OPEN_SCORE_THRESHOLD migraram
 * para src/services/botWebhook.js (com idempotency cache por trade.id).
 */

const logger = require('../../logger');
const tradeStore = require('../../tradeStore');

const { computeSignals } = require('./signals');
const { ASSETS } = require('./state');
const { calcATR } = require('./indicators');
const { getSessionInfo, getNewsStatus } = require('./context');
const {
  sendTelegram,
  buildTelegramMessage,
  lastSignals,
  saveLastSignals,
  ALERT_COOLDOWN_MS,
  STARTUP_GRACE_MS,
  SERVER_START_AT,
} = require('./telegram');

// ── Configuração via env (lida no carregamento) ───────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const LOCAL_SAFE       = process.env.LOCAL_SAFE !== 'false';
const TELEGRAM_ENABLED = !LOCAL_SAFE && !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID);

const AUTO_BLOCK_WEAK_CONTEXT = process.env.AUTO_BLOCK_WEAK_CONTEXT !== 'false';
// BOT_WEBHOOK_* e AUTO_OPEN_SCORE_THRESHOLD agora vivem em src/services/botWebhook.js

// ── Trailing Stop toggle (controlado via /api/admin/trailing-stop) ─────────
let _trailingStopEnabled = false;
function setTrailingStopEnabled(v) { _trailingStopEnabled = !!v; }
function getTrailingStopEnabled()  { return _trailingStopEnabled; }

// ──────────────────────────────────────────────────────────────────────────
// checkAndSendAlerts — vela 15M → filtros → live_signal + Telegram
// ──────────────────────────────────────────────────────────────────────────
async function checkAndSendAlerts(key, data) {
  if (!TELEGRAM_ENABLED) return;

  // CRÍTICO: nunca dispara alerta baseado em dados simulados
  if (data.isSimulation) {
    logger.debug(`Alerta suprimido - ${key} suprimido: fonte é Simulação — sem dados reais da API`);
    return;
  }
  // Não dispara alerta com mercado fechado
  if (data.isMarketClosed) {
    logger.debug(`Alerta suprimido (mercado fechado) - ${key} suprimido: mercado fechado`);
    return;
  }
  // Grace period: após restart, espera 2min para estabilizar dados antes de alertar
  if (Date.now() - SERVER_START_AT < STARTUP_GRACE_MS) {
    logger.debug(`Alerta suprimido (grace period) - ${key} suprimido: grace period pós-restart`);
    return;
  }

  const cfg = ASSETS[key];

  const candles15m = data['15m'];
  const candles1h  = data['1h'];
  const candles4h  = data['4h'];
  if (!candles15m || candles15m.length < 50) return;

  // Computa sinal base no 15M
  const s = computeSignals(candles15m, cfg.name, cfg.decimals, '15M', data);

  // Detecta confluência: quais timeframes maiores concordam com o sinal do 15M?
  if (s.score !== 0) {
    const dir = Math.sign(s.score);
    if (candles1h && candles1h.length >= 20) {
      const s1h = computeSignals(candles1h, cfg.name, cfg.decimals, '1H');
      if (Math.sign(s1h.score) === dir) s.tfConfluence.push('1H');
    }
    if (candles4h && candles4h.length >= 10) {
      const s4h = computeSignals(candles4h, cfg.name, cfg.decimals, '4H');
      if (Math.sign(s4h.score) === dir) s.tfConfluence.push('4H');
    }
  }

  const prev = lastSignals[key];
  const now  = Date.now();

  // Cooldown: não reenvia o mesmo tipo de alerta para o mesmo ativo dentro de 1h
  const cooldownOk = !prev?.lastSentAt || (now - prev.lastSentAt) >= ALERT_COOLDOWN_MS;

  // Dispara alerta se:
  // (a) Master Signal mudou  OU
  // (b) Alerta de Reversão novo apareceu
  // ... E o cooldown de 1h foi respeitado
  const masterChanged   = prev?.masterLabel !== s.masterLabel;
  const reversalChanged = !prev?.rsiReversalAlert && s.rsiReversalAlert;

  const sessionInfo = getSessionInfo(key);
  const newsInfo    = getNewsStatus(key);

  // Filtro 1 — ADX duro: se não há tendência (ADX < 25), suprime alerta de tendência
  // Aplica tanto a masterChanged quanto a reversalChanged (em mercado lateral, RSI
  // oscila entre extremos frequentemente e gera muitos falsos positivos)
  const adxBlocked = !s.adxOk;

  // Filtro 2 — Confluência 1H obrigatória para sinais de tendência (masterChanged)
  // Sem 1H concordando, o sinal de 15M tem probabilidade baixa de ser sustentável.
  // OBS: reversalChanged (RSI<30/>70 + Bollinger) NAO exige confluencia 1H — eh
  // por design: alerta de reversao opera contra a tendencia maior, entao exigir
  // 1H confirmando a direcao do reversal e contraditorio (1H normalmente apoia
  // a tendencia que esta prestes a reverter).
  const has1hConfluence = s.tfConfluence.includes('1H');
  const confluenceBlocked = masterChanged && s.score !== 0 && !has1hConfluence;
  const contextBlocked = AUTO_BLOCK_WEAK_CONTEXT && s.operationalContext?.status === 'EVITAR';

  const filterBlock = adxBlocked || confluenceBlocked || contextBlocked;

  if (filterBlock) {
    const reason = contextBlocked
      ? `Contexto operacional em EVITAR — ${s.operationalContext?.detail || 'histórico fraco'}`
      : adxBlocked
      ? `ADX baixo (${s.adx.toFixed(1)}) — mercado lateral`
      : `Sem confluência 1H — sinal fraco`;
    logger.debug(`Alerta suprimido - ${cfg.name} suprimido: ${reason}`);
  }

  // ===== RISCO ADAPTATIVO (informativo apenas — sem bloqueio de sinais) =====
  // O estado de risco é calculado para exibição no painel /api/risk-state,
  // mas NÃO bloqueia mais a emissão de sinais (desabilitado por configuração).
  const riskState = tradeStore.getRiskState();
  const riskFilterBlock = false; // Bloqueio por risco desabilitado

  // Se notícia de alto impacto está muito próxima (±30min), avisa mas NÃO bloqueia
  // O trader decide — mas a info vai no alert

  const actionableLiveSignal = masterChanged && Math.abs(s.score) >= 2 && !filterBlock;
  // Guard defensivo: nunca persistir live_signal sem SL/TP. Em teoria
  // |score|>=2 garante isso, mas se computeSignals retornar score!=0 sem ATR
  // (candles invalidos / gap), s.sl/s.tp viriam null e o checkOpenTradesForExit
  // simplesmente ignoraria o trade (nunca fecharia automatico).
  const hasValidLevels = s.sl != null && s.tp != null && !isNaN(s.sl) && !isNaN(s.tp);
  if (actionableLiveSignal && hasValidLevels) {
    tradeStore.appendLiveSignal({
      asset: key,
      assetName: cfg.name,
      tf: '15m',
      emittedAt: now,
      emittedCandleTime: candles15m[candles15m.length - 1]?.time,
      entryPrice: s.price,
      direction: s.score > 0 ? 'BUY' : 'SELL',
      score: s.score,
      rawScore: s.rawScore,
      label: s.masterLabel,
      slPrice: s.sl,
      tpPrice: s.tp,
      rr: 2,
      audit: s.audit || null,
      operationalContext: s.operationalContext || null,
      riskState: { level: riskState.level, reason: riskState.reason, sizingMultiplier: riskState.sizingMultiplier },
      horizonCandles: 4,
      source: 'live_master_signal',
    });
  }

  // Só envia Telegram quando score é forte (|score| >= 3 = todos os filtros alinhados)
  // Score 2 (MODERADA) continua registrado no dashboard mas não gera ruído no Telegram
  // Alinhado com o backtester: entradas válidas só ocorrem com rawScore ±3
  const strongSignal = Math.abs(s.score) >= 3;

  if ((masterChanged || reversalChanged) && strongSignal && cooldownOk && !filterBlock && !riskFilterBlock) {
    const riskWarning = riskState.level !== 'NORMAL'
      ? `\n⚠️ *Modo ${riskState.level}* — ${riskState.reason} | Sizing: ${Math.round(riskState.sizingMultiplier * 100)}%`
      : '';
    const header = masterChanged
      ? (prev ? `🔔 Sinal mudou: ${prev.masterLabel} → ${s.masterLabel}` : '🔔 Primeiro sinal detectado')
      : '⚡ Novo sinal de Reversão detectado';
    const msg = `${header}${riskWarning}\n\n` + buildTelegramMessage(s, sessionInfo, newsInfo);
    try {
      await sendTelegram(msg);
      lastSignals[key] = { masterLabel: s.masterLabel, rsiReversalAlert: s.rsiReversalAlert, lastSentAt: now };
      saveLastSignals();
    } catch (err) {
      // Falha na entrega: não atualiza lastSentAt para tentar de novo no próximo ciclo
      logger.error(`Falha ao entregar alerta ${cfg.name} — será retentado no próximo ciclo`);
    }
  } else {
    // Atualiza estado mas sem enviar
    if (!lastSignals[key]) lastSignals[key] = {};
    lastSignals[key].masterLabel     = s.masterLabel;
    lastSignals[key].rsiReversalAlert = s.rsiReversalAlert;
    saveLastSignals();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// attachSignals — anexa data.signals com computeSignals em todos os TFs
// ──────────────────────────────────────────────────────────────────────────
function attachSignals(data, key) {
  const cfg = ASSETS[key];
  if (data.isSimulation || data.isMarketClosed || !data['15m']?.length) return data;
  try {
    const s15   = computeSignals(data['15m'], cfg.name, cfg.decimals, '15M', data);
    const s1h   = data['1h']?.length    >= 20 ? computeSignals(data['1h'],    cfg.name, cfg.decimals, '1H')    : null;
    const s4h   = data['4h']?.length    >= 10 ? computeSignals(data['4h'],    cfg.name, cfg.decimals, '4H')    : null;
    const sDaily= data['daily']?.length >= 10 ? computeSignals(data['daily'], cfg.name, cfg.decimals, 'DAILY') : null;

    // Detecta confluência de timeframes (mesmo sinal que o 15M)
    const dir = Math.sign(s15.score);
    const confluence = ['15M'];
    if (s1h && Math.sign(s1h.score) === dir && dir !== 0) confluence.push('1H');
    if (s4h && Math.sign(s4h.score) === dir && dir !== 0) confluence.push('4H');

    data.signals = {
      '15m': { ...s15, tfConfluence: confluence },
      '1h':  s1h,
      '4h':  s4h,
      'daily': sDaily,
    };
  } catch (e) {
    logger.warn(`attachSignals ${key}:`, e.message);
  }
  return data;
}

// callBotWebhook migrada para src/services/botWebhook.js (com idempotency cache).

// ──────────────────────────────────────────────────────────────────────────
// checkOpenTradesForExit — trailing ATR + verificação TP/SL na vela anterior
// ──────────────────────────────────────────────────────────────────────────
async function checkOpenTradesForExit(asset, data) {
  if (data.isSimulation || data.isMarketClosed) return;

  const candles = data['15m'];
  if (!candles || candles.length < 2) return;

  // Usa a vela anterior à última (a última pode ainda estar formando)
  const candle = candles[candles.length - 2];
  if (!candle) return;

  const candleOpenAtMs  = (candle.time || 0) * 1000;
  const candleCloseAtMs = candleOpenAtMs + (15 * 60 * 1000);

  // ATR atual para trailing stop (14 períodos ou menos se não houver dados suficientes)
  const currentAtr = calcATR(candles) || 0;

  const openTrades = tradeStore.listTrades({ asset, status: 'open' });
  if (!openTrades.length) return;

  const cfg = ASSETS[asset];

  for (const trade of openTrades) {
    let { id, direction, entry, sl, tp, openedAt, atr: tradeAtr, peakPrice } = trade;
    if (!sl || isNaN(sl)) continue;

    // ── MFE (Max Favorable Excursion em R) ────────────────────────────────
    // Atualiza pelo candle anterior. Para trades gerenciados pelo MT5 (com
    // ticket), o bot Python tambem envia ticks via /api/vip/bot/progress;
    // updateTradeMfe so AVANCA o pico, entao chamadas duplicadas sao seguras.
    try {
      tradeStore.updateTradeMfe(trade.id, { priceHigh: candle.high, priceLow: candle.low });
    } catch (_) { /* nao critico */ }

    // Trades com ticket MT5 são gerenciados pelo bot Python — o bot reporta
    // o fechamento via /api/bot/result com o preço real do broker.
    // Não usar candle da API (feed diferente) para determinar o outcome.
    if (trade.mt5Ticket || trade.managedByMt5) continue;

    // Só avalia candles totalmente posteriores à abertura do trade
    if (!openedAt || candleOpenAtMs <= openedAt || candleCloseAtMs <= openedAt) continue;

    const isBuy = direction === 'BUY';
    const hasTP = tp != null && !isNaN(tp);

    // ── TRAILING STOP POR ATR ─────────────────────────────────────────────
    // Só executa se trailing stop estiver ligado via /api/admin/trailing-stop
    const trailAtr = (tradeAtr && !isNaN(tradeAtr) && tradeAtr > 0) ? tradeAtr : currentAtr;

    if (_trailingStopEnabled && trailAtr > 0) {
      // Atualiza peakPrice: máximo high (BUY) ou mínimo low (SELL) desde a abertura
      const newPeak = isBuy
        ? Math.max(peakPrice ?? entry, candle.high)
        : Math.min(peakPrice ?? entry, candle.low);

      // Trailing SL = peakPrice - 1.5×ATR (BUY) | peakPrice + 1.5×ATR (SELL)
      const trailDist = 1.5 * trailAtr;
      const trailSL   = isBuy
        ? parseFloat((newPeak - trailDist).toFixed(cfg?.decimals ?? 5))
        : parseFloat((newPeak + trailDist).toFixed(cfg?.decimals ?? 5));

      // Só move SL se melhorar (nunca recua)
      const slImproved = isBuy ? trailSL > sl : trailSL < sl;

      if (slImproved) {
        const prevSL   = sl;
        const wasBelow = isBuy ? prevSL < entry : prevSL > entry; // estava abaixo do entry?
        const nowAbove = isBuy ? trailSL >= entry : trailSL <= entry; // passou para acima?

        sl = trailSL;
        tradeStore.updateTradeSL(id, { sl: trailSL, peakPrice: newPeak });
        logger.info(`Trailing SL ${asset.toUpperCase()} ${direction}: ${prevSL} → ${trailSL} (peak ${newPeak})`);

        // Alerta Telegram quando atinge breakeven (SL cruza o preço de entrada)
        if (wasBelow && nowAbove) {
          const beMsg = [
            `🔒 <b>VIP — BREAKEVEN ATINGIDO</b>`,
            ``,
            `<b>${asset.toUpperCase()}</b>  ${direction}  — trade protegido`,
            `Entry: ${entry}  |  Novo SL: <b>${trailSL}</b>`,
            `Peak: ${newPeak}  |  ATR: ${trailAtr}`,
          ].join('\n');
          sendTelegram(beMsg).catch(() => {});
        }
      }

      // Atualiza peakPrice mesmo se SL não melhorou (para próximo ciclo)
      if (newPeak !== peakPrice) {
        tradeStore.updateTradeSL(id, { peakPrice: newPeak });
      }
    }

    // ── VERIFICAÇÃO DE SAÍDA (TP / SL) ───────────────────────────────────
    let outcome    = null;
    let closePrice = null;

    if (isBuy) {
      if (hasTP && candle.high >= tp) {
        outcome    = 'TP';
        closePrice = tp;
      } else if (candle.low <= sl) {
        outcome    = 'SL';
        closePrice = sl;
      }
    } else {
      if (hasTP && candle.low <= tp) {
        outcome    = 'TP';
        closePrice = tp;
      } else if (candle.high >= sl) {
        outcome    = 'SL';
        closePrice = sl;
      }
    }

    if (!outcome) continue;

    const closed = tradeStore.closeTrade(id, { closePrice, outcome });
    if (!closed) continue;

    logger.info(`Auto-close ${asset.toUpperCase()} ${direction} -> ${outcome} @ ${closePrice} | ${closed.pnlR}R`);

    const pnlPos       = (closed.pnlR || 0) >= 0;
    const outcomeEmoji = outcome === 'TP' ? '\u2705' : '\u274C';
    const pnlEmoji     = pnlPos ? '\uD83D\uDCB0' : '\uD83D\uDCC9';
    const trailNote    = closed.peakPrice ? ` | Peak: ${closed.peakPrice}` : '';
    const autoMsg = [
      `\u2B50 <b>VIP - AUTO-FECHADO</b> ${outcomeEmoji}`,
      ``,
      `<b>${asset.toUpperCase()}</b>  ${direction}  ->  ${outcome} <i>(automatico)</i>`,
      `Entry: ${entry}  |  Close: <b>${closePrice}</b>${trailNote}`,
      `Resultado: ${pnlEmoji} <b>${pnlPos ? '+' : ''}${closed.pnlR}R</b>  (${pnlPos ? '+' : ''}${closed.pnlPct}%)`,
      closed.session ? `Sessao: ${closed.session}` : '',
    ].filter(Boolean).join('\n');

    sendTelegram(autoMsg).catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────────────────────
// sendWeeklyReport — relatório semanal via Telegram (segunda 08:00 UTC)
// ──────────────────────────────────────────────────────────────────────────
/**
 * Gera e envia relatório de performance semanal via Telegram.
 * Chamado toda segunda-feira às 08:00 UTC.
 *
 * Usa os dados reais do live_signals + vip_signals acumulados no SQLite.
 * Não requer dados de candle em tempo real — trabalha só com histórico persistido.
 */
async function sendWeeklyReport() {
  try {
    logger.info('📊 Gerando relatório semanal...');
    const stats = tradeStore.getLiveSignalStats();
    const vipStats = tradeStore.getStats();

    if (!stats) {
      await sendTelegram('📊 <b>Relatório Semanal</b>\n\nSem dados suficientes ainda para gerar relatório.');
      return;
    }

    const { evaluated, winRate, wins, losses, avgPct, recent, streaks,
            drawdown, executive, byAsset, bySession, byRegime } = stats;

    // ── Formatadores ──────────────────────────────────────────────────────
    const pctFmt  = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
    const wr      = (v) => `${v.toFixed(1)}%`;
    const trend   = (cur, prev) => cur > prev ? '↗️' : cur < prev ? '↘️' : '➡️';
    const medal   = (i) => ['🥇', '🥈', '🥉'][i] || '▪️';

    // ── Status operacional com emoji ──────────────────────────────────────
    const statusEmoji = {
      AGRESSIVO_CONTROLADO: '🟢',
      ESTAVEL:              '🟡',
      DEFENSIVO:            '🔴',
    }[executive.operationalStatus] || '⚪';

    // ── Top ativos ────────────────────────────────────────────────────────
    const assetRows = Object.entries(byAsset || {})
      .filter(([, r]) => r.total >= 3)
      .sort((a, b) => (b[1].winRate - a[1].winRate) || (b[1].sumPct - a[1].sumPct))
      .slice(0, 4);

    // ── Top sessões ───────────────────────────────────────────────────────
    const sessionRows = Object.entries(bySession || {})
      .filter(([, r]) => r.total >= 3)
      .sort((a, b) => b[1].winRate - a[1].winRate)
      .slice(0, 3);

    // ── Últimos 7 dias ────────────────────────────────────────────────────
    const recentDayLines = (stats.recentDaily || []).slice(-5).map(d =>
      `  ${d.date.slice(5)}: ${d.wins}W/${d.losses}L  WR ${wr(d.winRate)}  ${pctFmt(d.sumPct)}`
    );

    // ── Monta mensagem ────────────────────────────────────────────────────
    const lines = [
      `📊 <b>RELATÓRIO SEMANAL — ${new Date().toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</b>`,
      ``,
      `${statusEmoji} <b>Status: ${executive.operationalStatus}</b>`,
      ``,
      `📈 <b>Sinais Avaliados (histórico)</b>`,
      `  Total: ${evaluated} | Wins: ${wins} | Losses: ${losses}`,
      `  Win Rate: <b>${wr(winRate)}</b>  |  Média: ${pctFmt(avgPct)}`,
      `  Max Drawdown: ${drawdown.maxDrawdownPct.toFixed(2)}%`,
      ``,
      `🔥 <b>Últimas 20 operações</b>`,
      `  WR: ${wr(recent.winRate)} | Streak W: ${streaks.currentWin} L: ${streaks.currentLoss}`,
      `  Veredicto: ${recent.verdict === 'QUENTE' ? '🔥 QUENTE' : recent.verdict === 'FRIO' ? '🧊 FRIO' : '😐 NEUTRO'}`,
    ];

    if (vipStats.trades > 0) {
      lines.push(``, `⭐ <b>Trades VIP Manuais</b>`);
      lines.push(`  Total: ${vipStats.trades} | WR: ${wr(vipStats.winRate)} | Avg R: ${vipStats.avgR}R`);
    }

    if (assetRows.length) {
      lines.push(``, `🏆 <b>Performance por Ativo</b>`);
      assetRows.forEach(([name, r], i) =>
        lines.push(`  ${medal(i)} ${name.toUpperCase()}: WR ${wr(r.winRate)} (${r.total} sinais) ${pctFmt(r.sumPct)}`)
      );
    }

    if (sessionRows.length) {
      lines.push(``, `🕐 <b>Melhores Sessões</b>`);
      sessionRows.forEach(([name, r], i) =>
        lines.push(`  ${medal(i)} ${name}: WR ${wr(r.winRate)} (${r.total})`)
      );
    }

    if (recentDayLines.length) {
      lines.push(``, `📅 <b>Últimos dias</b>`);
      lines.push(...recentDayLines);
    }

    // Regime mais forte e mais fraco
    const regimeEntries = Object.entries(byRegime || {}).filter(([, r]) => r.total >= 3);
    const bestRegime  = regimeEntries.sort((a, b) => b[1].winRate - a[1].winRate)[0];
    const worstRegime = regimeEntries.sort((a, b) => a[1].winRate - b[1].winRate)[0];
    if (bestRegime || worstRegime) {
      lines.push(``, `📊 <b>Regimes de Mercado</b>`);
      if (bestRegime)  lines.push(`  ✅ Melhor: ${bestRegime[0]}  WR ${wr(bestRegime[1].winRate)}`);
      if (worstRegime && worstRegime[0] !== bestRegime?.[0])
        lines.push(`  ❌ Pior:   ${worstRegime[0]}  WR ${wr(worstRegime[1].winRate)}`);
    }

    lines.push(``);
    lines.push(`💡 <b>Recomendação da semana</b>`);
    if (executive.operationalStatus === 'DEFENSIVO') {
      lines.push(`  ⚠️ Sistema defensivo — operar só BTC/XAU com score máximo`);
    } else if (recent.verdict === 'QUENTE' && winRate >= 55) {
      lines.push(`  ✅ Condições favoráveis — manter sizing normal`);
    } else if (winRate < 45) {
      lines.push(`  ⚠️ Win rate abaixo de 45% — revisar parâmetros ou reduzir sizing`);
    } else {
      lines.push(`  ➡️ Performance estável — seguir o plano`);
    }

    lines.push(``, `⏰ Próximo relatório: próxima segunda 08:00 UTC`);

    await sendTelegram(lines.join('\n'));
    logger.info('✅ Relatório semanal enviado com sucesso');

  } catch (err) {
    logger.warn('⚠️  Erro ao gerar relatório semanal:', err.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────────────────
module.exports = {
  checkAndSendAlerts,
  attachSignals,
  checkOpenTradesForExit,
  sendWeeklyReport,
};
