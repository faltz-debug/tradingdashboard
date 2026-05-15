'use strict';

/**
 * TELEGRAM — Envio de alertas e estado de sinais persistido.
 *
 * Este módulo centraliza:
 *   1. Envio de mensagens via Telegram Bot API (sendTelegram)
 *   2. Formatação de mensagens de sinal (fmt, buildTelegramMessage)
 *   3. Estado persistido de sinais no disco (lastSignals, saveLastSignals)
 *      — singleton: qualquer módulo que importar lastSignals acessa o mesmo objeto
 *
 * Nota: checkAndSendAlerts permanece no server.js por ora (muitas dependências
 * cruzadas com computeSignals, getSessionInfo, getNewsStatus, tradeStore).
 * Será extraído em etapa futura junto com alerts.js.
 *
 * Exportações:
 *   - ALERT_COOLDOWN_MS     → número — cooldown entre alertas do mesmo ativo (1h)
 *   - STARTUP_GRACE_MS      → número — grace period pós-restart (2min)
 *   - SERVER_START_AT       → número — timestamp de início do processo
 *   - SIGNALS_FILE          → string — caminho do arquivo de estado de sinais
 *   - lastSignals           → object — estado mutável singleton ({ [key]: {...} })
 *   - saveLastSignals()     → void — persiste lastSignals no disco (debounced)
 *   - sendTelegram(message) → Promise<void>
 *   - fmt(v, dec)           → string — formata preço para exibição
 *   - buildTelegramMessage(s, sessionInfo, newsInfo) → string — monta HTML do alerta
 */

const path  = require('path');
const fs    = require('fs');
const axios = require('axios');

const logger = require('../../logger');

// ─── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const LOCAL_SAFE       = process.env.LOCAL_SAFE !== 'false';

// __dirname aqui é src/services/ — sobe dois níveis para chegar na raiz
const _ROOT = require('path').resolve(__dirname, '../..');

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;  // 1 hora entre alertas do mesmo ativo
const SIGNALS_FILE      = process.env.SIGNALS_FILE || path.join(_ROOT, 'data', 'lastSignals.json');
const STARTUP_GRACE_MS  = 2 * 60 * 1000;   // grace period após restart
const SERVER_START_AT   = Date.now();       // timestamp de início do processo

// ─── ESTADO PERSISTIDO (singleton) ───────────────────────────────────────────

/**
 * Lê o estado de sinais do disco.
 * Retorna {} se o arquivo não existir ou estiver corrompido.
 */
function loadLastSignals() {
  try {
    if (fs.existsSync(SIGNALS_FILE)) {
      const raw  = fs.readFileSync(SIGNALS_FILE, 'utf8');
      const data = JSON.parse(raw);
      logger.info('lastSignals restaurado do disco');
      return data;
    }
  } catch (e) {
    logger.warn('Erro ao ler lastSignals.json — iniciando vazio:', e.message);
  }
  return {};
}

// Controles internos do debounce de escrita
let _saveTimer      = null;
let _saveInProgress = false;

/**
 * Persiste lastSignals no disco com atomic write (temp file + rename).
 * Debounced: chamadas em rajada resultam em apenas uma escrita (300ms).
 * Evita corrupção se o processo crashar durante a escrita.
 */
function saveLastSignals() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    if (_saveInProgress) return;
    _saveInProgress = true;
    const tmpFile = SIGNALS_FILE + '.tmp';
    const data    = JSON.stringify(lastSignals, null, 2);
    fs.writeFile(tmpFile, data, (err) => {
      if (err) {
        logger.warn('Erro ao salvar lastSignals.json:', err.message);
        _saveInProgress = false;
        return;
      }
      fs.rename(tmpFile, SIGNALS_FILE, (renameErr) => {
        if (renameErr) logger.warn('Erro ao renomear lastSignals.tmp:', renameErr.message);
        _saveInProgress = false;
      });
    });
  }, 300);
}

/**
 * Estado mutável de sinais — singleton.
 * Estrutura: { [assetKey | vipKey]: { masterLabel?, rsiReversalAlert?, lastSentAt? } }
 * Exportado para que server.js (checkAndSendAlerts, computeVipSignal, rotas) possa
 * ler e escrever — Node.js garante que é o mesmo objeto em memória.
 */
const lastSignals = loadLastSignals();

// ─── ENVIO TELEGRAM ───────────────────────────────────────────────────────────

