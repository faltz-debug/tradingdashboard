'use strict';

/**
 * DATA SOURCES — Busca e cache de dados de mercado.
 *
 * Este módulo centraliza todas as fontes de dados de candles e preços:
 *   - MT5 FTMO (bridge HTTP/arquivo JSON) — maior prioridade
 *   - Kraken REST (BTC, polling a cada 2min)
 *   - OANDA v3 (XAU/EUR/JPY, polling a cada 2min)
 *   - Finnhub (preço spot de todos os ativos, polling a cada 2min)
 *   - Twelve Data (fallback REST)
 *   - Simulação (fallback final — nunca gera sinal VIP)
 *
 * Prioridade de fonte por ativo:
 *   BTC:         MT5 → Kraken → Twelve Data → Simulação
 *   XAU/EUR/JPY: MT5 → OANDA  → Twelve Data → Simulação
 *
 * Funções exportadas principais:
 *   - getAsset(key)         → Promise<object>   busca dados com fallback automático
 *   - pollBtcKraken()       → Promise<void>     atualiza cache BTC via Kraken
 *   - loadBtcHistory()      → Promise<void>     carga inicial do BTC
 *   - pollOanda()           → Promise<void>     atualiza cache XAU/EUR/JPY via OANDA
 *   - pollFinnhub()         → Promise<void>     atualiza preço spot via Finnhub
 *
 * Utilitários exportados (usados em rotas do server.js):
 *   - normalizeEpochMs(v)   → number|null
 *   - getPreferredMt5Snapshot() → { snapshot, source }
 *   - readMt5SnapshotFromFile() → object|null
 *
 * Estado mutável exportado (usado em rota de push do bridge):
 *   - mt5BridgeState        → { remoteSnapshot, remoteReceivedAt, ... }
 *
 * Constantes de configuração exportadas (usadas em rotas/startup do server.js):
 *   - TWELVE_DATA_KEY, OANDA_API_KEY, OANDA_PRACTICE, OANDA_POLL_MS
 *   - FINNHUB_API_KEY, MT5_FEED_FILE, MT5_FEED_MAX_AGE_MS
 */

const path  = require('path');
const fs    = require('fs');
const axios = require('axios');

const logger  = require('../../logger');
const { calcEMA } = require('./indicators');  // usado em _buildDxyResult (não aqui, mas mantido por simetria)
const {
  ASSETS,
  CACHE_TTL_MS,
  cache,
  isCacheValid,
} = require('./state');

// ─── CONFIGURAÇÃO (env vars) ──────────────────────────────────────────────────

const TWELVE_DATA_KEY  = process.env.TWELVE_DATA_KEY  || 'COLE_SUA_CHAVE_AQUI';

const OANDA_API_KEY    = process.env.OANDA_API_KEY    || '';
const OANDA_PRACTICE   = process.env.OANDA_PRACTICE   !== 'false';  // padrão: demo
const OANDA_BASE       = OANDA_PRACTICE
  ? 'https://api-fxpractice.oanda.com'
  : 'https://api-fxtrade.oanda.com';
const OANDA_POLL_MS    = 2 * 60 * 1000;  // polling a cada 2 minutos
const OANDA_INSTRUMENT = { xauusd: 'XAU_USD', eurusd: 'EUR_USD', usdjpy: 'USD_JPY' };

const FINNHUB_API_KEY  = process.env.FINNHUB_API_KEY  || '';
const FINNHUB_SYMBOL   = {
  eurusd: 'OANDA:EUR_USD',
  usdjpy: 'OANDA:USD_JPY',
  xauusd: 'OANDA:XAU_USD',
  btc:    'BINANCE:BTCUSDT',
};

// __dirname aqui é src/services/ — sobe dois níveis para chegar na raiz do projeto
const _ROOT = path.resolve(__dirname, '../..');
const MT5_FEED_FILE       = process.env.MT5_FEED_FILE       || path.join(_ROOT, 'data', 'mt5_feed.json');
const MT5_FEED_MAX_AGE_MS = parseInt(process.env.MT5_FEED_MAX_AGE_MS || '3000', 10);

