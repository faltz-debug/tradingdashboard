'use strict';

/**
 * src/services/context.js
 *
 * Camada de CONTEXTO operacional — sessoes de mercado + calendario economico.
 *
 * Extraido de server.js para eliminar o padrao setContextProviders em
 * signals.js / alerts.js. Esses modulos agora importam direto daqui, o que
 * remove a injecao manual no startup e torna a dependencia explicita no
 * topo de cada arquivo.
 *
 * Funcoes (ordenadas por dependencia):
 *
 *   SESSOES (puro, sem I/O):
 *     - getCurrentSessions()         → { tokyo, london, ny, overlap } booleans
 *     - getSessionInfo(assetKey)     → { isGood, sessionStr, sessions }
 *
 *   CALENDARIO ECONOMICO (I/O + cache compartilhado):
 *     - fetchEconomicCalendar()      → eventos high-impact (cache 30min)
 *     - generateRecurringEvents()    → fallback estatico (NFP/CPI/FOMC/ECB/BOJ)
 *     - getNewsStatus(assetKey)      → { isNearNews, nearName, nearTimeStr,
 *                                         nextEvent, totalRelevant }
 *     - getNewsCache()               → { data, updatedAt } (somente leitura)
 *
 * Estado interno:
 *   - newsCache (Map-like obj com data + updatedAt) — re-atribuido por
 *     fetchEconomicCalendar; getNewsCache devolve a referencia atual.
 *
 * Constantes exportadas (somente leitura, uteis em testes):
 *   - NEWS_CACHE_TTL                30min
 *   - NEWS_BUFFER_MS                janela de bloqueio +/-30min
 *   - RECURRING_HIGH_IMPACT         tabela de eventos estaticos
 *   - NEWS_CURRENCY_MAP             qual moeda afeta quais ativos
 *
 * @module services/context
 */

const axios  = require('axios');
const logger = require('../../logger');

const { SESSION_HOURS, ASSET_BEST_SESSIONS } = require('./state');

// ─── SESSOES DE MERCADO ──────────────────────────────────────────────────────

/**
 * Calcula quais sessoes de mercado estao ativas no momento atual (UTC).
 * @returns {Object<string, boolean>} { tokyo, london, ny, overlap }
 */
function getCurrentSessions() {
  const now = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  const active = {};
  for (const [name, s] of Object.entries(SESSION_HOURS)) {
    active[name] = utcH >= s.open && utcH < s.close;
  }
  return active;
}

/**
 * Devolve info de sessao para um ativo: se a sessao atual eh boa para o
 * ativo, label legivel ("🏛️ Londres + 🗽 NY") e mapa booleano.
 * @param {string} assetKey
 * @returns {{isGood:boolean, sessionStr:string, sessions:Object<string,boolean>}}
 */
function getSessionInfo(assetKey) {
  const sessions  = getCurrentSessions();
  const preferred = ASSET_BEST_SESSIONS[assetKey] || ['london', 'ny'];
  const isGood    = preferred.some(s => sessions[s]);

  const labels = { tokyo: '🗼 Tokyo', london: '🏛️ Londres', ny: '🗽 NY', overlap: '⚡ Overlap' };
  const activeLabels = Object.entries(sessions).filter(([, v]) => v).map(([k]) => labels[k] || k);
  const sessionStr   = activeLabels.length ? activeLabels.join(' + ') : '😴 Sem sessão';

  return { isGood, sessionStr, sessions };
}

// ─── CALENDARIO ECONOMICO ────────────────────────────────────────────────────

/**
 * Cache compartilhado do calendario. Eh REASIGNADO por fetchEconomicCalendar
 * (nao mutado in-place), entao callers que precisam da referencia atual
 * devem usar getNewsCache() em vez de capturar a variavel.
 */
let newsCache = { data: [], updatedAt: null };

const NEWS_CACHE_TTL = 30 * 60 * 1000;  // 30 minutos
const NEWS_BUFFER_MS = 30 * 60 * 1000;  // +/-30 min em torno do evento