/**
 * Envia uma mensagem via Telegram Bot API (HTML parse mode).
 * Loga e relança exceções — quem chama decide se ignora ou propaga.
 * No-op se LOCAL_SAFE=true ou se as credenciais não estiverem configuradas.
 */
async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  if (LOCAL_SAFE) {
    logger.info('Telegram suprimido: LOCAL_SAFE=true');
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' },
      { timeout: 8000 }
    );
    logger.info('Telegram enviado');
  } catch (err) {
    logger.error('Telegram erro:', err.response?.data?.description || err.message);
    throw err;
  }
}

// ─── FORMATAÇÃO ───────────────────────────────────────────────────────────────

/**
 * Formata um número de preço para exibição.
 * dec=0 → inteiro com separador milhar (BTC), dec>0 → casas decimais fixas.
 */
function fmt(v, dec) {
  if (dec === 0) return '$' + Math.round(v).toLocaleString('pt-BR');
  return v.toFixed(dec);
}

/**
 * Monta a mensagem HTML de alerta de sinal para o Telegram.
 *
 * @param {object} s           - Objeto de sinal (resultado de computeSignals)
 * @param {object} sessionInfo - Resultado de getSessionInfo (pode ser null)
 * @param {object} newsInfo    - Resultado de getNewsStatus (pode ser null)
 * @returns {string}           - Mensagem HTML pronta para envio
 */