// ─── ESTADO MUTÁVEL ───────────────────────────────────────────────────────────

/**
 * Estado do bridge MT5. Exportado pois a rota POST /api/mt5/push escreve aqui.
 * Node.js singleton: server.js e este módulo compartilham o mesmo objeto.
 */
const mt5BridgeState = {
  remoteSnapshot:    null,
  remoteReceivedAt:  0,
  remoteSource:      null,
  lastPersistedAt:   0,
};

/**
 * Estado de saúde do feed MT5 por ativo (controla throttle de logs de atraso).
 * Interno — não precisa ser exportado.
 */
const mt5FeedHealthState = {};

// ─── UTILITÁRIO HTTP ──────────────────────────────────────────────────────────

/**
 * Wrapper de axios com retry exponencial.
 * Não retenta erros 4xx (exceto 429 Too Many Requests).
 *
 * @param {Function} fn         - Função que retorna uma Promise axios
 * @param {object}   opts
 * @param {number}   opts.maxRetries   - Número máximo de tentativas (padrão 3)
 * @param {number}   opts.baseDelayMs  - Delay base em ms, dobra a cada retry (padrão 1000)
 * @param {string}   opts.label        - Label para o log (padrão 'API')
 */
async function axiosWithRetry(fn, { maxRetries = 3, baseDelayMs = 1000, label = 'API' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      // 4xx (exceto 429 Too Many Requests) são erros definitivos — não adianta retentar
      if (status && status >= 400 && status < 500 && status !== 429) {
        logger.warn(`${label}: erro HTTP ${status} — não retentar`);
        throw err;
      }
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        logger.warn(`${label}: tentativa ${attempt}/${maxRetries} falhou (${err.message}) — retry em ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  logger.error(`${label}: todas as ${maxRetries} tentativas falharam — ${lastErr.message}`);
  throw lastErr;
}

// ─── MERCADO ABERTO/FECHADO ───────────────────────────────────────────────────

/**
 * Verifica se o mercado do ativo está aberto agora.
 * Forex/Ouro: fechado sexta 22:00 UTC → domingo 22:00 UTC.
 * BTC: sempre aberto (24/7/365).
 */
function isMarketOpen(key) {
  const cfg = ASSETS[key];
  if (cfg.alwaysOpen) return true;

  const now  = new Date();
  const day  = now.getUTCDay();    // 0=Dom, 1=Seg, ..., 5=Sex, 6=Sáb
  const hour = now.getUTCHours();

  if (day === 6)              return false;  // sábado inteiro → fechado
  if (day === 0 && hour < 22) return false;  // domingo antes das 22:00 UTC → fechado
  if (day === 5 && hour >= 22) return false; // sexta depois das 22:00 UTC → fechado

  return true;
}

/**
 * Monta payload de mercado fechado a partir do último cache disponível.
 * Não chama nenhuma API — reutiliza candles já em memória.
 */
function buildMarketClosedPayload(key) {
  const cfg    = ASSETS[key];
  const cached = cache[key].data;
  const basePrice = cached?.price || cfg.fallbackPrice;
  const now = Date.now();
  return {
    success:        true,
    source:         'Cache (Mercado Fechado)',
    isSimulation:   false,
    isMarketClosed: true,
    updatedAt:      now,
    nextUpdateAt:   now + 5 * 60 * 1000,
    price:          basePrice,
    bid:            cached?.bid    ?? null,
    ask:            cached?.ask    ?? null,
    spread:         cached?.spread ?? null,
    tick:           cached?.tick   ?? null,
    live:           cached?.live   ?? null,
    broker:         cached?.broker || null,
    symbol:         cached?.symbol || cfg.name,
    mode:           cached?.mode   || 'ANALYSIS_ONLY',
    isOperational:  cached?.isOperational === true,
    '15m':          cached?.['15m']   || [],
    '1h':           cached?.['1h']    || [],
    '4h':           cached?.['4h']    || [],
    'daily':        cached?.['daily'] || [],
    asset:          cfg.name,
  };
}

// ─── VALIDAÇÃO E NORMALIZAÇÃO DE CANDLES ─────────────────────────────────────

/**
 * Filtra candles inválidos (NaN, null, high < low).
 * Registra aviso no log se algum candle for removido.
 */
function validateCandles(candles, source) {
  if (!Array.isArray(candles)) return [];
  const valid = candles.filter(c => {
    if (!c || typeof c !== 'object') return false;
    if (isNaN(c.time) || isNaN(c.open) || isNaN(c.high) || isNaN(c.low) || isNaN(c.close)) return false;
    if (c.open === null || c.high === null || c.low === null || c.close === null) return false;
    if (c.high < c.low) return false;
    return true;
  });
  const removed = candles.length - valid.length;
  if (removed > 0) logger.warn(` ${source}: ${removed} candles inválidos removidos de ${candles.length}`);
  return valid;
}

/**
 * Agrega candles de 15m em timeframes maiores (1h, 4h, daily).
 * Usa o timestamp real da API para calcular o bucket correto.
 *
 * @param {Array}  candles        - Array de candles 15m
 * @param {number} periodSeconds  - Tamanho do período alvo em segundos (ex: 3600 = 1h)
 */
function agregateCandles(candles, periodSeconds) {
  if (!candles.length) return [];
  const groups = {};
  for (const c of candles) {
    const bucket = Math.floor(c.time / periodSeconds) * periodSeconds;
    if (!groups[bucket]) {
      groups[bucket] = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      groups[bucket].high  = Math.max(groups[bucket].high, c.high);
      groups[bucket].low   = Math.min(groups[bucket].low,  c.low);
      groups[bucket].close = c.close;
    }
  }
  return Object.values(groups).sort((a, b) => a.time - b.time);
}

/**
 * Normaliza um timestamp para milissegundos.
 * Aceita tanto segundos (< 1e12) quanto milissegundos (>= 1e12).
 */
function normalizeEpochMs(value) {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num < 1e12 ? Math.round(num * 1000) : Math.round(num);
}

/**
 * Normaliza candles vindos do bridge MT5 (formato com tickVolume).
 */
function normalizeMt5Candles(candles = []) {
  return validateCandles((candles || []).map(c => ({
    time:   parseInt(c.time),
    open:   parseFloat(c.open),
    high:   parseFloat(c.high),
    low:    parseFloat(c.low),
    close:  parseFloat(c.close),
    volume: c.tick_volume != null ? parseInt(c.tick_volume) : (c.tickVolume != null ? parseInt(c.tickVolume) : undefined),
  })), 'MT5 bridge');
}

/**
 * Gera candles sintéticos para simulação quando todas as fontes falham.
 * Retorna isSimulation: true — sinais VIP são bloqueados para esses dados.
 */
function generateFallback(basePrice, vol, dec) {
  const candles = []; let price = basePrice;
  const vol15m = vol * 0.25;
  for (let i = 600; i >= 0; i--) {
    const chg  = (Math.random() - 0.5) * vol15m;
    const open = price, close = price + chg;
    candles.push({
      time:  Math.floor((Date.now() - i * 900000) / 1000),
      open:  parseFloat(open.toFixed(dec)),
      high:  parseFloat((Math.max(open, close) + Math.random() * vol15m * 0.3).toFixed(dec)),
      low:   parseFloat((Math.min(open, close) - Math.random() * vol15m * 0.3).toFixed(dec)),
      close: parseFloat(close.toFixed(dec)),
    });
    price = close;
  }
  return {
    success:      true,
    source:       'Simulação (API indisponível)',
    isSimulation: true,
    price:        candles[candles.length - 1].close,
    '15m':        candles.slice(-300),
    '1h':         agregateCandles(candles, 3600),
    '4h':         agregateCandles(candles, 14400),
    'daily':      agregateCandles(candles, 86400),
  };
}

// ─── MT5 BRIDGE ───────────────────────────────────────────────────────────────

/**
 * Lê o snapshot MT5 do arquivo JSON em disco (fallback quando o push HTTP está offline).
 */
function readMt5SnapshotFromFile() {
  if (!fs.existsSync(MT5_FEED_FILE)) return null;
  try {
    const raw   = fs.readFileSync(MT5_FEED_FILE, 'utf8');
    if (!raw.trim()) return null;
    // Remove bytes nulos residuais (podem ocorrer em Windows)
    const clean = raw.replace(/\x00/g, '').trim();
    if (!clean) return null;
    return JSON.parse(clean);
  } catch (err) {
    logger.warn(`MT5 feed file: ${err.message}`);
    return null;
  }
}

/**
 * Retorna o snapshot MT5 preferido: push HTTP (se fresco) ou arquivo em disco.
 * @returns {{ snapshot: object|null, source: string|null }}
 */
function getPreferredMt5Snapshot() {
  const remote = mt5BridgeState.remoteSnapshot;
  // Use remoteReceivedAt (VPS server clock) instead of generatedAt (PC clock)
  // to avoid false staleness from PC clock drift.
  const remoteReceivedAt = mt5BridgeState.remoteReceivedAt;
  if (remote && remoteReceivedAt && (Date.now() - remoteReceivedAt) <= MT5_FEED_MAX_AGE_MS) {
    return { snapshot: remote, source: mt5BridgeState.remoteSource || 'bridge_push' };
  }
  const fileSnapshot = readMt5SnapshotFromFile();
  if (fileSnapshot) {
    return { snapshot: fileSnapshot, source: 'file_cache' };
  }
  return { snapshot: null, source: null };
}

/**
 * Converte um asset do snapshot MT5 para o formato padrão do dashboard.
 * Retorna null se o asset estiver ausente ou com dados atrasados.
 */
function buildMt5AssetData(key, parsed) {
  const asset = parsed?.assets?.[key];
  if (!asset) return null;

  const assetUpdatedAt = normalizeEpochMs(asset.updatedAt);
  const generatedAt    = normalizeEpochMs(parsed.generatedAt);
  const updatedAt      = assetUpdatedAt || generatedAt;
  if (!updatedAt) return null;

  const ageMs = Date.now() - updatedAt;
  if (ageMs > MT5_FEED_MAX_AGE_MS) {
    const state      = mt5FeedHealthState[key] || { staleLoggedAt: null, wasStale: false };
    const shouldLog  = !state.staleLoggedAt || (Date.now() - state.staleLoggedAt) >= 10000;
    if (shouldLog) {
      logger.warn(`MT5 feed atrasado (${key}): ${Math.round(ageMs / 1000)}s sem atualizacao`);
      state.staleLoggedAt = Date.now();
    }
    state.wasStale = true;
    mt5FeedHealthState[key] = state;
    return null;
  }

  if (mt5FeedHealthState[key]?.wasStale) {
    logger.info(`MT5 feed recuperado (${key}): ${Math.round(ageMs)}ms`);
  }
  mt5FeedHealthState[key] = { staleLoggedAt: null, wasStale: false };

  return {
    success:       true,
    source:        'MT5 FTMO',
    provider:      'mt5_ftmo',
    mode:          asset.mode || 'FTMO_SYNCED',
    isSimulation:  false,
    isRealTime:    true,
    isOperational: true,
    isLive:        asset.isLive !== false,
    broker:        asset.broker || parsed?.account?.company || 'FTMO',
    symbol:        asset.symbol || ASSETS[key]?.name || key.toUpperCase(),
    serverTime:    normalizeEpochMs(asset.serverTime) || updatedAt,
    updatedAt,
    nextUpdateAt:  updatedAt + MT5_FEED_MAX_AGE_MS,
    price:         Number(asset.price),
    bid:           asset.bid    != null ? Number(asset.bid)    : null,
    ask:           asset.ask    != null ? Number(asset.ask)    : null,
    spread:        asset.spread != null ? Number(asset.spread) : null,
    tick: {
      bid:   asset.tick?.bid   != null ? Number(asset.tick.bid)   : (asset.bid   != null ? Number(asset.bid)   : null),
      ask:   asset.tick?.ask   != null ? Number(asset.tick.ask)   : (asset.ask   != null ? Number(asset.ask)   : null),
      last:  asset.tick?.last  != null ? Number(asset.tick.last)  : null,
      time:  normalizeEpochMs(asset.tick?.time) || normalizeEpochMs(asset.serverTime) || updatedAt,
      flags: asset.tick?.flags != null ? Number(asset.tick.flags) : null,
    },
    live: {
      price:  Number(asset.price),
      bid:    asset.bid    != null ? Number(asset.bid)    : null,
      ask:    asset.ask    != null ? Number(asset.ask)    : null,
      spread: asset.spread != null ? Number(asset.spread) : null,
    },
    '15m':   normalizeMt5Candles(asset.candles?.['15m']   || []),
    '1h':    normalizeMt5Candles(asset.candles?.['1h']    || []),
    '4h':    normalizeMt5Candles(asset.candles?.['4h']    || []),
    'daily': normalizeMt5Candles(asset.candles?.['daily'] || []),
    asset:   ASSETS[key]?.name || key.toUpperCase(),
  };
}

/**
 * Tenta ler dados do ativo via bridge MT5 (push HTTP ou arquivo).
 * Retorna null se MT5 não está disponível ou dados estão atrasados.
 */
function readMt5FeedAsset(key) {
  if (key === 'btc') return null;  // BTC não vem do MT5
  try {
    const { snapshot } = getPreferredMt5Snapshot();
    if (!snapshot) return null;
    return buildMt5AssetData(key, snapshot);
  } catch (err) {
    logger.warn(`MT5 feed ${key}: ${err.message}`);
    return null;
  }
}

// ─── KRAKEN (BTC) ─────────────────────────────────────────────────────────────

/**
 * Busca candles de BTC via Kraken REST API (OHLC 15m).
 */
async function fetchBtcFromKraken() {
  const res = await axiosWithRetry(
    () => axios.get('https://api.kraken.com/0/public/OHLC', {
      params:  { pair: 'XBTUSD', interval: 15 },
      timeout: 12000,
    }),
    { maxRetries: 3, baseDelayMs: 1500, label: 'Kraken(BTC)' }
  );
  if (res.data.error?.length) throw new Error('Kraken: ' + res.data.error.join(', '));

  const raw = res.data.result?.XXBTZUSD;
  if (!raw?.length) throw new Error('Kraken: sem dados na resposta');

  // Kraken: [time, open, high, low, close, vwap, volume, count]
  const candles15m = validateCandles(raw.map(k => ({
    time:  parseInt(k[0]),
    open:  parseFloat(k[1]),
    high:  parseFloat(k[2]),
    low:   parseFloat(k[3]),
    close: parseFloat(k[4]),
  })), 'Kraken').slice(-500);
  if (candles15m.length < 10) throw new Error('Kraken: dados insuficientes após validação');

  const now = Date.now();
  return {
    success:      true,
    source:       '⚡ Kraken (2min polling)',
    isSimulation: false,
    isRealTime:   true,
    price:        candles15m[candles15m.length - 1].close,
    '15m':        candles15m,
    '1h':         agregateCandles(candles15m, 3600),
    '4h':         agregateCandles(candles15m, 14400),
    'daily':      agregateCandles(candles15m, 86400),
    asset:        'BTCUSD',
    updatedAt:    now,
    nextUpdateAt: now + 2 * 60 * 1000,
  };
}

/**
 * Executa uma rodada de polling do Kraken e atualiza o cache de BTC.
 * Falhas silenciosas — mantém o cache anterior.
 */
async function pollBtcKraken() {
  try {
    const data = await fetchBtcFromKraken();
    cache['btc'] = { data, updatedAt: Date.now() };
    logger.debug(`BTC Kraken: $${data.price.toFixed(0)}`);
  } catch (e) {
    logger.warn('Kraken poll BTC:', e.message, '— mantendo cache anterior');
  }
}

/** Carga inicial do histórico BTC via Kraken REST. */
async function loadBtcHistory() {
  await pollBtcKraken();
}

// ─── OANDA (XAU/EUR/JPY) ──────────────────────────────────────────────────────

/**
 * Busca candles de um ativo via OANDA v3 API (M15, 600 candles).
 */
async function fetchFromOanda(assetKey) {
  const instrument = OANDA_INSTRUMENT[assetKey];
  if (!instrument) throw new Error(`Instrumento OANDA não mapeado para: ${assetKey}`);

  const res = await axios.get(`${OANDA_BASE}/v3/instruments/${instrument}/candles`, {
    headers: { Authorization: `Bearer ${OANDA_API_KEY}` },
    params:  { granularity: 'M15', count: 600, price: 'M' },  // M = midpoint bid+ask
    timeout: 12000,
  });

  if (!res.data?.candles?.length) throw new Error('OANDA: sem candles na resposta');

  const all = validateCandles(
    res.data.candles
      .filter(c => c.complete)
      .map(c => ({
        time:  Math.floor(new Date(c.time).getTime() / 1000),
        open:  parseFloat(c.mid.o),
        high:  parseFloat(c.mid.h),
        low:   parseFloat(c.mid.l),
        close: parseFloat(c.mid.c),
      })),
    'OANDA'
  );

  if (all.length < 10) throw new Error('OANDA: dados insuficientes após validação');

  return {
    success:      true,
    source:       '⚡ OANDA (tempo real)',
    isSimulation: false,
    isRealTime:   true,
    price:        all[all.length - 1].close,
    '15m':        all.slice(-500),
    '1h':         agregateCandles(all, 3600),
    '4h':         agregateCandles(all, 14400),
    'daily':      agregateCandles(all, 86400),
  };
}

/**
 * Polling OANDA para XAU/EUR/JPY. Só roda se OANDA_API_KEY estiver configurada.
 */
async function pollOanda() {
  if (!OANDA_API_KEY) return;
  for (const key of ['xauusd', 'eurusd', 'usdjpy']) {
    if (!isMarketOpen(key)) continue;
    try {
      const cfg  = ASSETS[key];
      const now  = Date.now();
      const data = { ...await fetchFromOanda(key), asset: cfg.name, updatedAt: now };
      cache[key] = { data, updatedAt: now };
      logger.debug(`OANDA ${cfg.name}: ${data.price.toFixed(cfg.decimals)}`);
    } catch (e) {
      logger.warn(`OANDA poll ${key}: ${e.message}`);
    }
  }
}

// ─── FINNHUB (preço spot) ─────────────────────────────────────────────────────

/**
 * Polling Finnhub — atualiza SOMENTE o preço spot no cache existente (sem substituir candles).
 * Alternativa ao OANDA quando OANDA_API_KEY não está configurada.
 */
async function pollFinnhub() {
  if (!FINNHUB_API_KEY) return;
  for (const [key, symbol] of Object.entries(FINNHUB_SYMBOL)) {
    if (!isMarketOpen(key)) continue;
    try {
      const res = await axios.get('https://finnhub.io/api/v1/quote', {
        params:  { symbol, token: FINNHUB_API_KEY },
        timeout: 5000,
      });
      const quote = res.data;
      if (!quote || !quote.c || quote.c <= 0) continue;
      const currentPrice = parseFloat(quote.c);
      const entry = cache[key];
      if (entry?.data) {
        entry.data.price = currentPrice;
        entry.data.live  = {
          ...(entry.data.live || {}),
          price:  currentPrice,
          bid:    entry.data.bid    ?? null,
          ask:    entry.data.ask    ?? null,
          spread: entry.data.spread ?? null,
        };
        entry.data.finnhubUpdatedAt = Date.now();
        logger.debug(`Finnhub ${key}: ${currentPrice}`);
      }
    } catch (e) {
      logger.warn(`Finnhub poll ${key}: ${e.message}`);
    }
  }
}

// ─── TWELVE DATA (fallback REST) ──────────────────────────────────────────────

/**
 * Busca candles de 15m via Twelve Data API.
 * Usado como fallback quando MT5/OANDA não estão disponíveis.
 * Configurado com 1 retry e timeout curto para não bloquear o sinal VIP.
 */
async function fetchFromTwelveData(symbol) {
  const res = await axiosWithRetry(
    () => axios.get('https://api.twelvedata.com/time_series', {
      params:  { symbol, interval: '15min', outputsize: 600, apikey: TWELVE_DATA_KEY },
      timeout: 5000,
    }),
    { maxRetries: 1, baseDelayMs: 500, label: `TwelveData(${symbol})` }
  );
  if (!res.data?.values?.length) throw new Error('Sem dados');

  const intervalMs = 15 * 60 * 1000;
  const now = Date.now();
  const all = validateCandles(
    res.data.values.reverse().map(v => ({
      // Adiciona 'Z' para forçar parse como UTC (evita offset de fuso local)
      time:  Math.floor(new Date(v.datetime + 'Z').getTime() / 1000),
      open:  parseFloat(v.open),
      high:  parseFloat(v.high),
      low:   parseFloat(v.low),
      close: parseFloat(v.close),
    })).filter(c => ((c.time * 1000) + intervalMs) <= now),
    'TwelveData'
  );

  if (!all.length) throw new Error('Sem candles válidos na Twelve Data');

  return {
    success:      true,
    source:       'Twelve Data (candles fechados)',
    isSimulation: false,
    price:        all[all.length - 1].close,
    '15m':        all.slice(-500),
    '1h':         agregateCandles(all, 3600),
    '4h':         agregateCandles(all, 14400),
    'daily':      agregateCandles(all, 86400),
  };
}

// ─── GET ASSET (função principal) ─────────────────────────────────────────────

/**
 * Retorna dados de mercado para um ativo, com fallback automático entre fontes.
 *
 * Prioridade:
 *   1. MT5 FTMO (bridge HTTP ou arquivo) — maior confiabilidade e dados reais
 *   2. Cache real-time (Kraken/OANDA) — se fresco (< 5min)
 *   3. Cache normal (Twelve Data) — se dentro do TTL
 *   4. Mercado fechado — retorna cache sem chamar API
 *   5. OANDA — se configurado
 *   6. Twelve Data — fallback REST
 *   7. Simulação — último recurso (bloqueia sinal VIP)
 *
 * @param {string} key - Chave do ativo ('btc', 'xauusd', 'eurusd', 'usdjpy')
 * @returns {Promise<object>}
 */
async function getAsset(key) {
  const cfg = ASSETS[key];

  // 1. MT5 FTMO (maior prioridade)
  const mt5Data = readMt5FeedAsset(key);
  if (mt5Data) {
    // Preserva sinais calculados anteriormente (evita que o push WebSocket apague os signals)
    if (cache[key]?.data?.signals) mt5Data.signals = cache[key].data.signals;
    cache[key] = { data: mt5Data, updatedAt: mt5Data.updatedAt || Date.now() };
    return mt5Data;
  }

  // 2. Cache real-time (Kraken/OANDA atualizado por polling)
  const RT_TTL = 5 * 60 * 1000;
  if (
    cache[key].data?.isRealTime &&
    cache[key].updatedAt &&
    (Date.now() - cache[key].updatedAt) < RT_TTL &&
    (
      cache[key].data?.provider !== 'mt5_ftmo' ||
      (Date.now() - cache[key].updatedAt) < MT5_FEED_MAX_AGE_MS
    )
  ) {
    return cache[key].data;
  }

  // 3. Cache Twelve Data ainda válido
  if (isCacheValid(key)) return cache[key].data;

  // 4. Mercado fechado — não consome crédito da API
  if (!isMarketOpen(key)) {
    const payload    = buildMarketClosedPayload(key);
    const CLOSED_TTL = 5 * 60 * 1000;
    cache[key] = { data: payload, updatedAt: Date.now() - (CACHE_TTL_MS - CLOSED_TTL) };
    logger.debug(`${cfg.name}: mercado fechado — sem chamada à API`);
    return payload;
  }

  // 5. BTC via Kraken sob demanda (se o polling ainda nao aqueceu o cache)
  if (key === 'btc') {
    try {
      const now  = Date.now();
      const data = { ...await fetchBtcFromKraken(), asset: cfg.name, updatedAt: now, nextUpdateAt: now + 2 * 60 * 1000 };
      cache[key] = { data, updatedAt: now };
      logger.debug(`${cfg.name}: ${data.price.toFixed(cfg.decimals)} [Kraken on-demand]`);
      return data;
    } catch (krakenErr) {
      logger.warn(`Kraken ${key}: ${krakenErr.message} â€” tentando Twelve Data...`);
    }
  }

  // 6. OANDA (XAU/EUR/JPY se configurado)
  if (OANDA_API_KEY && OANDA_INSTRUMENT[key]) {
    try {
      const now  = Date.now();
      const data = { ...await fetchFromOanda(key), asset: cfg.name, updatedAt: now, nextUpdateAt: now + OANDA_POLL_MS };
      cache[key] = { data, updatedAt: now };
      logger.debug(`${cfg.name}: ${data.price.toFixed(cfg.decimals)} [OANDA]`);
      return data;
    } catch (oandaErr) {
      logger.warn(`OANDA ${key}: ${oandaErr.message} — tentando Twelve Data...`);
    }
  }

  // 7. Twelve Data (fallback REST)
  logger.debug(`Buscando ${cfg.name} via Twelve Data`);
  try {
    const now  = Date.now();
    const data = { ...await fetchFromTwelveData(cfg.symbol), asset: cfg.name, updatedAt: now, nextUpdateAt: now + CACHE_TTL_MS };
    cache[key] = { data, updatedAt: now };
    logger.debug(`${cfg.name}: ${data.price.toFixed(cfg.decimals)} [Twelve Data]`);
    return data;
  } catch (err) {
    logger.error(`${cfg.name} erro: ${err.message} — fallback simulação`);
    const now  = Date.now();
    const data = { ...generateFallback(cfg.fallbackPrice, cfg.vol, cfg.decimals), asset: cfg.name, updatedAt: now, nextUpdateAt: now + CACHE_TTL_MS };
    cache[key] = { data, updatedAt: now };
    return data;
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  // Constantes de configuração (usadas também em server.js)
  TWELVE_DATA_KEY,
  OANDA_API_KEY,
  OANDA_PRACTICE,
  OANDA_POLL_MS,
  FINNHUB_API_KEY,
  MT5_FEED_FILE,
  MT5_FEED_MAX_AGE_MS,

  // Estado mutável (rota MT5 push escreve aqui)
  mt5BridgeState,

  // Utilitários (usados em rotas de status do server.js)
  normalizeEpochMs,
  getPreferredMt5Snapshot,
  readMt5SnapshotFromFile,
  isMarketOpen,
  validateCandles,
  agregateCandles,

  // Funções de fetch e polling
  axiosWithRetry,
  fetchBtcFromKraken,
  pollBtcKraken,
  loadBtcHistory,
  fetchFromOanda,
  pollOanda,
  pollFinnhub,
  fetchFromTwelveData,
  generateFallback,

  // Função principal
  getAsset,
};