/**
 * Eventos recorrentes de ALTO IMPACTO (UTC). Sempre existem como fallback,
 * independente da disponibilidade da API ForexFactory.
 *  - dayOfWeek:    0=dom..6=sab (NFP eh sex=5)
 *  - weekOfMonth:  1..5 (semana aproximada do mes)
 *  - hour/min:     UTC
 *  - months:       lista de meses 1-12 quando o evento ocorre (ex: FOMC 8x/ano)
 */
const RECURRING_HIGH_IMPACT = [
  // Mensais
  { name: 'NFP (Non-Farm Payrolls)', currency: 'USD', dayOfWeek: 5, weekOfMonth: 1, hour: 13, min: 30 },
  { name: 'CPI (Inflação EUA)',      currency: 'USD',                 weekOfMonth: 2, hour: 13, min: 30 },
  { name: 'Retail Sales EUA',        currency: 'USD',                 weekOfMonth: 3, hour: 13, min: 30 },
  { name: 'PPI (Produtor EUA)',      currency: 'USD',                 weekOfMonth: 2, hour: 13, min: 30 },
  // FOMC — 8x/ano (3a semana em jan, mar, mai, jun, jul, set, nov, dez)
  { name: 'FOMC Decision',           currency: 'USD', weekOfMonth: 3, hour: 19, min: 0, months: [1,3,5,6,7,9,11,12] },
  // ECB
  { name: 'ECB Rate Decision',       currency: 'EUR', weekOfMonth: 2, hour: 13, min: 15 },
  // BOJ
  { name: 'BOJ Rate Decision',       currency: 'JPY', weekOfMonth: 3, hour:  3, min:  0 },
];

/**
 * Quais ativos sao afetados por uma moeda do calendario.
 * 'ALL' eh o fallback quando o feed traz uma moeda nao mapeada.
 */
const NEWS_CURRENCY_MAP = {
  USD: ['xauusd', 'btc', 'eurusd', 'usdjpy'],
  EUR: ['eurusd'],
  JPY: ['usdjpy'],
  GBP: [],
  ALL: ['xauusd', 'btc', 'eurusd', 'usdjpy'],
};

/**
 * Busca eventos high-impact via ForexFactory (faireconomy.media). Cache de
 * 30min. Em caso de falha (timeout/HTTP), devolve eventos recorrentes
 * gerados localmente para que getNewsStatus continue funcionando.
 *
 * INFLIGHT LOCK: o scheduler chama esta função para os 4 ativos quase
 * simultaneamente. Sem lock, os 4 passariam pelo check de cache (ainda vazio),
 * disparariam 4 requests paralelos e receberiam 429 do endpoint. Com o lock,
 * apenas 1 request é feito; os outros aguardam a mesma Promise.
 *
 * @returns {Promise<Array<{name,currency,time,impact}>>}
 */
let _calendarFetchInFlight = null;

async function fetchEconomicCalendar() {
  const now = Date.now();
  if (newsCache.updatedAt && (now - newsCache.updatedAt) < NEWS_CACHE_TTL && newsCache.data.length > 0) {
    return newsCache.data;
  }

  // Se já há um fetch em andamento, aguarda o mesmo (evita requests paralelos)
  if (_calendarFetchInFlight) return _calendarFetchInFlight;

  _calendarFetchInFlight = _doFetchCalendar().finally(() => {
    _calendarFetchInFlight = null;
  });
  return _calendarFetchInFlight;
}

async function _doFetchCalendar() {
  const now = Date.now();
  // Tenta a API publica
  try {
    const res = await axios.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { timeout: 5000 });
    if (res.data && Array.isArray(res.data)) {
      const events = res.data
        .filter(e => e.impact === 'High')
        .map(e => ({
          name:     e.title || 'Evento',
          currency: e.country || 'USD',
          time:     new Date(e.date).getTime(),
          impact:   'HIGH',
        }))
        .filter(e => !isNaN(e.time));

      newsCache = { data: events, updatedAt: now };
      logger.info(`Calendário: ${events.length} eventos de alto impacto carregados`);
      return events;
    }
  } catch (err) {
    logger.warn(`Calendário API falhou: ${err.message} — usando recorrentes`);
  }

  // Fallback: eventos recorrentes
  const events = generateRecurringEvents();
  newsCache = { data: events, updatedAt: now };
  return events;
}