function buildTelegramMessage(s, sessionInfo, newsInfo) {
  const scoreBar = '█'.repeat(Math.abs(s.score)) + '░'.repeat(3 - Math.abs(s.score));
  const dir = s.score > 0 ? '▲' : s.score < 0 ? '▼' : '—';

  const tfText = s.tfConfluence && s.tfConfluence.length > 1
    ? s.tfConfluence.join(' ✅ ') + ' <b>(confluência!)</b>'
    : (s.tfConfluence?.[0] || '15M') + ' apenas';

  // ADX badge
  const adxEmoji = s.adx >= 40 ? '🔥' : s.adx >= 25 ? '📈' : s.adx >= 15 ? '〰️' : '😴';
  const adxText  = `${adxEmoji} ADX: <b>${s.adx.toFixed(1)}</b> (${s.adxTrend}) ${s.adxDir} | +DI: ${s.pdi.toFixed(1)} | −DI: ${s.mdi.toFixed(1)}`;

  // Filtros FTMO
  const filtros = [];
  if (!s.adxOk)                              filtros.push('⚠️ ADX baixo — mercado lateral');
  if (sessionInfo && !sessionInfo.isGood)    filtros.push('⚠️ Fora da sessão ideal para este ativo');

  let msg = `${s.masterEmoji} <b>${s.asset} — ${s.masterLabel}</b>\n`;
  msg += `💰 Preço: <b>${fmt(s.price, s.dec)}</b>\n`;
  msg += `📊 Score: ${dir} ${s.score > 0 ? '+' : ''}${s.score}/3  [${scoreBar}]\n`;
  msg += `⏱ Timeframe: ${tfText}\n`;
  msg += `${adxText}\n`;
  if (sessionInfo) msg += `🕐 Sessão: ${sessionInfo.sessionStr}\n`;

  if (filtros.length) msg += `\n${filtros.join('\n')}\n`;

  msg += `\n<b>Confirmações (3 filtros):</b>\n`;
  msg += `  EMA Tendência : ${s.trendSig === 'COMPRA' ? '🟢' : s.trendSig === 'VENDA' ? '🔴' : '⚪'} ${s.trendSig}\n`;
  msg += `  RSI Momentum  : ${s.rsiTrendSig === 'COMPRA' ? '🟢' : s.rsiTrendSig === 'VENDA' ? '🔴' : '⚪'} ${s.rsiTrendSig} (RSI ${s.rsi.toFixed(1)})\n`;
  msg += `  Breakout      : ${s.bkSig === 'COMPRA' ? '🟢' : s.bkSig === 'VENDA' ? '🔴' : '⚪'} ${s.bkSig}\n`;

  if (s.audit) {
    const blockers = s.audit.blockers.length ? s.audit.blockers.join(' | ') : 'Nenhum bloqueio crítico';
    msg += `\n🔎 <b>Auditoria:</b>\n`;
    msg += `  Regime: ${s.audit.regime} | Score bruto: ${s.audit.scoreBeforeAdx > 0 ? '+' : ''}${s.audit.scoreBeforeAdx} | Final: ${s.audit.scoreAfterAdx > 0 ? '+' : ''}${s.audit.scoreAfterAdx}\n`;
    msg += `  Sessão: ${s.audit.session.label} | News: ${s.audit.news.isBlocked ? 'BLOQUEADA' : 'LIVRE'}\n`;
    msg += `  Bloqueios: ${blockers}\n`;
  }

  if (s.operationalContext) {
    msg += `\n🧭 <b>Contexto Operacional:</b>\n`;
    msg += `  ${s.operationalContext.status} | ${s.operationalContext.summary}\n`;
    msg += `  ${s.operationalContext.detail}\n`;
  }

  // Níveis de operação
  if (s.sl !== null) {
    msg += `\n📍 <b>Níveis de Operação (${s.tfConfluence?.[0] || '15M'}):</b>\n`;
    msg += `  🎯 Entrada  : ${fmt(s.entry, s.dec)}\n`;
    msg += `  🛑 Stop Loss: ${fmt(s.sl, s.dec)}\n`;
    msg += `  ✅ Alvo TP  : ${fmt(s.tp, s.dec)}\n`;
    msg += `  📐 RR       : 1:2\n`;
  }

  // Suporte/Resistência
  if (s.sr) {
    const { nearestRes, nearestSup } = s.sr;
    if (nearestRes || nearestSup) {
      msg += `\n📐 <b>Suporte/Resistência:</b>\n`;
      if (nearestRes) msg += `  🔴 Resistência: ${fmt(nearestRes.price, s.dec)}\n`;
      if (nearestSup) msg += `  🟢 Suporte: ${fmt(nearestSup.price, s.dec)}\n`;
    }
  }

  // Divergência
  if (s.div && s.div.divergences.length > 0) {
    const masterDir   = s.score > 0 ? 'BUY' : s.score < 0 ? 'SELL' : null;
    const divConfirms = masterDir === 'BUY'  ? s.div.hasBullish
                      : masterDir === 'SELL' ? s.div.hasBearish : false;
    const divOpposes  = masterDir === 'BUY'  ? s.div.hasBearish
                      : masterDir === 'SELL' ? s.div.hasBullish : false;
    msg += `\n🔀 <b>Divergência Detectada:</b>\n`;
    for (const d of s.div.divergences) {
      const emoji = d.type.startsWith('bullish') ? '🟢' : '🔴';
      msg += `  ${emoji} ${d.label}\n`;
    }
    if (divConfirms) msg += `  ✅ <i>Divergência confirma a direção do sinal</i>\n`;
    if (divOpposes)  msg += `  ⚠️ <b>ATENÇÃO: Divergência CONTRÁRIA ao sinal — risco de reversão</b>\n`;
  }

  // Alerta de Reversão RSI
  if (s.rsiReversalAlert) {
    const rev = s.rsi < 30 ? '🔄 REVERSÃO ALTA' : '🔄 REVERSÃO BAIXA';
    msg += `\n⚡ <b>${rev} — RSI + Bollinger confirmam!</b>\n`;
    msg += `  RSI: ${s.rsi.toFixed(1)} | BB ${s.rsi < 30 ? 'Inf' : 'Sup'}: ${fmt(s.rsi < 30 ? s.bb.lower : s.bb.upper, s.dec)}\n`;
  } else if (s.rsiSig !== 'NEUTRO') {
    msg += `\n🔄 Reversão (RSI): ${s.rsiSig === 'COMPRA' ? '🟢' : '🔴'} ${s.rsiSig} (RSI ${s.rsi.toFixed(1)})\n`;
  }

  // Notícias
  if (newsInfo && newsInfo.isNearNews) {
    msg += `\n📰 <b>⚠️ NOTÍCIA DE ALTO IMPACTO:</b> ${newsInfo.nearName} (${newsInfo.nearTimeStr})\n`;
    msg += `<i>Considere aguardar a volatilidade passar.</i>\n`;
  }

  msg += `\n⏰ ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
  msg += `\n⚠️ <i>Confirme no MetaTrader antes de operar</i>`;
  return msg;
}

/**
 * buildVipTelegramMessage — monta a mensagem Telegram no formato VIP completo
 * a partir do objeto `sig` retornado por computeVipSignal().
 * Usado tanto pelo scheduler (auto-trade) quanto por signals.js.
 *
 * @param {object} sig        - resultado de computeVipSignal()
 * @param {object} assetCfg   - objeto ASSETS[key] com .name, .symbol, etc.
 * @param {object} [opts]
 * @param {string} [opts.header]        - linha de cabecalho customizada
 * @param {string} [opts.pyramidLabel]  - ex: "Pyramid: entrada 2 de 3"
 * @returns {string}
 */
function buildVipTelegramMessage(sig, assetCfg, opts = {}) {
  const { score, maxScore, direction, status, filters: f, levels: L, meta: m, operationalContext: oc } = sig;
  const entryTf = sig.entryTf || '15m';
  const biasTf  = sig.biasTf  || '1h';
  const dirEmoji    = direction === 'BUY' ? '📈' : '📉';
  const statusLabel = status === 'VALID_SIGNAL' ? '✅ SINAL VÁLIDO' : '⚡ SINAL PARCIAL';
  const scoreBar    = '🟡'.repeat(Math.min(score, maxScore)) + '⚫'.repeat(Math.max(0, maxScore - score));
  const assetName   = assetCfg?.name || (sig.asset || '').toUpperCase();

  // Linhas de bonus
  const bonusLines = [];
  if (f?.insideBar)        bonusLines.push('⭐ Inside Bar confirmada');
  if (f?.volumeOk)         bonusLines.push('⭐ Volume acima da média');
  if (f?.bbSqueeze)        bonusLines.push('⭐ BB Squeeze (compressão)');
  if (f?.pullbackEma)      bonusLines.push('⭐ Pullback EMA20 com confirmação');
  if (f?.divConfirm)       bonusLines.push(`⭐ Divergência RSI/MACD confirmando ${direction}`);
  if (f?.ichimoku)         bonusLines.push(`⭐ Ichimoku: preço ${m?.ichimoku?.aboveKumo ? 'acima' : 'abaixo'} da Kumo + Tenkan/Kijun alinhados`);
  if (f?.vwapOk)           bonusLines.push(`⭐ VWAP ${direction === 'BUY' ? 'bullish' : 'bearish'}: ${m?.vwap?.value ?? '—'}`);
  if (f?.fibOk)            bonusLines.push(`⭐ Fibonacci ${m?.fibonacci?.nearLevel?.label ?? ''} — zona de retração chave`);
  if (f?.dxyOk)            bonusLines.push(`⭐ DXY ${m?.dxy?.trend === 'DOWN' ? '📉 caindo' : '📈 subindo'} — favorável para ${direction} em XAU`);
  if (f?.bias4hOk)         bonusLines.push(`⭐ Bias 4H confirma ${direction} — macro alinhada`);
  if (f?.fngOk)            bonusLines.push(`⭐ Fear & Greed ${m?.fearGreed?.emoji ?? ''} ${m?.fearGreed?.value ?? ''} (${m?.fearGreed?.classification ?? ''}) — sentimento confirma ${direction}`);
  if (f?.volumeData === false && f?.breakout20) bonusLines.push('⚠️ Breakout com volume fraco (-1 ponto)');
  if (f?.divOpposing)      bonusLines.push(`⚠️ Divergência ${direction === 'BUY' ? 'bearish' : 'bullish'} detectada — contra o trend`);
  if (f?.bias4hOpposing)   bonusLines.push(m?.bias4h?.warning || `⚠️ Macro 4H — ${direction} vai contra a tendência maior`);
  if (f?.fngOpposing && m?.fearGreed?.warning) bonusLines.push(m.fearGreed.warning);
  if (m?.ema200 && !m.ema200.aligned) bonusLines.push(m.ema200.warning);
  if (m?.ichimoku?.insideKumo) bonusLines.push('⚠️ Preço DENTRO da Kumo — zona de transição, cautela');
  if (m?.dxy?.warning)     bonusLines.push(m.dxy.warning);
  if (m?.cmeGap && !m.cmeGap.gapFilled) {
    const gapDir   = m.cmeGap.gapDirection === 'UP' ? '📈' : '📉';
    const aligned  = m.cmeGap.alignedWithSignal ? '✅ alinhado com o sinal' : '⚠️ contra o sinal';
    bonusLines.push(`${gapDir} CME Gap ${m.cmeGap.gapDirection} de ${m.cmeGap.gapPct}% — Fill: ${m.cmeGap.fillTarget} (${aligned})`);
  }

  const header = opts.header
    || `🤖 <b>AUTO-TRADE ABERTO</b> ${dirEmoji} — ${statusLabel}`;

  const lines = [
    header,
    ``,
    `<b>${assetName}</b> ${dirEmoji} <b>${direction}</b>  |  Score: ${score}/${maxScore}`,
    scoreBar,
    ``,
    `🎯 <b>Níveis</b>`,
    `Entry: <b>${L?.entry}</b>`,
    `Stop:  <b>${L?.sl}</b>  (-1.5×ATR)`,
    `Alvo:  <b>${L?.tp}</b>  (+3.0×ATR)`,
    `ATR: ${L?.atr}  |  R:R 1:2`,
    ``,
    `📋 <b>Filtros Base</b>`,
    `${f?.emaAligned  ? '✅' : '❌'} EMAs alinhadas (${entryTf})`,
    `${f?.breakout20  ? '✅' : '❌'} Breakout 30 barras`,
    `${f?.adxOk       ? '✅' : '❌'} ADX ${m?.adx ?? '—'} (≥25)`,
    `${f?.sessionOk   ? '✅' : '❌'} Sessão: ${m?.session ?? '—'}`,
    `${!f?.newsBlocked ? '✅' : '⚠️'} Notícias: ${f?.newsBlocked ? 'BLOQUEADO' : 'Livre'}`,
    ...(bonusLines.length > 0 ? [``, `🚀 <b>Filtros Bônus</b>`, ...bonusLines] : []),
    ...(oc ? [``, `🧭 <b>Contexto Operacional</b>`, `${oc.status} — ${oc.summary}`, oc.detail] : []),
    ``,
    `Bias: ${biasTf.toUpperCase()}  |  Entry: ${entryTf.toUpperCase()}`
      + (m?.bias4h ? `  |  Macro 4H: ${m.bias4h.trend}` : '')
      + (m?.fearGreed ? `  |  F&G: ${m.fearGreed.emoji ?? ''}${m.fearGreed.value ?? ''}` : ''),
    ...(opts.pyramidLabel ? [``, `🔺 ${opts.pyramidLabel}`] : []),
    ``,
    `⚙️ <i>Aberto automaticamente pelo bot</i>`,
    `⏰ ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
  ];

  return lines.join('\n');
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