/**
 * Gera eventos recorrentes para os proximos 7 dias com base em
 * RECURRING_HIGH_IMPACT. Usado como fallback quando a API esta offline.
 * @returns {Array<{name,currency,time,impact}>}
 */
function generateRecurringEvents() {
  const now    = new Date();
  const events = [];

  for (let d = 0; d < 7; d++) {
    const date       = new Date(now);
    date.setUTCDate(date.getUTCDate() + d);
    const dayOfWeek  = date.getUTCDay();
    const dayOfMonth = date.getUTCDate();
    const monthNum   = date.getUTCMonth() + 1;
    const weekNum    = Math.ceil(dayOfMonth / 7);

    for (const evt of RECURRING_HIGH_IMPACT) {
      if (evt.dayOfWeek   !== undefined && dayOfWeek !== evt.dayOfWeek) continue;
      if (evt.weekOfMonth !== undefined && weekNum   !== evt.weekOfMonth) continue;
      if (evt.months      && !evt.months.includes(monthNum)) continue;

      const eventDate = new Date(date);
      eventDate.setUTCHours(evt.hour, evt.min, 0, 0);

      events.push({
        name:     evt.name,
        currency: evt.currency,
        time:     eventDate.getTime(),
        impact:   'HIGH',
      });
    }
  }
  return events;
}

/**
 * Status de noticia para um ativo:
 *   - isNearNews:    booleano — algum evento dentro de +/-NEWS_BUFFER_MS
 *   - nearName:      nome do evento proximo (se existir)
 *   - nearTimeStr:   "X min para começar" / "X min atrás"
 *   - nextEvent:     proximo evento futuro (nome + horario formatado)
 *   - totalRelevant: total de eventos da semana que afetam o ativo
 *
 * IMPORTANTE: le do newsCache em memoria — caller deve ter chamado
 * fetchEconomicCalendar() ao menos uma vez.
 *
 * @param {string} assetKey
 */
function getNewsStatus(assetKey) {
  const now    = Date.now();
  const events = newsCache.data || [];

  const relevant = events.filter(e => {
    const affectedAssets = NEWS_CURRENCY_MAP[e.currency] || NEWS_CURRENCY_MAP.ALL;
    return affectedAssets.includes(assetKey);
  });

  const nearEvent = relevant.find(e => Math.abs(e.time - now) <= NEWS_BUFFER_MS);
  const nextEvent = relevant
    .filter(e => e.time > now)
    .sort((a, b) => a.time - b.time)[0];

  const isNearNews  = !!nearEvent;
  const nearName    = nearEvent ? nearEvent.name : null;
  const nearTimeStr = nearEvent
    ? `${Math.abs(Math.round((nearEvent.time - now) / 60000))} min ${nearEvent.time > now ? 'para começar' : 'atrás'}`
    : null;

  return {
    isNearNews,
    nearName,
    nearTimeStr,
    nextEvent: nextEvent ? {
      name:      nextEvent.name,
      time:      new Date(nextEvent.time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      minsUntil: Math.round((nextEvent.time - now) / 60000),
    } : null,
    totalRelevant: relevant.length,
  };
}

/**
 * Devolve a REFERENCIA ATUAL do cache (nao um snapshot). Usado por
 * /api/news no system router para reportar idade do cache em min.
 * @returns {{ data: Array, updatedAt: number|null }}
 */
function getNewsCache() {
  return newsCache;
}

// ─── Helpers de teste ────────────────────────────────────────────────────────

/**
 * Reseta o cache de noticias — uso apenas em testes / debug.
 */
function _resetNewsCacheForTests() {
  newsCache = { data: [], updatedAt: null };
}

module.exports = {
  // Sessoes
  getCurrentSessions,
  getSessionInfo,
  // Calendario
  fetchEconomicCalendar,
  generateRecurringEvents,
  getNewsStatus,
  getNewsCache,
  // Constantes (somente leitura)
  NEWS_CACHE_TTL,
  NEWS_BUFFER_MS,
  RECURRING_HIGH_IMPACT,
  NEWS_CURRENCY_MAP,
  // Internals para tests
  _resetNewsCacheForTests,
};