function buildVipTelegramMessageUtf8(sig, assetCfg, opts = {}) {
  const { score, maxScore, direction, status, filters: f, levels: L, meta: m, operationalContext: oc } = sig;
  const entryTf = sig.entryTf || '15m';
  const biasTf = sig.biasTf || '1h';
  const dirEmoji = direction === 'BUY' ? '📈' : '📉';
  const statusLabel = status === 'VALID_SIGNAL' ? '✅ SINAL VÁLIDO' : '⚡ SINAL PARCIAL';
  const scoreBar = '🟡'.repeat(Math.min(score, maxScore)) + '⚫'.repeat(Math.max(0, maxScore - score));
  const assetName = assetCfg?.name || (sig.asset || '').toUpperCase();
  const footerLines = Array.isArray(opts.footerLines) && opts.footerLines.length
    ? opts.footerLines
    : ['⚠️ <i>Sinal detectado — sem confirmação de abertura no MT5</i>'];

  const bonusLines = [];
  if (f?.insideBar) bonusLines.push('⭐ Inside Bar confirmada');
  if (f?.volumeOk) bonusLines.push('⭐ Volume acima da média');
  if (f?.bbSqueeze) bonusLines.push('⭐ BB Squeeze (compressão)');
  if (f?.pullbackEma) bonusLines.push('⭐ Pullback EMA20 com confirmação');
  if (f?.divConfirm) bonusLines.push(`⭐ Divergência RSI/MACD confirmando ${direction}`);
  if (f?.ichimoku) bonusLines.push(`⭐ Ichimoku: preço ${m?.ichimoku?.aboveKumo ? 'acima' : 'abaixo'} da Kumo + Tenkan/Kijun alinhados`);
  if (f?.vwapOk) bonusLines.push(`⭐ VWAP ${direction === 'BUY' ? 'bullish' : 'bearish'}: ${m?.vwap?.value ?? '—'}`);
  if (f?.fibOk) bonusLines.push(`⭐ Fibonacci ${m?.fibonacci?.nearLevel?.label ?? ''} — zona de retração chave`);
  if (f?.dxyOk) bonusLines.push(`⭐ DXY ${m?.dxy?.trend === 'DOWN' ? '📉 caindo' : '📈 subindo'} — favorável para ${direction} em XAU`);
  if (f?.bias4hOk) bonusLines.push(`⭐ Bias 4H confirma ${direction} — macro alinhada`);
  if (f?.fngOk) bonusLines.push(`⭐ Fear & Greed ${m?.fearGreed?.emoji ?? ''} ${m?.fearGreed?.value ?? ''} (${m?.fearGreed?.classification ?? ''}) — sentimento confirma ${direction}`);
  if (f?.volumeData === false && f?.breakout20) bonusLines.push('⚠️ Breakout com volume fraco (-1 ponto)');
  if (f?.divOpposing) bonusLines.push(`⚠️ Divergência ${direction === 'BUY' ? 'bearish' : 'bullish'} detectada — contra o trend`);
  if (f?.bias4hOpposing) bonusLines.push(m?.bias4h?.warning || `⚠️ Macro 4H — ${direction} vai contra a tendência maior`);
  if (f?.fngOpposing && m?.fearGreed?.warning) bonusLines.push(m.fearGreed.warning);
  if (m?.ema200 && !m.ema200.aligned) bonusLines.push(m.ema200.warning);
  if (m?.ichimoku?.insideKumo) bonusLines.push('⚠️ Preço DENTRO da Kumo — zona de transição, cautela');
  if (m?.dxy?.warning) bonusLines.push(m.dxy.warning);
  if (m?.cmeGap && !m.cmeGap.gapFilled) {
    const gapDir = m.cmeGap.gapDirection === 'UP' ? '📈' : '📉';
    const aligned = m.cmeGap.alignedWithSignal ? '✅ alinhado com o sinal' : '⚠️ contra o sinal';
    bonusLines.push(`${gapDir} CME Gap ${m.cmeGap.gapDirection} de ${m.cmeGap.gapPct}% — Fill: ${m.cmeGap.fillTarget} (${aligned})`);
  }

  const header = opts.header || `🤖 <b>AUTO-TRADE ABERTO</b> ${dirEmoji} — ${statusLabel}`;

  return [
    header,
    '',
    `<b>${assetName}</b> ${dirEmoji} <b>${direction}</b>  |  Score: ${score}/${maxScore}`,
    scoreBar,
    '',
    `🎯 <b>Níveis</b>`,
    `Entry: <b>${L?.entry}</b>`,
    `Stop:  <b>${L?.sl}</b>  (-1.5×ATR)`,
    `Alvo:  <b>${L?.tp}</b>  (+3.0×ATR)`,
    `ATR: ${L?.atr}  |  R:R 1:2`,
    '',
    `📋 <b>Filtros Base</b>`,
    `${f?.emaAligned ? '✅' : '❌'} EMAs alinhadas (${entryTf})`,
    `${f?.breakout20 ? '✅' : '❌'} Breakout 30 barras`,
    `${f?.adxOk ? '✅' : '❌'} ADX ${m?.adx ?? '—'} (≥25)`,
    `${f?.sessionOk ? '✅' : '❌'} Sessão: ${m?.session ?? '—'}`,
    `${!f?.newsBlocked ? '✅' : '⚠️'} Notícias: ${f?.newsBlocked ? 'BLOQUEADO' : 'Livre'}`,
    ...(bonusLines.length > 0 ? ['', `🚀 <b>Filtros Bônus</b>`, ...bonusLines] : []),
    ...(oc ? ['', `🧭 <b>Contexto Operacional</b>`, `${oc.status} — ${oc.summary}`, oc.detail] : []),
    '',
    `Bias: ${biasTf.toUpperCase()}  |  Entry: ${entryTf.toUpperCase()}`
      + (m?.bias4h ? `  |  Macro 4H: ${m.bias4h.trend}` : '')
      + (m?.fearGreed ? `  |  F&G: ${m.fearGreed.emoji ?? ''}${m.fearGreed.value ?? ''}` : ''),
    ...(opts.pyramidLabel ? ['', `🔺 ${opts.pyramidLabel}`] : []),
    '',
    ...footerLines,
    `⏰ ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
  ].join('\n');
}

module.exports = {
  ALERT_COOLDOWN_MS,
  STARTUP_GRACE_MS,
  SERVER_START_AT,
  SIGNALS_FILE,
  lastSignals,
  saveLastSignals,
  sendTelegram,
  fmt,
  buildTelegramMessage,
  buildVipTelegramMessage: buildVipTelegramMessageUtf8,
};
