require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');
const authStore = require('./authStore');

// Fonte única de verdade para parâmetros do Master Signal
// (compartilhado com backtester.html e dashboard.html via /signal-config.js)
const MASTER_SIGNAL_CFG = require('./signal-config');

// Logger estruturado com níveis e timestamps (configurável via LOG_LEVEL env var)
const logger = require('./logger');

const app = express();

// CORS: aceita o domínio do Railway + localhost para desenvolvimento
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function(origin, callback) {
    // Permite requisições sem origin (curl, mobile, Postman, server-to-server)
    if (!origin) return callback(null, true);
    // Permite localhost para desenvolvimento
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return callback(null, true);
    // Permite domínio Railway (*.up.railway.app)
    if (origin.endsWith('.up.railway.app')) return callback(null, true);
    // Permite origens configuradas via FRONTEND_ORIGIN
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Blocked by CORS'));
  },
  methods: ['GET', 'POST', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ── Segurança: bloqueia arquivos sensíveis ANTES do express.static ──────────
// O setHeaders vinha depois do match e causava ERR_HTTP_HEADERS_SENT.
// Middleware de bloqueio explícito resolve isso sem crash.
const BLOCKED_PATHS = new Set([
  '/server.js', '/tradestore.js', '/authstore.js',
  '/package.json', '/package-lock.json',
  '/start.sh', '/start.bat',
  '/.gitignore', '/.env',
]);
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (
    BLOCKED_PATHS.has(p) ||
    p.startsWith('/data/') ||
    p.startsWith('/node_modules/')
  ) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

// Serve apenas os arquivos estáticos (HTML/JS/CSS) da raiz
// dotfiles: 'deny' bloqueia .env e similares como camada extra
app.use(express.static('.', {
  index: 'dashboard.html',
  extensions: ['html'],
  dotfiles: 'deny',
}));

const VERSION          = '6.0.0';
const PORT             = process.env.PORT || 3000;
const TWELVE_DATA_KEY  = process.env.TWELVE_DATA_KEY  || 'COLE_SUA_CHAVE_AQUI';
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const VIP_TOKEN        = process.env.VIP_TOKEN        || '';
const ALLOW_PUBLIC_SIGNUP = process.env.ALLOW_PUBLIC_SIGNUP === 'true';
const DEFAULT_SIGNUP_ACCESS_STATUS = process.env.DEFAULT_SIGNUP_ACCESS_STATUS || 'trial';
const DEFAULT_SIGNUP_PLAN_CODE = process.env.DEFAULT_SIGNUP_PLAN_CODE || 'starter';
const ADMIN_EMAIL      = process.env.ADMIN_EMAIL      || '';
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD   || '';
const ADMIN_NAME       = process.env.ADMIN_NAME       || 'Admin';
const ADMIN_TELEGRAM   = process.env.ADMIN_TELEGRAM   || '';
const AUTO_BLOCK_WEAK_CONTEXT = process.env.AUTO_BLOCK_WEAK_CONTEXT !== 'false';
const CACHE_TTL_MS     = 15 * 60 * 1000;   // 15 minutos (fallback Twelve Data)

// ── OANDA (tempo real para XAU, EUR, JPY) ───────────────────────────────────
// OANDA_API_KEY: gere em https://www.oanda.com → My Account → API Access
// OANDA_PRACTICE: 'true' = conta demo (padrão) | 'false' = conta real
const OANDA_API_KEY   = process.env.OANDA_API_KEY  || '';
const OANDA_PRACTICE  = process.env.OANDA_PRACTICE !== 'false'; // padrão: demo
const OANDA_BASE      = OANDA_PRACTICE
  ? 'https://api-fxpractice.oanda.com'
  : 'https://api-fxtrade.oanda.com';
const OANDA_POLL_MS   = 2 * 60 * 1000;   // polling a cada 2 minutos

// Mapa ativo → instrumento OANDA (chaves devem bater com ASSETS)
const OANDA_INSTRUMENT = { xauusd: 'XAU_USD', eurusd: 'EUR_USD', usdjpy: 'USD_JPY' };

// ── FINNHUB (quotes em tempo real para forex — alternativa ao OANDA) ─────────
// Gratuito: https://finnhub.io → crie conta → API Keys → copie a chave
// Variável: FINNHUB_API_KEY no Railway
// Fornece preço spot atualizado para EUR/USD, USD/JPY, XAU/USD e BTC/USD
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || '';
// Mapa ativo → símbolo Finnhub (forex usa prefixo "OANDA:", BTC usa "BINANCE:")
const FINNHUB_SYMBOL = {
  eurusd: 'OANDA:EUR_USD',
  usdjpy: 'OANDA:USD_JPY',
  xauusd: 'OANDA:XAU_USD',
  btc:    'BINANCE:BTCUSDT',
};

// ── maxScore fixo por ativo (teórico máximo, não depende de disponibilidade de API) ──
// Score base 7 + bônus universais 7 + bônus específicos por ativo
const ASSET_MAX_SCORE = { eurusd: 14, usdjpy: 15, xauusd: 16, btc: 17 };

// ===== TELEGRAM ALERTS =====
const ALERT_COOLDOWN_MS  = 60 * 60 * 1000; // 1 hora entre alertas do mesmo ativo
const SIGNALS_FILE       = path.join(__dirname, 'data', 'lastSignals.json');
// Grace period: ignora primeiro ciclo de alertas após restart para evitar spam
const STARTUP_GRACE_MS   = 2 * 60 * 1000;
const SERVER_START_AT    = Date.now();

// Garante que a pasta data/ existe
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// Lê estado persistido do disco (sobrevive a crashes/restarts do container)
function loadLastSignals() {
  try {
    if (fs.existsSync(SIGNALS_FILE)) {
      const raw = fs.readFileSync(SIGNALS_FILE, 'utf8');
      const data = JSON.parse(raw);
      logger.info('lastSignals restaurado do disco');
      return data;
    }
  } catch (e) {
    logger.warn('Erro ao ler lastSignals.json — iniciando vazio:', e.message);
  }
  return {};
}

// Salva estado no disco com atomic write (temp file + rename)
// Evita corrupção se o processo crashar durante a escrita
let _saveTimer = null;
let _saveInProgress = false;
function saveLastSignals() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    if (_saveInProgress) return; // evita escritas sobrepostas
    _saveInProgress = true;
    const tmpFile = SIGNALS_FILE + '.tmp';
    const data = JSON.stringify(lastSignals, null, 2);
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

// Guarda o último sinal enviado por ativo (evita mensagens repetidas)
const lastSignals = loadLastSignals();

// ===== RETRY COM BACKOFF EXPONENCIAL =====
// Envolve qualquer chamada axios em lógica de retry automático.
// Tenta até `maxRetries` vezes com espera crescente entre tentativas.
// Erros 4xx (exceto 429) não são retentados — são falhas definitivas.
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

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    }, { timeout: 8000 });
    logger.info('Telegram enviado');
  } catch (err) {
    // Loga e RELANÇA — quem chama decide se ignora ou propaga
    logger.error('Telegram erro:', err.response?.data?.description || err.message);
    throw err;
  }
}

// ===== CÁLCULO DE SINAIS (fonte única — dashboard consome via data.signals) =====
function calcEMA(closes, period) {
  if (!closes || closes.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length <= period) return 50; // dados insuficientes — retorna neutro
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcMACD(closes) {
  // MACD Line = EMA(12) - EMA(26)
  const k12 = 2 / 13, k26 = 2 / 27;
  let ema12 = closes[0], ema26 = closes[0];
  const macdArr = [];
  for (let i = 0; i < closes.length; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
    ema26 = closes[i] * k26 + ema26 * (1 - k26);
    macdArr.push(ema12 - ema26);
  }
  // Signal Line = EMA(9) do MACD, inicializada com SMA(9) dos primeiros 9 valores
  // Isso alinha com TradingView/MT5 e evita noise nos primeiros candles
  const k9 = 2 / 10;
  let sig;
  if (macdArr.length < 9) {
    sig = macdArr[macdArr.length - 1];
  } else {
    sig = macdArr.slice(0, 9).reduce((a, b) => a + b, 0) / 9; // SMA(9) seed
    for (let i = 9; i < macdArr.length; i++) {
      sig = macdArr[i] * k9 + sig * (1 - k9);
    }
  }
  return { macd: macdArr[macdArr.length - 1], signal: sig };
}

function calcBollinger(closes, period = 20) {
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: sma + 2 * std, mid: sma, lower: sma - 2 * std };
}

function calcATR(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const slice = trs.slice(-period);
  return slice.length > 0 ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
}

function calcADX(candles, period = 14) {
  // Precisa de pelo menos 2x o período de candles
  if (candles.length < period * 2 + 1) return { adx: 0, pdi: 0, mdi: 0 };

  const trs = [], pdms = [], mdms = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
    const ph = candles[i-1].high, pl = candles[i-1].low;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const upMove = h - ph, downMove = pl - l;
    pdms.push(upMove > downMove && upMove > 0 ? upMove : 0);
    mdms.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder smoothing: primeiro valor = soma dos primeiros `period` valores
  let sTR  = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = pdms.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = mdms.slice(0, period).reduce((a, b) => a + b, 0);

  const getDX = (tr, pdm, mdm) => {
    if (tr === 0) return 0;
    const pdi = 100 * pdm / tr, mdi = 100 * mdm / tr;
    return (pdi + mdi) === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
  };

  // Gera array de DX com smoothing Wilder
  const dxArr = [getDX(sTR, sPDM, sMDM)];
  for (let i = period; i < trs.length; i++) {
    sTR  = sTR  - sTR / period  + trs[i];
    sPDM = sPDM - sPDM / period + pdms[i];
    sMDM = sMDM - sMDM / period + mdms[i];
    dxArr.push(getDX(sTR, sPDM, sMDM));
  }

  // ADX = média suavizada do DX (Wilder)
  let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i]) / period;
  }

  const pdi = sTR > 0 ? 100 * sPDM / sTR : 0;
  const mdi = sTR > 0 ? 100 * sMDM / sTR : 0;
  return { adx: Math.min(100, adx), pdi, mdi };
}

// ===== SESSÕES DE MERCADO =====
// Sessões ideais por ativo (UTC)
const SESSION_HOURS = {
  tokyo:   { open: 0,  close: 9  },
  london:  { open: 7,  close: 16 },
  ny:      { open: 12, close: 21 },
  overlap: { open: 13, close: 16 },  // London + NY — maior volume
};

const ASSET_BEST_SESSIONS = {
  btc:    ['london', 'ny'],
  xauusd: ['overlap', 'london', 'ny'],
  eurusd: ['london', 'ny', 'overlap'],
  usdjpy: ['tokyo', 'london'],
};

function getCurrentSessions() {
  const now = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  const active = {};
  for (const [name, s] of Object.entries(SESSION_HOURS)) {
    active[name] = utcH >= s.open && utcH < s.close;
  }
  return active;
}

function getSessionInfo(assetKey) {
  const sessions = getCurrentSessions();
  const preferred = ASSET_BEST_SESSIONS[assetKey] || ['london', 'ny'];
  const isGood = preferred.some(s => sessions[s]);

  const labels = { tokyo: '🗼 Tokyo', london: '🏛️ Londres', ny: '🗽 NY', overlap: '⚡ Overlap' };
  const activeLabels = Object.entries(sessions).filter(([, v]) => v).map(([k]) => labels[k] || k);
  const sessionStr = activeLabels.length ? activeLabels.join(' + ') : '😴 Sem sessão';

  return { isGood, sessionStr, sessions };
}

// ===== CALENDÁRIO ECONÔMICO — Filtro de Notícias =====
// Cache do calendário
let newsCache = { data: [], updatedAt: null };
const NEWS_CACHE_TTL = 30 * 60 * 1000; // 30 minutos

// Calendário estático de eventos recorrentes de ALTO IMPACTO (horários UTC)
// Esses sempre existem independente da API
const RECURRING_HIGH_IMPACT = [
  // Mensais
  { name: 'NFP (Non-Farm Payrolls)',         currency: 'USD', dayOfWeek: 5, weekOfMonth: 1, hour: 13, min: 30 },
  { name: 'CPI (Inflação EUA)',              currency: 'USD', weekOfMonth: 2, hour: 13, min: 30 },
  { name: 'Retail Sales EUA',                currency: 'USD', weekOfMonth: 3, hour: 13, min: 30 },
  { name: 'PPI (Produtor EUA)',              currency: 'USD', weekOfMonth: 2, hour: 13, min: 30 },
  // FOMC — 8 vezes ao ano (3ª semana em jan, mar, mai, jun, jul, set, nov, dez)
  { name: 'FOMC Decision',                   currency: 'USD', weekOfMonth: 3, hour: 19, min: 0, months: [1,3,5,6,7,9,11,12] },
  // ECB
  { name: 'ECB Rate Decision',               currency: 'EUR', weekOfMonth: 2, hour: 13, min: 15 },
  // BOJ
  { name: 'BOJ Rate Decision',               currency: 'JPY', weekOfMonth: 3, hour: 3, min: 0 },
];

// Assets afetados por moeda
const NEWS_CURRENCY_MAP = {
  'USD': ['xauusd', 'btc', 'eurusd', 'usdjpy'],
  'EUR': ['eurusd'],
  'JPY': ['usdjpy'],
  'GBP': [],
  'ALL': ['xauusd', 'btc', 'eurusd', 'usdjpy'],
};

// Verifica se estamos próximos de notícia de alto impacto (±30min)
const NEWS_BUFFER_MS = 30 * 60 * 1000; // 30 minutos antes/depois

async function fetchEconomicCalendar() {
  const now = Date.now();
  if (newsCache.updatedAt && (now - newsCache.updatedAt) < NEWS_CACHE_TTL && newsCache.data.length > 0) {
    return newsCache.data;
  }

  // Tenta buscar da API gratuita (ForexFactory via faireconomy.media)
  try {
    const res = await axios.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { timeout: 5000 });

    if (res.data && Array.isArray(res.data)) {
      const events = res.data
        .filter(e => e.impact === 'High')
        .map(e => ({
          name: e.title || 'Evento',
          currency: e.country || 'USD',
          time: new Date(e.date).getTime(),
          impact: 'HIGH'
        }))
        .filter(e => !isNaN(e.time));

      newsCache = { data: events, updatedAt: now };
      logger.info(`Calendário: ${events.length} eventos de alto impacto carregados`);
      return events;
    }
  } catch (err) {
    logger.warn(`Calendário API falhou: ${err.message} — usando recorrentes`);
  }

  // Fallback: gerar eventos recorrentes baseados na data atual
  const events = generateRecurringEvents();
  newsCache = { data: events, updatedAt: now };
  return events;
}

function generateRecurringEvents() {
  const now = new Date();
  const events = [];

  // Verifica próximos 7 dias
  for (let d = 0; d < 7; d++) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + d);
    const dayOfWeek = date.getUTCDay(); // 0=dom, 5=sex
    const dayOfMonth = date.getUTCDate();
    const monthNum = date.getUTCMonth() + 1;
    const weekNum = Math.ceil(dayOfMonth / 7); // semana aprox

    for (const evt of RECURRING_HIGH_IMPACT) {
      if (evt.dayOfWeek !== undefined && dayOfWeek !== evt.dayOfWeek) continue;
      if (evt.weekOfMonth !== undefined && weekNum !== evt.weekOfMonth) continue;
      if (evt.months && !evt.months.includes(monthNum)) continue;

      const eventDate = new Date(date);
      eventDate.setUTCHours(evt.hour, evt.min, 0, 0);

      events.push({
        name: evt.name,
        currency: evt.currency,
        time: eventDate.getTime(),
        impact: 'HIGH'
      });
    }
  }
  return events;
}

function getNewsStatus(assetKey) {
  const now = Date.now();
  const events = newsCache.data || [];

  const relevant = events.filter(e => {
    const affectedAssets = NEWS_CURRENCY_MAP[e.currency] || NEWS_CURRENCY_MAP['ALL'];
    return affectedAssets.includes(assetKey);
  });

  // Verifica se algum evento está dentro da janela ±30min
  const nearEvent = relevant.find(e => Math.abs(e.time - now) <= NEWS_BUFFER_MS);

  // Próximo evento futuro
  const nextEvent = relevant
    .filter(e => e.time > now)
    .sort((a, b) => a.time - b.time)[0];

  const isNearNews = !!nearEvent;
  const nearName = nearEvent ? nearEvent.name : null;
  const nearTimeStr = nearEvent
    ? `${Math.abs(Math.round((nearEvent.time - now) / 60000))} min ${nearEvent.time > now ? 'para começar' : 'atrás'}`
    : null;

  return {
    isNearNews,
    nearName,
    nearTimeStr,
    nextEvent: nextEvent ? {
      name: nextEvent.name,
      time: new Date(nextEvent.time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      minsUntil: Math.round((nextEvent.time - now) / 60000)
    } : null,
    totalRelevant: relevant.length
  };
}

// ===== SUPORTE E RESISTÊNCIA (Swing Highs/Lows) =====
function calcSupportResistance(candles, lookback = 5) {
  // Detecta swing highs e swing lows
  // lookback = quantas velas dos dois lados verificar
  const supports = [];
  const resistances = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) isSwingHigh = false;
      if (candles[i - j].low <= c.low || candles[i + j].low <= c.low) isSwingLow = false;
    }

    if (isSwingHigh) resistances.push({ price: c.high, time: c.time, index: i });
    if (isSwingLow) supports.push({ price: c.low, time: c.time, index: i });
  }

  // Pega os 3 mais recentes de cada
  const topRes = resistances.slice(-3).reverse();
  const topSup = supports.slice(-3).reverse();

  // Nível mais próximo do preço atual
  const currentPrice = candles[candles.length - 1].close;
  const nearestRes = topRes.length ? topRes.reduce((a, b) => Math.abs(a.price - currentPrice) < Math.abs(b.price - currentPrice) ? a : b) : null;
  const nearestSup = topSup.length ? topSup.reduce((a, b) => Math.abs(a.price - currentPrice) < Math.abs(b.price - currentPrice) ? a : b) : null;

  return { supports: topSup, resistances: topRes, nearestSup, nearestRes };
}

// ===== DIVERGÊNCIA RSI E MACD =====
function detectDivergence(candles, period = 14) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // Calcula RSI array completo
  const rsiArr = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = 0; i <= period; i++) rsiArr.push(null);
  rsiArr[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsiArr[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  // MACD
  const k12 = 2 / 13, k26 = 2 / 27;
  let ema12 = closes[0], ema26 = closes[0];
  const macdArr = [];
  for (let i = 0; i < closes.length; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
    ema26 = closes[i] * k26 + ema26 * (1 - k26);
    macdArr.push(ema12 - ema26);
  }

  // Procura divergências nas últimas 30 velas
  const lookback = Math.min(30, candles.length - period - 2);
  const startIdx = candles.length - lookback;
  const divergences = [];

  // Swing highs e lows do preço (para detectar HH/HL e LH/LL)
  for (let i = Math.max(startIdx + 2, 2); i < candles.length - 2; i++) {
    if (rsiArr[i] === null) continue;

    // Swing High do preço
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && (i+2 >= candles.length || highs[i] > highs[i+2])) {
      // Procura swing high anterior do preço
      for (let j = i - 3; j >= Math.max(startIdx, 1); j--) {
        if (rsiArr[j] === null) continue;
        if (j + 1 < candles.length && highs[j] > highs[j-1] && highs[j] > highs[j+1]) {
          // Divergência Bearish: preço faz High mais alto, RSI faz high mais baixo
          if (highs[i] > highs[j] && rsiArr[i] < rsiArr[j]) {
            divergences.push({
              type: 'bearish_rsi',
              label: 'Divergência Bearish RSI',
              desc: 'Preço fez novo máximo, RSI caiu — possível reversão de baixa',
              index: i, time: candles[i].time,
              priceHigh: highs[i], rsiVal: rsiArr[i]
            });
          }
          // Divergência Bearish Regular MACD: preço faz HH, MACD faz LH (enfraquecimento)
          if (highs[i] > highs[j] && macdArr[i] < macdArr[j]) {
            divergences.push({
              type: 'bearish_macd',
              label: 'Divergência Bearish MACD',
              desc: 'Preço fez novo máximo, MACD caiu — possível reversão de baixa',
              index: i, time: candles[i].time,
              priceHigh: highs[i], macdVal: macdArr[i]
            });
          }
          break;
        }
      }
    }

    // Swing Low do preço
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && (i+2 >= candles.length || lows[i] < lows[i+2])) {
      for (let j = i - 3; j >= Math.max(startIdx, 1); j--) {
        if (rsiArr[j] === null) continue;
        if (j + 1 < candles.length && lows[j] < lows[j-1] && lows[j] < lows[j+1]) {
          // Divergência Bullish: preço faz Low mais baixo, RSI faz low mais alto
          if (lows[i] < lows[j] && rsiArr[i] > rsiArr[j]) {
            divergences.push({
              type: 'bullish_rsi',
              label: 'Divergência Bullish RSI',
              desc: 'Preço fez novo mínimo, RSI subiu — possível reversão de alta',
              index: i, time: candles[i].time,
              priceLow: lows[i], rsiVal: rsiArr[i]
            });
          }
          if (lows[i] < lows[j] && macdArr[i] > macdArr[j]) {
            divergences.push({
              type: 'bullish_macd',
              label: 'Divergência Bullish MACD',
              desc: 'Preço fez novo mínimo, MACD subiu — possível reversão de alta',
              index: i, time: candles[i].time,
              priceLow: lows[i], macdVal: macdArr[i]
            });
          }
          break;
        }
      }
    }
  }

  // Pega a mais recente de cada tipo
  const latest = {};
  for (const d of divergences) {
    if (!latest[d.type] || d.index > latest[d.type].index) latest[d.type] = d;
  }

  const hasBullish = !!latest['bullish_rsi'] || !!latest['bullish_macd'];
  const hasBearish = !!latest['bearish_rsi'] || !!latest['bearish_macd'];

  return {
    divergences: Object.values(latest),
    hasBullish,
    hasBearish,
    signal: hasBullish && !hasBearish ? 'BULLISH' : hasBearish && !hasBullish ? 'BEARISH' : hasBullish && hasBearish ? 'MISTO' : 'NENHUM'
  };
}

function classifyMasterScore(score) {
  if (score >= 3) return 'FORTE COMPRA';
  if (score === 2) return 'COMPRA MODERADA';
  if (score <= -3) return 'FORTE VENDA';
  if (score === -2) return 'VENDA MODERADA';
  return 'NEUTRO';
}

function buildSignalAudit(signal, assetKey) {
  const sessionInfo = getSessionInfo(assetKey);
  const newsInfo = getNewsStatus(assetKey);
  const votes = [
    { key: 'trend', name: 'EMA Tendência', signal: signal.trendSig },
    { key: 'momentum', name: 'RSI Momentum', signal: signal.rsiTrendSig },
    { key: 'breakout', name: 'Breakout 20', signal: signal.bkSig },
  ];
  const blockers = [];
  if (!signal.adxOk) blockers.push(`ADX baixo (${signal.adx.toFixed(1)})`);
  if (!sessionInfo.isGood) blockers.push(`Fora da sessão ideal (${sessionInfo.sessionStr})`);
  if (newsInfo.isNearNews) blockers.push(`Notícia próxima: ${newsInfo.nearName || 'alto impacto'}`);
  if (signal.bkSig === 'AGUARDAR') blockers.push('Sem breakout confirmado');
  if (signal.rsiTrendSig === 'NEUTRO') blockers.push(`RSI neutro (${signal.rsi.toFixed(1)})`);
  if (signal.trendSig === 'NEUTRO') blockers.push('EMAs sem alinhamento');

  return {
    regime: signal.adx >= 40 ? 'TREND_FORTE'
      : signal.adx >= 25 ? 'TREND_MODERADA'
      : signal.adx >= 15 ? 'TREND_FRACA'
      : 'LATERAL',
    scoreBeforeAdx: signal.rawScore,
    scoreAfterAdx: signal.score,
    labelBeforeAdx: classifyMasterScore(signal.rawScore),
    labelAfterAdx: signal.masterLabel,
    votes,
    bullishVotes: votes.filter(v => v.signal === 'COMPRA').map(v => v.name),
    bearishVotes: votes.filter(v => v.signal === 'VENDA').map(v => v.name),
    neutralVotes: votes.filter(v => !['COMPRA', 'VENDA'].includes(v.signal)).map(v => v.name),
    session: {
      isGood: sessionInfo.isGood,
      label: sessionInfo.sessionStr,
    },
    news: {
      isBlocked: newsInfo.isNearNews,
      name: newsInfo.nearName,
      time: newsInfo.nearTimeStr,
    },
    blockers,
  };
}

function getOperationalContext(assetKey, signal) {
  const fallback = {
    status: 'CAUTELA',
    summary: 'Operar com cautela',
    detail: 'Histórico contextual ainda insuficiente para reforçar o sinal.',
    contextLine: 'Sem amostra suficiente neste contexto',
    rows: [],
  };

  if (!assetKey || !signal) return fallback;

  const stats = tradeStore.getLiveSignalStats();
  const audit = signal.audit || null;
  const rows = [];
  const assetRow = stats.byAsset?.[assetKey];
  const regimeRow = stats.byRegime?.[audit?.regime];
  const sessionRow = stats.bySession?.[audit?.session?.label];

  if (assetRow) rows.push({ group: 'asset', label: 'ativo', name: assetKey.toUpperCase(), ...assetRow });
  if (regimeRow) rows.push({ group: 'regime', label: 'regime', name: audit?.regime, ...regimeRow });
  if (sessionRow) rows.push({ group: 'session', label: 'sessão', name: audit?.session?.label, ...sessionRow });

  const weakRow = rows.find(r => r.health === 'WEAK');
  const strongRow = rows
    .filter(r => r.health === 'STRONG')
    .sort((a, b) => (b.total - a.total) || (b.winRate - a.winRate))[0];
  const mixedRow = rows
    .filter(r => r.health === 'MIXED')
    .sort((a, b) => (b.total - a.total) || (b.winRate - a.winRate))[0];
  const lowSampleOnly = rows.length > 0 && rows.every(r => r.health === 'LOW_SAMPLE');

  const blockers = [];
  const cautions = [];

  if ((signal.score || 0) === 0) blockers.push('Sem consenso entre os filtros');
  if (audit?.news?.isBlocked) blockers.push('Notícia de alto impacto próxima');
  if (weakRow) blockers.push(`Contexto historicamente fraco em ${weakRow.label}`);

  if (!audit?.session?.isGood) cautions.push('Fora da sessão ideal');
  if (audit?.regime === 'LATERAL' || audit?.regime === 'TREND_FRACA') cautions.push('Regime fraco ou lateral');
  if (mixedRow) cautions.push(`Histórico misto em ${mixedRow.label}`);
  if (!rows.length || lowSampleOnly) cautions.push('Amostra histórica insuficiente');
  if (Math.abs(signal.score || 0) < 2) cautions.push('Score operacional ainda fraco');

  if (blockers.length) {
    const main = weakRow
      ? `${weakRow.label} ${weakRow.name} com WR ${weakRow.winRate}% em ${weakRow.total} sinais`
      : blockers[0];
    return {
      status: 'EVITAR',
      summary: 'Evitar entrada agora',
      detail: main,
      contextLine: blockers.join(' | '),
      rows,
    };
  }

  const highConviction = Math.abs(signal.score || 0) >= 2
    && !!strongRow
    && audit?.session?.isGood
    && !audit?.news?.isBlocked
    && ['TREND_FORTE', 'TREND_MODERADA'].includes(audit?.regime);

  if (highConviction) {
    return {
      status: 'OPERAR',
      summary: 'Contexto favorável para operar',
      detail: `${strongRow.label} ${strongRow.name} com WR ${strongRow.winRate}% em ${strongRow.total} sinais`,
      contextLine: `Histórico forte neste contexto | ${strongRow.label} ${strongRow.name}`,
      rows,
    };
  }

  return {
    status: 'CAUTELA',
    summary: 'Operar com cautela',
    detail: cautions[0] || 'O sinal existe, mas o contexto ainda não é dos melhores.',
    contextLine: cautions.join(' | ') || 'Contexto misto ou amostra reduzida',
    rows,
  };
}

function computeSignals(candles15m, assetName, dec, tf = '15M') {
  const closes = candles15m.map(c => c.close);
  const last   = closes.length - 1;
  const price  = closes[last];

  const ema9  = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const rsi   = calcRSI(closes, 14);
  const { macd, signal: macdSig } = calcMACD(closes);
  const bb    = calcBollinger(closes, 20);

  // 1. EMA Tendência
  const aligned   = ema9 > ema20 && ema20 > ema50;
  const trendSig  = aligned ? 'COMPRA' : ema9 < ema20 && ema20 < ema50 ? 'VENDA' : 'NEUTRO';

  // 2. EMA Crossover
  const emaSig = ema9 > ema20 ? 'COMPRA' : 'VENDA';

  // 3. RSI Momentum — confirma força da tendência (≠ RSI Reversão que usa 30/70)
  const rsiTrendSig = rsi > MASTER_SIGNAL_CFG.rsiBullish ? 'COMPRA'
                    : rsi < MASTER_SIGNAL_CFG.rsiBearish ? 'VENDA' : 'NEUTRO';

  // 4. Breakout (exclui vela atual — senão close nunca > próprio high)
  const prevCandles = candles15m.slice(-(MASTER_SIGNAL_CFG.breakoutLookback + 1), -1);
  const bkHigh = prevCandles.length ? Math.max(...prevCandles.map(c => c.high)) : price;
  const bkLow  = prevCandles.length ? Math.min(...prevCandles.map(c => c.low))  : price;
  let bkSig = 'AGUARDAR';
  if (price > bkHigh) bkSig = 'COMPRA';
  else if (price < bkLow) bkSig = 'VENDA';

  // Master Signal: EMA Trend (direção) + RSI Momentum (força) + Breakout (nível)
  // MACD removido: zero edge comprovado (14.3M backtests). RSI tem WR 60-65% validado.
  const sigMap = { 'COMPRA': 1, 'VENDA': -1 };
  const rawScore = [trendSig, rsiTrendSig, bkSig].map(s => sigMap[s] || 0).reduce((a, b) => a + b, 0);

  // RSI + Bollinger (Reversão)
  const rsiSig = rsi < 30 ? 'COMPRA' : rsi > 70 ? 'VENDA' : 'NEUTRO';
  const rsiReversalAlert = (rsi < 30 && price <= bb.lower) || (rsi > 70 && price >= bb.upper);

  // Score máx = 3: ≥3 → FORTE, ==2 → MODERADA, ≤1 → NEUTRO
  let score = rawScore;
  let masterLabel = score >= 3 ? 'FORTE COMPRA' : score === 2 ? 'COMPRA MODERADA'
                    : score <= -3 ? 'FORTE VENDA' : score === -2 ? 'VENDA MODERADA' : 'NEUTRO';

  let masterEmoji = score >= 3 ? '🟢' : score === 2 ? '🟡'
                    : score <= -3 ? '🔴' : score === -2 ? '🟠' : '⚪';

  // ATR-based Entry / SL / TP
  const atr = calcATR(candles15m);
  let entry = price, sl = null, tp = null;
  if (score > 0) {
    sl = price - MASTER_SIGNAL_CFG.stopAtrMult * atr;
    tp = price + MASTER_SIGNAL_CFG.takeAtrMult * atr;
  } else if (score < 0) {
    sl = price + MASTER_SIGNAL_CFG.stopAtrMult * atr;
    tp = price - MASTER_SIGNAL_CFG.takeAtrMult * atr;
  }

  // ADX — força da tendência
  const { adx, pdi, mdi } = calcADX(candles15m);
  const adxTrend    = adx >= MASTER_SIGNAL_CFG.adxStrong ? 'FORTE' : adx >= MASTER_SIGNAL_CFG.adxTrendMin ? 'MODERADA' : adx >= 15 ? 'FRACA' : 'LATERAL';
  const adxOk       = adx >= MASTER_SIGNAL_CFG.adxTrendMin;
  const adxDir      = pdi > mdi ? '↑' : '↓';

  // S/R + Divergência
  if (!adxOk) {
    score = rawScore > 0 ? 1 : rawScore < 0 ? -1 : 0;
    masterLabel = score > 0 ? 'COMPRA FRACA (LATERAL)' : score < 0 ? 'VENDA FRACA (LATERAL)' : 'NEUTRO';
    masterEmoji = score > 0 ? '🟡' : score < 0 ? '🟠' : '⚪';
  }

  const sr = calcSupportResistance(candles15m);
  const div = detectDivergence(candles15m);
  const assetKey = Object.entries(ASSETS).find(([, cfg]) => cfg.name === assetName)?.[0] || null;
  // Alerta de divergência vs direção do Master Signal
  const masterDir = score > 0 ? 'BUY' : score < 0 ? 'SELL' : null;
  const divAlert = masterDir ? {
    confirming: masterDir === 'BUY'  ? div.hasBullish : div.hasBearish,
    opposing:   masterDir === 'BUY'  ? div.hasBearish : div.hasBullish,
    signal:     div.signal,
  } : null;

  const signal = {
    asset: assetName, price, dec, score, rawScore, masterLabel, masterEmoji, tf,
    trendSig, emaSig, rsiTrendSig, bkSig,
    rsi, rsiSig, rsiReversalAlert, bb,
    atr, entry, sl, tp, tfConfluence: [tf],
    adx, pdi, mdi, adxTrend, adxOk, adxDir,
    sr, div, divAlert,
  };
  if (assetKey) {
    signal.audit = buildSignalAudit(signal, assetKey);
    signal.operationalContext = getOperationalContext(assetKey, signal);
  }

  return signal;
}

function fmt(v, dec) {
  if (dec === 0) return '$' + Math.round(v).toLocaleString('pt-BR');
  return v.toFixed(dec);
}

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
  if (!s.adxOk)             filtros.push('⚠️ ADX baixo — mercado lateral');
  if (sessionInfo && !sessionInfo.isGood) filtros.push('⚠️ Fora da sessão ideal para este ativo');

  let msg = `${s.masterEmoji} <b>${s.asset} — ${s.masterLabel}</b>\n`;
  msg += `💰 Preço: <b>${fmt(s.price, s.dec)}</b>\n`;
  msg += `📊 Score: ${dir} ${s.score > 0 ? '+' : ''}${s.score}/3  [${scoreBar}]\n`;
  msg += `⏱ Timeframe: ${tfText}\n`;
  msg += `${adxText}\n`;
  if (sessionInfo) msg += `🕐 Sessão: ${sessionInfo.sessionStr}\n`;

  // Avisos filtros
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

  // S/R
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
    // Verifica se divergência confirma ou contradiz o sinal master
    const masterDir = s.score > 0 ? 'BUY' : s.score < 0 ? 'SELL' : null;
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

  // Alerta de Reversão
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

async function checkAndSendAlerts(key, data) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;

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
  const s = computeSignals(candles15m, cfg.name, cfg.decimals, '15M');

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
  const newsInfo = getNewsStatus(key);

  // Filtro 1 — ADX duro: se não há tendência (ADX < 25), suprime alerta de tendência
  // Aplica tanto a masterChanged quanto a reversalChanged (em mercado lateral, RSI
  // oscila entre extremos frequentemente e gera muitos falsos positivos)
  const adxBlocked = !s.adxOk;

  // Filtro 2 — Confluência 1H obrigatória para sinais de tendência (masterChanged)
  // Sem 1H concordando, o sinal de 15M tem probabilidade baixa de ser sustentável
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

  // ===== RISCO ADAPTATIVO =====
  // Lê estado de risco atual baseado em histórico de sinais ao vivo
  const riskState = tradeStore.getRiskState();

  // BLOCKED: sistema pausado, não emite sinal nenhum
  const riskBlocked = riskState.level === 'BLOCKED';

  // DEFENSIVE: só BTC e XAUUSD permitidos
  const riskAssetBlocked = riskState.level === 'DEFENSIVE'
    && riskState.allowedAssets !== null
    && !riskState.allowedAssets.includes(key);

  // Score mínimo por nível de risco (CAUTIOUS/DEFENSIVE exigem score 3)
  const riskScoreBlocked = Math.abs(s.score) < riskState.minScore;

  const riskFilterBlock = riskBlocked || riskAssetBlocked || riskScoreBlocked;

  if (riskFilterBlock) {
    const riskReason = riskBlocked
      ? `🛑 RISCO BLOQUEADO — ${riskState.reason}`
      : riskAssetBlocked
      ? `⚠️ Modo DEFENSIVO — ${key.toUpperCase()} suspenso (${riskState.reason})`
      : `⚠️ Score ${s.score} insuficiente para modo ${riskState.level} (mín: ${riskState.minScore})`;
    logger.info(riskReason);
  }

  // Envio de alerta de transição para modo BLOCKED (uma vez por ciclo de ativo)
  if (riskBlocked && masterChanged && !filterBlock) {
    const blockMsg = `🛑 *RISCO ADAPTATIVO — SISTEMA PAUSADO*\n\n`
      + `Motivo: ${riskState.reason}\n`
      + `Streak de perdas: ${riskState.streakLoss}\n`
      + `Drawdown atual: ${riskState.drawdownPct.toFixed(1)}%\n`
      + `Perdas hoje: ${riskState.dailyLoss}\n\n`
      + `Nenhum sinal será emitido até o sistema se recuperar.\n`
      + `Acompanhe o painel de risco em /api/risk-state`;
    try { await sendTelegram(blockMsg); } catch (_) {}
  }

  // Se notícia de alto impacto está muito próxima (±30min), avisa mas NÃO bloqueia
  // O trader decide — mas a info vai no alert

  const actionableLiveSignal = masterChanged && Math.abs(s.score) >= 2 && !filterBlock && !riskFilterBlock;
  if (actionableLiveSignal) {
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

// ===== ASSETS CONFIG =====
const ASSETS = {
  btc:    { symbol: 'BTC/USD',  name: 'BTCUSD',  fallbackPrice: 67000,  vol: 500,   decimals: 0, alwaysOpen: true  },
  xauusd: { symbol: 'XAU/USD',  name: 'XAUUSD',  fallbackPrice: 3300,   vol: 40,    decimals: 2, alwaysOpen: false },
  eurusd: { symbol: 'EUR/USD',  name: 'EURUSD',  fallbackPrice: 1.095,  vol: 0.004, decimals: 5, alwaysOpen: false },
  usdjpy: { symbol: 'USD/JPY',  name: 'USDJPY',  fallbackPrice: 160.0,  vol: 0.6,   decimals: 3, alwaysOpen: false },
};

// ===== DETECÇÃO DE MERCADO FECHADO =====
// Forex/Ouro: fechado sexta 22:00 UTC → domingo 22:00 UTC
// BTC: sempre aberto (24/7/365)
function isMarketOpen(key) {
  const cfg = ASSETS[key];
  if (cfg.alwaysOpen) return true;          // BTC nunca fecha

  const now    = new Date();
  const day    = now.getUTCDay();           // 0=Dom, 1=Seg, ..., 5=Sex, 6=Sab
  const hour   = now.getUTCHours();

  // Sábado inteiro → fechado
  if (day === 6) return false;
  // Domingo antes das 22:00 UTC → fechado
  if (day === 0 && hour < 22) return false;
  // Sexta depois das 22:00 UTC → fechado
  if (day === 5 && hour >= 22) return false;

  return true;
}

function buildMarketClosedPayload(key) {
  const cfg = ASSETS[key];
  const cached = cache[key].data;
  // Retorna o último dado real em cache (sem chamar a API) marcado como mercado fechado
  // Se não tiver cache, usa o último preço conhecido ou fallback mínimo
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
    // Mantém candles do cache se existirem — não gera dados falsos
    '15m':          cached?.['15m']  || [],
    '1h':           cached?.['1h']   || [],
    '4h':           cached?.['4h']   || [],
    'daily':        cached?.['daily']|| [],
    asset:          cfg.name,
  };
}

// ===== VALIDAÇÃO DE CANDLES (NaN/null guard) =====
// Filtra e valida candles recebidos de qualquer fonte de dados.
// Candles com valores NaN/null/undefined são removidos para não corromper indicadores.
function validateCandles(candles, source) {
  if (!Array.isArray(candles)) return [];
  const valid = candles.filter(c => {
    if (!c || typeof c !== 'object') return false;
    if (isNaN(c.time) || isNaN(c.open) || isNaN(c.high) || isNaN(c.low) || isNaN(c.close)) return false;
    if (c.open === null || c.high === null || c.low === null || c.close === null) return false;
    if (c.high < c.low) return false; // sanity check
    return true;
  });
  const removed = candles.length - valid.length;
  if (removed > 0) logger.warn(` ${source}: ${removed} candles inválidos removidos de ${candles.length}`);
  return valid;
}

// Cache genérico
const cache = {};
Object.keys(ASSETS).forEach(k => { cache[k] = { data: null, updatedAt: null }; });

function isCacheValid(key) {
  const e = cache[key];
  return e.data && e.updatedAt && (Date.now() - e.updatedAt) < CACHE_TTL_MS;
}

// ===== AGREGAR CANDLES =====
// periodSeconds: fronteira real em segundos (3600 = 1h, 14400 = 4h, 86400 = 1 dia)
// Agrupa cada candle no bucket correto usando o timestamp real da API,
// garantindo que velas de 1H comecem sempre na hora cheia, 4H a cada 4h, etc.
function agregateCandles(candles, periodSeconds) {
  if (!candles.length) return [];
  const groups = {};
  for (const c of candles) {
    const bucket = Math.floor(c.time / periodSeconds) * periodSeconds;
    if (!groups[bucket]) {
      groups[bucket] = {
        time:  bucket,
        open:  c.open,
        high:  c.high,
        low:   c.low,
        close: c.close
      };
    } else {
      if (c.high > groups[bucket].high) groups[bucket].high = c.high;
      if (c.low  < groups[bucket].low)  groups[bucket].low  = c.low;
      groups[bucket].close = c.close;   // close = último candle do bucket
    }
  }
  return Object.values(groups)
    .sort((a, b) => a.time - b.time)
    .slice(-200);
}

// ===== KRAKEN REST POLLING — BTC TEMPO REAL (substitui Binance bloqueado nos EUA) =====
// Kraken API pública: sem autenticação, sem bloqueio geográfico, candles de 15min gratuitos
// Docs: https://docs.kraken.com/api/docs/rest/get-ohlc-data
const btcWsConnected = false; // mantido para compatibilidade com /api/health

async function fetchBtcFromKraken() {
  const res = await axiosWithRetry(
    () => axios.get('https://api.kraken.com/0/public/OHLC', {
      params: { pair: 'XBTUSD', interval: 15 },
      timeout: 12000,
    }),
    { maxRetries: 3, baseDelayMs: 1500, label: 'Kraken(BTC)' }
  );
  if (res.data.error?.length) throw new Error('Kraken: ' + res.data.error.join(', '));

  // Kraken retorna { result: { XXBTZUSD: [[time,open,high,low,close,vwap,volume,count], ...], last: N } }
  const raw = res.data.result?.XXBTZUSD;
  if (!raw?.length) throw new Error('Kraken: sem dados na resposta');

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

async function pollBtcKraken() {
  try {
    const data = await fetchBtcFromKraken();
    cache['btc'] = { data, updatedAt: Date.now() };
    logger.debug(`BTC Kraken: $${data.price.toFixed(0)}`);
  } catch (e) {
    logger.warn('Kraken poll BTC:', e.message, '— mantendo cache anterior');
  }
}

// Alias para compatibilidade com o boot
async function loadBtcHistory() {
  await pollBtcKraken();
}
function connectBinanceWS() {
  // Binance bloqueado nos EUA (Railway us-west). Usando Kraken como fonte de BTC.
  logger.info('Binance desabilitado (bloqueio 451 EUA) — BTC via Kraken polling a cada 2min');
}

// ===== OANDA POLLING — XAU/EUR/JPY TEMPO REAL =====
async function fetchFromOanda(assetKey) {
  const instrument = OANDA_INSTRUMENT[assetKey];
  if (!instrument) throw new Error(`Instrumento OANDA não mapeado para: ${assetKey}`);

  const res = await axios.get(`${OANDA_BASE}/v3/instruments/${instrument}/candles`, {
    headers: { Authorization: `Bearer ${OANDA_API_KEY}` },
    params:  { granularity: 'M15', count: 600, price: 'M' }, // M = midpoint bid+ask
    timeout: 12000,
  });

  if (!res.data?.candles?.length) throw new Error('OANDA: sem candles na resposta');

  // Filtra só candles completos (não o candle atual ainda formando) + validação NaN
  const all = validateCandles(res.data.candles
    .filter(c => c.complete)
    .map(c => ({
      time:  Math.floor(new Date(c.time).getTime() / 1000),
      open:  parseFloat(c.mid.o),
      high:  parseFloat(c.mid.h),
      low:   parseFloat(c.mid.l),
      close: parseFloat(c.mid.c),
    })), 'OANDA');

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

async function pollOanda() {
  if (!OANDA_API_KEY) return; // sem chave configurada, não tenta
  for (const key of ['xauusd', 'eurusd', 'usdjpy']) {
    if (!isMarketOpen(key)) continue; // não consome rate limit fora do horário
    try {
      const cfg  = ASSETS[key];
      const data = { ...await fetchFromOanda(key), asset: cfg.name, updatedAt: Date.now() };
      cache[key] = { data, updatedAt: Date.now() };
      logger.debug(`OANDA ${cfg.name}: ${data.price.toFixed(cfg.decimals)}`);
    } catch (e) {
      logger.warn(`OANDA poll ${key}: ${e.message}`);
    }
  }
}

// ===== FINNHUB — quote em tempo real (alternativa ao OANDA para preço spot) =====
// Não fornece candles — só atualiza o preço corrente no cache (para exibição e SL/TP)
async function pollFinnhub() {
  if (!FINNHUB_API_KEY) return;
  for (const [key, symbol] of Object.entries(FINNHUB_SYMBOL)) {
    if (!isMarketOpen(key)) continue;
    try {
      const res = await axios.get('https://finnhub.io/api/v1/quote', {
        params: { symbol, token: FINNHUB_API_KEY },
        timeout: 5000,
      });
      const quote = res.data;
      // c = current price, h = high, l = low, o = open, pc = prev close
      if (!quote || !quote.c || quote.c <= 0) continue;
      const currentPrice = parseFloat(quote.c);
      // Injeta o preço atualizado no cache existente sem substituir os candles
      const entry = cache[key];
      if (entry?.data) {
        entry.data.price = currentPrice;
        entry.data.finnhubUpdatedAt = Date.now();
        // Atualiza o último close nos candles 15m para que o sinal use preço correto
        const candles15m = entry.data['15m'];
        if (candles15m?.length) {
          candles15m[candles15m.length - 1].close = currentPrice;
        }
        logger.debug(`Finnhub ${key}: ${currentPrice}`);
      }
    } catch (e) {
      logger.warn(`Finnhub poll ${key}: ${e.message}`);
    }
  }
}

// ===== BUSCA TWELVE DATA =====
async function fetchFromTwelveData(symbol) {
  // Busca velas de 15min — suficiente para agregar em 1h, 4h e daily
  const res = await axiosWithRetry(
    () => axios.get('https://api.twelvedata.com/time_series', {
      params: { symbol, interval: '15min', outputsize: 600, apikey: TWELVE_DATA_KEY },
      timeout: 10000,
    }),
    { maxRetries: 3, baseDelayMs: 2000, label: `TwelveData(${symbol})` }
  );
  if (!res.data?.values?.length) throw new Error('Sem dados');

  const intervalMs = 15 * 60 * 1000;
  const now = Date.now();
  const all = validateCandles(res.data.values.reverse().map(v => ({
    // Usa o datetime REAL retornado pela API (UTC). Adicionar 'Z' força parse como UTC.
    time:  Math.floor(new Date(v.datetime + 'Z').getTime() / 1000),
    open:  parseFloat(v.open),
    high:  parseFloat(v.high),
    low:   parseFloat(v.low),
    close: parseFloat(v.close)
  })).filter(c => ((c.time * 1000) + intervalMs) <= now), 'TwelveData');

  if (!all.length) throw new Error('Sem candles válidos na Twelve Data');

  return {
    success:      true,
    source:       'Twelve Data (candles fechados)',
    isSimulation: false,
    price:        all[all.length - 1].close,
    '15m':        all.slice(-500),
    '1h':         agregateCandles(all, 3600),    // 1h  = 3600s
    '4h':         agregateCandles(all, 14400),   // 4h  = 14400s
    'daily':      agregateCandles(all, 86400)    // 1d  = 86400s
  };
}

// ===== YAHOO FINANCE — FALLBACK GRATUITO (sem API key) =====
// Cobre XAU/USD, EUR/USD, USD/JPY e BTC sem nenhuma autenticação.
// Yahoo não tem rate limit público razoável para polling a cada 5min.
const YAHOO_SYMBOLS = {
  xauusd: 'XAUUSD=X',
  eurusd: 'EURUSD=X',
  usdjpy: 'USDJPY=X',
  btc:    'BTC-USD',
};

async function fetchFromYahoo(assetKey) {
  const symbol = YAHOO_SYMBOLS[assetKey];
  if (!symbol) throw new Error(`Yahoo: símbolo não mapeado para ${assetKey}`);

  const res = await axiosWithRetry(
    () => axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
      params:  { interval: '15m', range: '5d' },
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingDashboard/1.0)' },
      timeout: 12000,
    }),
    { maxRetries: 3, baseDelayMs: 1000, label: `Yahoo(${symbol})` }
  );

  const chart = res.data?.chart?.result?.[0];
  if (!chart) throw new Error('Yahoo: sem dados na resposta');

  const timestamps = chart.timestamp;
  const quotes     = chart.indicators?.quote?.[0];
  if (!timestamps?.length || !quotes) throw new Error('Yahoo: estrutura de dados inválida');

  const intervalMs = 15 * 60 * 1000;
  const now        = Date.now();

  const all = validateCandles(timestamps
    .map((t, i) => ({
      time:  t,
      open:  quotes.open[i],
      high:  quotes.high[i],
      low:   quotes.low[i],
      close: quotes.close[i],
    }))
    .filter(c => c.open !== null && c.high !== null && c.low !== null && c.close !== null)
    .filter(c => ((c.time * 1000) + intervalMs) <= now), 'Yahoo');

  if (all.length < 10) throw new Error('Yahoo: dados insuficientes após validação');

  return {
    success:      true,
    source:       '📊 Yahoo Finance',
    isSimulation: false,
    isRealTime:   false,
    price:        all[all.length - 1].close,
    '15m':        all.slice(-500),
    '1h':         agregateCandles(all, 3600),
    '4h':         agregateCandles(all, 14400),
    'daily':      agregateCandles(all, 86400),
  };
}

async function pollYahoo() {
  for (const key of ['xauusd', 'eurusd', 'usdjpy']) {
    if (!isMarketOpen(key)) continue;
    // Não substitui cache real-time (OANDA) ainda válido
    if (cache[key].data?.isRealTime && cache[key].updatedAt && (Date.now() - cache[key].updatedAt) < 5 * 60 * 1000) continue;
    try {
      const cfg  = ASSETS[key];
      const now  = Date.now();
      const data = { ...await fetchFromYahoo(key), asset: cfg.name, updatedAt: now, nextUpdateAt: now + 5 * 60 * 1000 };
      cache[key] = { data, updatedAt: now };
      logger.debug(`Yahoo ${cfg.name}: ${data.price.toFixed(cfg.decimals)}`);
    } catch (e) {
      logger.warn(`Yahoo poll ${key}: ${e.message}`);
    }
  }
}

// ===== FALLBACK =====
function generateFallback(basePrice, vol, dec) {
  const candles = []; let price = basePrice;
  const vol15m = vol * 0.25; // volatilidade menor para 15min
  for (let i = 600; i >= 0; i--) {
    const chg   = (Math.random() - 0.5) * vol15m;
    const open  = price, close = price + chg;
    candles.push({
      time:  Math.floor((Date.now() - i * 900000) / 1000), // 900000ms = 15min
      open:  parseFloat(open.toFixed(dec)),
      high:  parseFloat((Math.max(open, close) + Math.random() * vol15m * 0.3).toFixed(dec)),
      low:   parseFloat((Math.min(open, close) - Math.random() * vol15m * 0.3).toFixed(dec)),
      close: parseFloat(close.toFixed(dec))
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
    'daily':      agregateCandles(candles, 86400)
  };
}

// ===== FETCH GENÉRICO COM CACHE =====
async function getAsset(key) {
  const cfg = ASSETS[key];

  // ── Fontes real-time têm prioridade: Binance (BTC) e OANDA (XAU/EUR/JPY) ──
  // Se o cache foi atualizado por WebSocket/OANDA nos últimos 5 minutos, usa direto.
  const RT_TTL = 5 * 60 * 1000;
  if (cache[key].data?.isRealTime && cache[key].updatedAt && (Date.now() - cache[key].updatedAt) < RT_TTL) {
    return cache[key].data;
  }

  // ── Cache normal (Twelve Data) ainda válido ──────────────────────────────
  if (isCacheValid(key)) return cache[key].data;

  // ── Mercado fechado: não consome crédito da API ──────────────────────────
  if (!isMarketOpen(key)) {
    const payload    = buildMarketClosedPayload(key);
    const CLOSED_TTL = 5 * 60 * 1000;
    cache[key] = { data: payload, updatedAt: Date.now() - (CACHE_TTL_MS - CLOSED_TTL) };
    logger.debug(`${cfg.name}: mercado fechado — sem chamada à API`);
    return payload;
  }

  // ── Tenta OANDA para XAU/EUR/JPY se chave configurada ───────────────────
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

  // ── Fallback 1: Yahoo Finance (gratuito, sem API key) ─────────────────────
  if (false && YAHOO_SYMBOLS[key]) {
    logger.debug(`Buscando ${cfg.name} via Yahoo Finance`);
    try {
      const now  = Date.now();
      const data = { ...await fetchFromYahoo(key), asset: cfg.name, updatedAt: now, nextUpdateAt: now + CACHE_TTL_MS };
      cache[key] = { data, updatedAt: now };
      logger.debug(`${cfg.name}: ${data.price.toFixed(cfg.decimals)} [Yahoo Finance]`);
      return data;
    } catch (yahooErr) {
      logger.warn(`Yahoo ${key}: ${yahooErr.message} — tentando Twelve Data...`);
    }
  }

  // ── Fallback 2: Twelve Data ───────────────────────────────────────────────
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

// ===== RATE LIMITING (sem dependência externa) =====
const rateLimitMap  = new Map();
const RATE_LIMIT    = 60;          // máximo de requisições
const RATE_WINDOW   = 60 * 1000;  // por janela de 1 minuto

function rateLimit(req, res, next) {
  const ip  = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = rateLimitMap.get(ip) || { count: 0, start: now };

  // Reseta janela se passou 1 minuto
  if (now - rec.start > RATE_WINDOW) {
    rec.count = 0;
    rec.start = now;
  }

  rec.count++;
  rateLimitMap.set(ip, rec);

  if (rec.count > RATE_LIMIT) {
    const retryAfter = Math.ceil((RATE_WINDOW - (now - rec.start)) / 1000);
    res.set('Retry-After', retryAfter);
    return res.status(429).json({ error: 'Too many requests', retryAfter });
  }

  next();
}

// Limpa IPs antigos a cada 5 minutos para não vazar memória
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW * 2;
  for (const [ip, rec] of rateLimitMap.entries()) {
    if (rec.start < cutoff) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

// ===== AUTENTICACAO / AUTORIZACAO =====
function getRequestIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function getRequestToken(req) {
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const queryToken = typeof req.query?.token === 'string' ? req.query.token.trim() : '';
  return bearer || queryToken || '';
}

function buildPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    accessStatus: user.accessStatus,
    planCode: user.planCode,
    hasVipAccess: !!user.hasVipAccess,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    profile: user.profile || {},
    sessionExpiresAt: user.sessionExpiresAt || null,
  };
}

function authenticateRequest(req, _res, next) {
  const token = getRequestToken(req);
  req.auth = null;

  if (!token) return next();

  if (VIP_TOKEN && token === VIP_TOKEN) {
    req.auth = {
      type: 'legacy_token',
      role: 'subscriber',
      hasVipAccess: true,
      user: {
        id: 'legacy-vip-token',
        email: 'legacy-token@local',
        role: 'subscriber',
        accessStatus: 'active',
        planCode: 'legacy',
        hasVipAccess: true,
        profile: { name: 'Legacy VIP Token' },
      }
    };
    return next();
  }

  const user = authStore.getUserBySessionToken(token);
  if (user) {
    req.auth = {
      type: 'session',
      role: user.role,
      hasVipAccess: !!user.hasVipAccess,
      user,
      token,
    };
  }

  next();
}

function requireAuth(req, res, next) {
  if (!req.auth?.user) {
    return res.status(401).json({ success: false, error: 'Autenticacao obrigatoria' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.auth?.user || req.auth.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Acesso restrito a admin' });
  }
  next();
}

function requireVipAccess(req, res, next) {
  if (!req.auth?.user) {
    return res.status(401).json({ success: false, error: 'Autenticacao obrigatoria' });
  }
  if (req.auth.role === 'admin' || req.auth.hasVipAccess) return next();
  return res.status(403).json({
    success: false,
    error: 'Plano sem acesso VIP',
    detail: 'Ative um plano com acesso VIP para usar esta rota',
  });
}

function bootstrapAdminAccount() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    logger.info('Bootstrap admin desativado - defina ADMIN_EMAIL e ADMIN_PASSWORD para criar o primeiro admin');
    return;
  }

  try {
    const admin = authStore.ensureBootstrapAdmin({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      name: ADMIN_NAME,
      telegramHandle: ADMIN_TELEGRAM,
      planCode: 'vip',
    });

    if (admin) {
      logger.info(`Bootstrap admin pronto: ${admin.email} (${admin.role}/${admin.accessStatus})`);
    }
  } catch (err) {
    logger.error(`Falha ao bootstrapar admin: ${err.message}`);
  }
}

app.use(authenticateRequest);

// ===== SINAIS NA RESPOSTA DA API =====
// Computa e anexa sinais ao payload antes de devolver ao frontend
// Elimina a duplicação de lógica entre server.js e dashboard.html
function attachSignals(data, key) {
  const cfg = ASSETS[key];
  if (data.isSimulation || data.isMarketClosed || !data['15m']?.length) return data;
  try {
    const s15   = computeSignals(data['15m'], cfg.name, cfg.decimals, '15M');
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

// ===== ÁREA VIP — MOTOR DE SINAL =====
const tradeStore = require('./tradeStore');

/**
 * Verifica se as EMAs estão alinhadas para a direção dada
 * BUY:  ema9 > ema20 > ema50
 * SELL: ema9 < ema20 < ema50
 */
function emaAligned(closes, direction) {
  const ema9  = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  if (!ema9 || !ema20 || !ema50) return false;
  if (direction === 'BUY')  return ema9 > ema20 && ema20 > ema50;
  if (direction === 'SELL') return ema9 < ema20 && ema20 < ema50;
  return false;
}

/**
 * Verifica breakout das últimas N velas (fecha acima/abaixo do máximo/mínimo anterior)
 * BUY:  close > max(highs) dos últimos N bars
 * SELL: close < min(lows) dos últimos N bars
 */
function hasBreakout(candles, direction, bars = 20) {
  if (candles.length < bars + 1) return false;
  const lookback = candles.slice(candles.length - bars - 1, candles.length - 1);
  const last = candles[candles.length - 1];
  if (direction === 'BUY')  return last.close > Math.max(...lookback.map(c => c.high));
  if (direction === 'SELL') return last.close < Math.min(...lookback.map(c => c.low));
  return false;
}

/**
 * FILTRO BÔNUS 1 — Inside Bar (Compressão)
 * Detecta padrão de 3 velas: mãe → inside bar → confirmação de rompimento
 *   candles[-3] = vela mãe (maior range)
 *   candles[-2] = inside bar (contida dentro da mãe)
 *   candles[-1] = confirmação (fecha acima da máxima da mãe em BUY, abaixo da mínima em SELL)
 *
 * Por que funciona: inside bar = compressão de volatilidade. O mercado "respira" antes de
 * uma decisão direcional. Quando o preço rompe a mãe com confirmação de fechamento,
 * o movimento tende a ser mais limpo que um breakout simples de 30 períodos.
 */
function hasInsideBar(candles, direction) {
  if (candles.length < 3) return false;
  const mother  = candles[candles.length - 3];
  const inside  = candles[candles.length - 2];
  const confirm = candles[candles.length - 1];

  // inside bar deve estar totalmente contida dentro da vela mãe
  const isInsideBar = inside.high <= mother.high && inside.low >= mother.low;
  if (!isInsideBar) return false;

  // confirmação deve fechar além do range da mãe na direção correta
  if (direction === 'BUY')  return confirm.close > mother.high;
  if (direction === 'SELL') return confirm.close < mother.low;
  return false;
}

/**
 * FILTRO BÔNUS 2 — Confirmação de Volume
 * Verifica se o volume da vela atual está acima da média dos últimos 20 períodos.
 * Retorna null se não houver dados de volume disponíveis (sem penalidade).
 *
 * Por que importa: breakout com volume alto = mercado participando da direção.
 * Breakout com volume fraco = maior probabilidade de false breakout.
 * Para forex spot o volume é tick volume (proxy), mas ainda tem valor relativo.
 */
function hasVolumeConfirmation(candles, multiplier = 1.1) {
  if (candles.length < 21) return null;
  const current = candles[candles.length - 1];
  if (!current.volume || current.volume === 0) return null;  // sem dados → sem penalidade
  const lookback = candles.slice(-21, -1);
  const avgVol = lookback.reduce((sum, c) => sum + (c.volume || 0), 0) / lookback.length;
  if (avgVol === 0) return null;
  return current.volume >= avgVol * multiplier;
}

/**
 * FILTRO BÔNUS 3 — Bollinger Band Squeeze
 * Detecta compressão das Bollinger Bands: largura atual abaixo de 85% da média
 * dos últimos 20 cálculos. Indica mercado em consolidação antes de expansão.
 *
 * Por que funciona: squeeze + breakout = setup de maior qualidade.
 * O mercado "carrega energia" durante a compressão e libera no rompimento.
 * Especialmente relevante para EUR/USD (alta liquidez + padrões técnicos limpos).
 */
function hasBollingerSqueeze(closes, period = 20, lookbackWindows = 20) {
  if (closes.length < period + lookbackWindows) return false;

  const widths = [];
  // Calcula largura normalizada da BB para as últimas lookbackWindows+1 janelas
  for (let i = 0; i <= lookbackWindows; i++) {
    const end   = closes.length - i;
    const start = end - period;
    if (start < 0) break;
    const slice = closes.slice(start, end);
    const sma   = slice.reduce((a, b) => a + b, 0) / period;
    if (sma === 0) { widths.push(0); continue; }
    const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
    const std = Math.sqrt(variance);
    widths.push((4 * std) / sma);  // largura normalizada como % do preço
  }

  if (widths.length < 2) return false;
  const currentWidth = widths[0];  // i=0 → janela mais recente
  const avgWidth = widths.slice(1).reduce((a, b) => a + b, 0) / (widths.length - 1);

  // Squeeze: largura atual pelo menos 15% abaixo da média recente
  return currentWidth > 0 && avgWidth > 0 && currentWidth < avgWidth * 0.85;
}

/**
 * CONTEXTO MACRO — EMA 200 (XAU/USD)
 * Calcula EMA 200 e verifica se o preço está do lado correto para a direção.
 * Retorna null se dados insuficientes.
 * Não pontua no score — aparece como contexto operacional (aviso ou confirmação).
 */
function getEma200Context(candles, direction) {
  if (!candles || candles.length < 200) return null;
  const closes = candles.map(c => c.close);
  const ema200 = calcEMA(closes, 200);
  const price  = closes[closes.length - 1];
  const aligned = direction === 'BUY' ? price > ema200 : price < ema200;
  return { ema200: parseFloat(ema200.toFixed(2)), aligned };
}

/**
 * FILTRO BÔNUS — Ichimoku Cloud (Tenkan/Kijun + Kumo)
 * Especialmente eficaz para USD/JPY — par que historicamente respeita a Kumo.
 * Também usado por traders de BTC (análise técnica japonesa amplamente adotada).
 *
 * Tenkan-sen (9)  = (máx + mín) / 2 dos últimos 9 períodos  → linha de sinal rápido
 * Kijun-sen (26)  = (máx + mín) / 2 dos últimos 26 períodos → linha de sinal lento
 * Senkou Span A   = (Tenkan + Kijun) / 2                    → borda superior/inferior da Kumo
 * Senkou Span B   = (máx + mín) / 2 dos últimos 52 períodos → outra borda da Kumo
 *
 * BUY  confirmado: preço ACIMA da Kumo inteira + Tenkan > Kijun (cruzamento bullish)
 * SELL confirmado: preço ABAIXO da Kumo inteira + Tenkan < Kijun (cruzamento bearish)
 * Preço DENTRO da Kumo = mercado em transição, sem confirmação
 */
function calcIchimoku(candles, direction) {
  if (candles.length < 52) return null;

  const price    = candles[candles.length - 1].close;
  const p9       = candles.slice(-9);
  const p26      = candles.slice(-26);
  const p52      = candles.slice(-52);

  const tenkan   = (Math.max(...p9.map(c => c.high))  + Math.min(...p9.map(c => c.low)))  / 2;
  const kijun    = (Math.max(...p26.map(c => c.high)) + Math.min(...p26.map(c => c.low))) / 2;
  const spanA    = (tenkan + kijun) / 2;
  const spanB    = (Math.max(...p52.map(c => c.high)) + Math.min(...p52.map(c => c.low))) / 2;
  const kumoTop  = Math.max(spanA, spanB);
  const kumoBot  = Math.min(spanA, spanB);

  const aboveKumo = price > kumoTop;
  const belowKumo = price < kumoBot;
  const insideKumo = !aboveKumo && !belowKumo;

  let aligned = false;
  if (direction === 'BUY')  aligned = aboveKumo && tenkan > kijun;
  if (direction === 'SELL') aligned = belowKumo && tenkan < kijun;

  return {
    tenkan:     parseFloat(tenkan.toFixed(5)),
    kijun:      parseFloat(kijun.toFixed(5)),
    spanA:      parseFloat(spanA.toFixed(5)),
    spanB:      parseFloat(spanB.toFixed(5)),
    kumoTop:    parseFloat(kumoTop.toFixed(5)),
    kumoBot:    parseFloat(kumoBot.toFixed(5)),
    aboveKumo, belowKumo, insideKumo, aligned,
  };
}

/**
 * FILTRO BÔNUS — VWAP de Sessão (Volume Weighted Average Price)
 * Referência de "preço justo" do dia baseada em volume.
 *
 * Ancoragem: início do dia UTC (00:00 UTC) — reset automático a cada dia.
 * Preço típico = (high + low + close) / 3 por vela.
 * Para forex/XAU sem volume real: usa tick volume como proxy (ainda tem valor relativo).
 *
 * BUY:  preço > VWAP → mercado operando ACIMA do valor justo → pressão compradora
 * SELL: preço < VWAP → mercado operando ABAIXO do valor justo → pressão vendedora
 *
 * Retorna null se menos de 3 velas do dia disponíveis.
 */
function calcSessionVwap(candles, direction) {
  if (!candles || candles.length === 0) return null;

  const now = Date.now();
  const todayMidnight = now - (now % (24 * 60 * 60 * 1000));

  const todayCandles = candles.filter(c => {
    const ts = typeof c.timestamp === 'number' ? c.timestamp : new Date(c.timestamp).getTime();
    return ts >= todayMidnight;
  });

  if (todayCandles.length < 3) return null;

  let cumPV = 0, cumVol = 0;
  for (const c of todayCandles) {
    const typical = (c.high + c.low + c.close) / 3;
    const vol     = (c.volume && c.volume > 0) ? c.volume : 1;  // fallback: peso igual
    cumPV  += typical * vol;
    cumVol += vol;
  }

  if (cumVol === 0) return null;
  const vwap  = cumPV / cumVol;
  const price = todayCandles[todayCandles.length - 1].close;

  let aligned = false;
  if (direction === 'BUY')  aligned = price > vwap;
  if (direction === 'SELL') aligned = price < vwap;

  return {
    vwap:         parseFloat(vwap.toFixed(5)),
    aligned,
    candlesUsed:  todayCandles.length,
  };
}

/**
 * FILTRO BÔNUS — Pullback EMA20 com confirmação
 * Detecta quando o preço retornou à EMA20 numa tendência alinhada e formou
 * uma vela de confirmação forte na direção da tendência.
 *
 * Condições BUY:
 *   1. EMAs alinhadas: EMA9 > EMA20 > EMA50 (tendência bullish confirmada)
 *   2. Vela anterior tocou a EMA20 (dentro de ±0.4%)
 *   3. Vela atual é bullish forte: fecha acima do EMA9 com corpo expressivo
 *
 * Por que funciona: em tendências saudáveis, o preço recua à EMA20 antes de
 * continuar. Entrar no pullback vs no topo dá uma relação R:R muito melhor.
 * É mais seletivo que o breakout simples — filtra entradas em extensão.
 */
function hasPullbackEma20(candles, direction) {
  if (candles.length < 3) return false;

  const closes = candles.map(c => c.close);
  const ema9  = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);

  // 1. EMAs devem estar alinhadas para a direção
  const alignedBuy  = ema9 > ema20 && ema20 > ema50;
  const alignedSell = ema9 < ema20 && ema20 < ema50;
  if (direction === 'BUY'  && !alignedBuy)  return false;
  if (direction === 'SELL' && !alignedSell) return false;

  // 2. Vela anterior tocou a EMA20 (±0.4% de tolerância)
  const prev  = candles[candles.length - 2];
  const prevCloses = closes.slice(0, -1);
  const ema20prev  = calcEMA(prevCloses, 20);
  const touchedEma20 = Math.abs(prev.close - ema20prev) / (ema20prev || 1) < 0.004
                    || Math.abs(prev.low   - ema20prev) / (ema20prev || 1) < 0.004  // BUY: low tocou
                    || Math.abs(prev.high  - ema20prev) / (ema20prev || 1) < 0.004; // SELL: high tocou

  if (!touchedEma20) return false;

  // 3. Vela atual confirma: corpo expressivo na direção certa, fecha além da EMA9
  const curr      = candles[candles.length - 1];
  const bodySize  = Math.abs(curr.close - curr.open);
  const range     = curr.high - curr.low;
  const strongBody = range > 0 && bodySize / range >= 0.5;  // corpo ≥ 50% do range total

  if (direction === 'BUY')  return curr.close > curr.open && curr.close > ema9 && strongBody;
  if (direction === 'SELL') return curr.close < curr.open && curr.close < ema9 && strongBody;
  return false;
}

/**
 * CONTEXTO — CME Gap para BTC
 * Os futuros CME de Bitcoin fecham toda sexta ~21:00 UTC e reabrem domingo ~23:00 UTC.
 * Qualquer diferença de preço entre o fechamento de sexta e a abertura de domingo
 * é chamado de "CME Gap". Estatisticamente ~80% desses gaps são preenchidos.
 *
 * Retorna:
 *   gapDirection:    'UP' (preço abriu acima) | 'DOWN' (abriu abaixo)
 *   fillerDirection: direção que PREENCHE o gap ('BUY' para gap DOWN, 'SELL' para gap UP)
 *   gapFilled:       true se o preço atual já voltou à zona do gap
 *   fillTarget:      preço de fechamento da sexta (alvo de preenchimento)
 *
 * Não pontua diretamente — aparece como contexto estratégico no meta.
 * Mas quando a direção do sinal == fillerDirection, adiciona bônus de contexto.
 */
function detectCMEGap(candles) {
  if (!candles || candles.length < 10) return null;

  let fridayClose = null;
  let sundayOpen  = null;

  // Percorre candles do mais recente para o mais antigo
  for (let i = candles.length - 1; i >= 0; i--) {
    const c  = candles[i];
    const ts = typeof c.timestamp === 'number' ? c.timestamp : (c.time ? c.time * 1000 : null);
    if (!ts) continue;
    const d   = new Date(ts);
    const day = d.getUTCDay();   // 0=Dom, 1=Seg, ..., 5=Sex, 6=Sáb
    const hr  = d.getUTCHours();

    // Janela de fechamento CME: sexta 20:00-22:00 UTC
    if (day === 5 && hr >= 20 && hr <= 22 && !fridayClose) {
      fridayClose = { price: c.close, ts };
    }
    // Janela de reabertura CME: domingo 22:00-24:00 UTC
    if (day === 0 && hr >= 22 && !sundayOpen) {
      sundayOpen = { price: c.open ?? c.close, ts };
    }

    if (fridayClose && sundayOpen) break;
  }

  if (!fridayClose || !sundayOpen) return null;
  if (fridayClose.ts >= sundayOpen.ts) return null;  // ordem temporal inválida

  const gapSize = sundayOpen.price - fridayClose.price;
  const gapPct  = (gapSize / fridayClose.price) * 100;

  if (Math.abs(gapPct) < 0.3) return null;  // gap menor que 0.3% → irrelevante

  const currentPrice    = candles[candles.length - 1].close;
  const gapDirection    = gapSize > 0 ? 'UP' : 'DOWN';
  const fillerDirection = gapDirection === 'DOWN' ? 'BUY' : 'SELL';

  // Gap preenchido quando preço voltou ao nível do fechamento de sexta
  const gapFilled = gapDirection === 'UP'
    ? currentPrice <= fridayClose.price
    : currentPrice >= fridayClose.price;

  return {
    gapSize:          parseFloat(gapSize.toFixed(2)),
    gapPct:           parseFloat(gapPct.toFixed(2)),
    gapDirection,
    fillerDirection,
    fridayClose:      fridayClose.price,
    sundayOpen:       sundayOpen.price,
    fillTarget:       fridayClose.price,
    gapFilled,
    // Alinhado = sinal atual está na direção que preenche o gap
    alignedWithSignal: null,  // preenchido em computeVipSignal
  };
}

/**
 * CONTEXTO — Fibonacci Retracement Automático (Session High/Low)
 *
 * Usa o máximo e mínimo das últimas ~24h de candles (96 × 15m) como âncoras.
 * Calcula os 7 níveis clássicos e verifica se o preço atual está próximo
 * de um nível-chave (38.2%, 50%, 61.8%, 78.6%) dentro de ±1.5% do range.
 *
 * BUY:  entrada ideal = preço perto de suporte de Fibonacci (pullback no bullrun)
 * SELL: entrada ideal = preço perto de resistência de Fibonacci (pullback no downtrend)
 *
 * Como bônus: adiciona +1 quando a entrada coincide com nível de Fibonacci relevante.
 * Como contexto: retorna todos os níveis para exibição no dashboard e Telegram.
 */
function calcFibonacciLevels(candles, direction, lookback = 96) {
  if (!candles || candles.length < 10) return null;

  const slice     = candles.slice(-Math.min(lookback, candles.length));
  const swingHigh = Math.max(...slice.map(c => c.high));
  const swingLow  = Math.min(...slice.map(c => c.low));
  const range     = swingHigh - swingLow;
  if (range <= 0) return null;

  const price = candles[candles.length - 1].close;

  // Níveis clássicos de Fibonacci
  const FIB_RATIOS = [
    { ratio: 0,     label: '0.0%'  },
    { ratio: 0.236, label: '23.6%' },
    { ratio: 0.382, label: '38.2%' },  // zona de suporte leve
    { ratio: 0.5,   label: '50.0%' },  // zona de suporte média
    { ratio: 0.618, label: '61.8%' },  // zona de suporte forte (golden ratio)
    { ratio: 0.786, label: '78.6%' },  // zona de suporte profundo
    { ratio: 1.0,   label: '100%'  },
  ];

  // Para BUY: retracement de HIGH → LOW (suportes abaixo do swing high)
  // Para SELL: retracement de LOW → HIGH (resistências acima do swing low)
  const levels = FIB_RATIOS.map(({ ratio, label }) => ({
    ratio,
    label,
    price: parseFloat((
      direction === 'BUY'
        ? swingHigh - ratio * range   // mede de cima para baixo → pullback bullish
        : swingLow  + ratio * range   // mede de baixo para cima → pullback bearish
    ).toFixed(5)),
  }));

  // Nível mais próximo do preço atual
  const tolerance = range * 0.015;  // ±1.5% do range total
  const KEY_RATIOS = [0.382, 0.5, 0.618, 0.786];

  const nearLevel = levels
    .filter(l => KEY_RATIOS.includes(l.ratio))
    .reduce((best, l) => {
      const dist = Math.abs(price - l.price);
      return (!best || dist < Math.abs(price - best.price)) ? l : best;
    }, null);

  const isNearKeyLevel = nearLevel && Math.abs(price - nearLevel.price) <= tolerance;

  // Alinhamento direcional: para BUY, preço deve estar abaixo do swing high (em retração)
  const inRetracementZone = direction === 'BUY'
    ? price < swingHigh && price > swingLow
    : price > swingLow  && price < swingHigh;

  return {
    swingHigh:       parseFloat(swingHigh.toFixed(5)),
    swingLow:        parseFloat(swingLow.toFixed(5)),
    range:           parseFloat(range.toFixed(5)),
    levels,
    nearLevel:       isNearKeyLevel ? nearLevel : null,
    isNearKeyLevel,
    inRetracementZone,
    // Bônus: preço próximo a nível chave E dentro da zona de retração
    aligned:         isNearKeyLevel && inRetracementZone,
  };
}

/**
 * CONTEXTO — DXY (Dollar Index) como filtro inverso para XAU/USD
 *
 * O ouro (XAU/USD) tem correlação inversa muito alta com o Dollar Index (~-0.80).
 * DXY subindo forte = pressão vendedora no ouro, mesmo que indicadores técnicos apontem BUY.
 * DXY caindo = vento a favor para compras de XAU.
 *
 * Busca dados do DXY via Twelve Data (símbolo "DX-Y.NYB") ou Yahoo Finance ("DX-Y.NYB").
 * Calcula a direção do DXY pela alinhação EMA 9/20/50 no 15m.
 *
 * Retorna:
 *   dxyTrend:   'UP' | 'DOWN' | 'NEUTRAL'
 *   xauAligned: true se DXY confirma a direção do sinal XAU (DXY DOWN + XAU BUY, etc.)
 *   warning:    string de aviso quando DXY vai contra o sinal
 */
const _dxyCache = { data: null, updatedAt: 0 };
const DXY_CACHE_TTL = 15 * 60 * 1000;  // 15 minutos

async function fetchDxyTrend(direction) {
  try {
    const now = Date.now();

    // Usa cache se fresco
    if (_dxyCache.data && (now - _dxyCache.updatedAt) < DXY_CACHE_TTL) {
      return _buildDxyResult(_dxyCache.data, direction);
    }

    let closes = null;

    // Tenta Twelve Data primeiro
    if (TWELVE_DATA_KEY && TWELVE_DATA_KEY !== 'COLE_SUA_CHAVE_AQUI') {
      try {
        const res = await axios.get('https://api.twelvedata.com/time_series', {
          params: { symbol: 'DX-Y.NYB', interval: '15min', outputsize: 60, apikey: TWELVE_DATA_KEY },
          timeout: 4000,
        });
        if (res.data?.values?.length >= 20) {
          closes = res.data.values.reverse().map(v => parseFloat(v.close));
        }
      } catch (_) { /* fallthrough para Yahoo */ }
    }

    // Fallback: Yahoo Finance (sem API key)
    if (!closes) {
      try {
        const res = await axios.get(
          'https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB',
          { params: { interval: '15m', range: '5d' }, timeout: 4000 }
        );
        const result = res.data?.chart?.result?.[0];
        const rawCloses = result?.indicators?.quote?.[0]?.close;
        if (rawCloses?.length >= 20) {
          closes = rawCloses.filter(v => v != null);
        }
      } catch (_) { /* sem dados */ }
    }

    if (!closes || closes.length < 20) return null;

    _dxyCache.data      = closes;
    _dxyCache.updatedAt = now;
    return _buildDxyResult(closes, direction);

  } catch (err) {
    logger.warn('DXY fetch erro:', err.message);
    return null;
  }
}

function _buildDxyResult(closes, direction) {
  const ema9  = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = closes.length >= 50 ? calcEMA(closes, 50) : null;

  let dxyTrend = 'NEUTRAL';
  if (ema50) {
    if (ema9 > ema20 && ema20 > ema50) dxyTrend = 'UP';
    else if (ema9 < ema20 && ema20 < ema50) dxyTrend = 'DOWN';
  } else {
    if (ema9 > ema20) dxyTrend = 'UP';
    else if (ema9 < ema20) dxyTrend = 'DOWN';
  }

  // Correlação inversa: DXY DOWN = favorável para BUY de XAU
  //                    DXY UP   = favorável para SELL de XAU
  const xauAligned = (direction === 'BUY'  && dxyTrend === 'DOWN')
                  || (direction === 'SELL' && dxyTrend === 'UP');

  const xauOpposing = (direction === 'BUY'  && dxyTrend === 'UP')
                   || (direction === 'SELL' && dxyTrend === 'DOWN');

  return {
    dxyTrend,
    ema9:        parseFloat(ema9.toFixed(3)),
    ema20:       parseFloat(ema20.toFixed(3)),
    xauAligned,
    xauOpposing,
    warning: xauOpposing
      ? `⚠️ DXY em tendência ${dxyTrend === 'UP' ? 'de ALTA' : 'de BAIXA'} — vento contra para ${direction} em XAU`
      : null,
  };
}

/**
 * Fear & Greed Index — Alternative.me (API gratuita, sem chave)
 *
 * Escala 0–100:
 *   0–24   Extreme Fear  → mercado sobrevendido → bônus BUY para BTC
 *  25–44   Fear          → contexto levemente bearish
 *  45–55   Neutral       → sem bônus
 *  56–74   Greed         → contexto levemente bullish
 *  75–100  Extreme Greed → mercado sobrecomprado → bônus SELL para BTC
 *
 * Cache de 15 min para evitar rate limit.
 */
const _fngCache = { value: null, classification: null, updatedAt: 0 };
const FNG_CACHE_TTL = 15 * 60 * 1000;  // 15 minutos

async function fetchFearGreedIndex(direction) {
  try {
    const now = Date.now();

    // Retorna do cache se ainda fresco
    if (_fngCache.value !== null && (now - _fngCache.updatedAt) < FNG_CACHE_TTL) {
      return _buildFngResult(_fngCache.value, _fngCache.classification, direction);
    }

    const resp = await axios.get('https://api.alternative.me/fng/?limit=1', {
      timeout: 3000,
      headers: { 'User-Agent': 'TradingDashboard/1.0' },
    });

    const entry = resp.data?.data?.[0];
    if (!entry || entry.value === undefined) {
      logger.warn('Fear & Greed: resposta inesperada da API', resp.data);
      return null;
    }

    const value          = parseInt(entry.value, 10);
    const classification = entry.value_classification || '';

    _fngCache.value          = value;
    _fngCache.classification = classification;
    _fngCache.updatedAt      = now;

    return _buildFngResult(value, classification, direction);
  } catch (err) {
    logger.warn(`Fear & Greed fetch falhou: ${err.message}`);
    return null;
  }
}

function _buildFngResult(value, classification, direction) {
  const isExtremeFear  = value <= 24;
  const isExtremeGreed = value >= 75;
  const isFear         = value >= 25 && value <= 44;
  const isGreed        = value >= 56 && value <= 74;

  // Bônus: extremos confirmam entradas de reversão / continuação
  const btcBuyAligned  = isExtremeFear;   // medo extremo → BTC sobrevendido → bônus BUY
  const btcSellAligned = isExtremeGreed;  // ganância extrema → BTC sobrecomprado → bônus SELL
  const aligned        = direction === 'BUY'  ? btcBuyAligned
                       : direction === 'SELL' ? btcSellAligned
                       : false;

  // Aviso quando o sentimento opõe a direção do sinal
  const opposing = (direction === 'BUY'  && isExtremeGreed)
                || (direction === 'SELL' && isExtremeFear);

  let emoji = '😐';
  if (isExtremeFear)  emoji = '😱';
  else if (isFear)    emoji = '😰';
  else if (isGreed)   emoji = '😏';
  else if (isExtremeGreed) emoji = '🤑';

  return {
    value,
    classification,
    emoji,
    isExtremeFear,
    isExtremeGreed,
    aligned,   // true → +1 bônus
    opposing,  // true → aviso (sem penalidade)
    warning: opposing
      ? `⚠️ Fear & Greed ${emoji} ${value} (${classification}) — sentimento contra o sinal ${direction}`
      : null,
  };
}

/**
 * Determina o viés direcional (BUY/SELL/NEUTRAL) baseado nas EMAs 9/20/50
 */
function getBiasTf(candles) {
  if (!candles || candles.length < 55) return 'NEUTRAL';
  const closes = candles.map(c => c.close);
  const ema9   = calcEMA(closes, 9);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  if (ema9 > ema20 && ema20 > ema50) return 'BUY';
  if (ema9 < ema20 && ema20 < ema50) return 'SELL';
  return 'NEUTRAL';
}

/**
 * Motor principal da Área VIP
 * Avalia os 5 filtros da estratégia e retorna o sinal estruturado
 */
async function computeVipSignal(assetKey, entryTf = '15m', biasTf = '1h', { skipPersist = false } = {}) {
  const cfg = ASSETS[assetKey];
  if (!cfg) throw new Error(`Ativo desconhecido: ${assetKey}`);

  const TF_MAP = { '15m': '15m', '1h': '1h', '4h': '4h', 'daily': 'daily', '1d': 'daily' };
  const entryKey = TF_MAP[entryTf] || '15m';
  const biasKey  = TF_MAP[biasTf]  || '1h';

  const _maxScore = ASSET_MAX_SCORE[assetKey] ?? 14;

  const data = await getAsset(assetKey);
  if (data.isSimulation) {
    return {
      success: false,
      asset: assetKey,
      biasTf,
      entryTf,
      maxScore: _maxScore,
      score: 0,
      status: 'SIMULATION_BLOCKED',
      reason: 'Sinal VIP indisponivel com dados simulados',
      filters: { emaAligned: false, breakout20: false, adxOk: false, sessionOk: false, newsBlocked: false },
      levels: null,
      meta: { reason: 'Fonte de dados em simulacao' },
    };
  }
  if (data.isMarketClosed) {
    return {
      success: false,
      asset: assetKey,
      biasTf,
      entryTf,
      maxScore: _maxScore,
      score: 0,
      status: 'MARKET_CLOSED',
      reason: 'Sinal VIP indisponivel com mercado fechado',
      filters: { emaAligned: false, breakout20: false, adxOk: false, sessionOk: false, newsBlocked: false },
      levels: null,
      meta: { reason: 'Mercado fechado' },
    };
  }
  const entryCandles = data[entryKey] || [];
  const biasCandles  = data[biasKey]  || [];

  if (entryCandles.length < 55 || biasCandles.length < 30) {
    return {
      success: false,
      asset: assetKey,
      maxScore: _maxScore,
      score: 0,
      status: 'INSUFFICIENT_DATA',
      reason: `Dados insuficientes: ${entryCandles.length} candles de entrada, ${biasCandles.length} de viés`,
    };
  }

  const closes = entryCandles.map(c => c.close);
  const price  = entryCandles[entryCandles.length - 1].close;

  // FILTRO 1: Viés do timeframe maior
  const direction = getBiasTf(biasCandles);
  if (direction === 'NEUTRAL') {
    return {
      success: true, asset: assetKey, biasTf, entryTf, direction: 'NEUTRAL',
      score: 0, maxScore: _maxScore, status: 'NO_BIAS',
      filters: { emaAligned: false, breakout20: false, adxOk: false, sessionOk: false, newsBlocked: false },
      levels: null, meta: { reason: 'EMAs sem tendência definida no timeframe de viés' },
    };
  }

  // FILTRO 2: EMAs alinhadas no entry TF
  const filterEma = emaAligned(closes, direction);

  // FILTRO 3: Breakout
  const filterBreakout = hasBreakout(entryCandles, direction, MASTER_SIGNAL_CFG.breakoutLookback);

  // FILTRO 4: ADX
  const { adx, pdi, mdi } = calcADX(entryCandles);
  const filterAdx = adx >= MASTER_SIGNAL_CFG.adxTrendMin;

  // FILTRO 5A: Sessão ideal
  const sessionInfo = getSessionInfo(assetKey);
  const filterSession = sessionInfo.isGood;

  // FILTRO 5B: Sem notícia forte
  await fetchEconomicCalendar();
  const newsInfo = getNewsStatus(assetKey);
  const newsBlocked = newsInfo.isNearNews;

  // ── FILTROS BÔNUS ─────────────────────────────────────────────────────────
  // Cada bônus vale +1 ponto (aditivos ao score base de 7)
  // Permite atingir VALID_SIGNAL (≥7) mesmo sem um filtro base, se bônus compensam

  // BÔNUS 1: Inside Bar — compressão antes do rompimento
  const filterInsideBar = hasInsideBar(entryCandles, direction);

  // BÔNUS 2: Volume de confirmação — vela atual acima da média 20 períodos
  // null = sem dados de volume → neutro (não penaliza nem pontua)
  const volumeConfirmed = hasVolumeConfirmation(entryCandles);
  const filterVolume = volumeConfirmed === true;  // só pontua se confirmado explicitamente

  // BÔNUS 3: Bollinger Band Squeeze — compressão das bandas antes do breakout
  const entryCloses = closes;  // já calculado acima
  const filterBBSqueeze = hasBollingerSqueeze(entryCloses);

  // CONTEXTO MACRO: EMA 200 para XAU/USD (sem pontuação — só contexto/aviso)
  const ema200Ctx = assetKey === 'xauusd' ? getEma200Context(entryCandles, direction) : null;

  // BÔNUS 4: Ichimoku — USD/JPY usa como filtro principal; BTC tem forte tradição de uso
  const ichimokuCtx    = (assetKey === 'usdjpy' || assetKey === 'btc')
    ? calcIchimoku(entryCandles, direction) : null;
  const filterIchimoku = ichimokuCtx?.aligned === true;

  // BÔNUS 5: VWAP de Sessão — referência de valor justo do dia (BTC e XAU/USD)
  const vwapCtx    = (assetKey === 'btc' || assetKey === 'xauusd')
    ? calcSessionVwap(entryCandles, direction) : null;
  const filterVwap = vwapCtx?.aligned === true;

  // BÔNUS 6: Pullback EMA20 com confirmação — entrada em pullback > entrada em extensão
  const filterPullback = hasPullbackEma20(entryCandles, direction);

  // BÔNUS 7: Divergência confirmando a direção (+1 se bullish_rsi/macd confirmam BUY,
  //           ou bearish confirmam SELL). Divergência contrária = aviso, sem penalidade no VIP.
  const divCtx = detectDivergence(entryCandles);
  const filterDivConfirm = (direction === 'BUY'  && divCtx.hasBullish)
                        || (direction === 'SELL' && divCtx.hasBearish);
  const divOpposing     = (direction === 'BUY'  && divCtx.hasBearish)
                        || (direction === 'SELL' && divCtx.hasBullish);

  // CONTEXTO: CME Gap para BTC (não pontua — mas indica alvo estratégico)
  let cmeGapCtx = null;
  if (assetKey === 'btc') {
    cmeGapCtx = detectCMEGap(entryCandles);
    if (cmeGapCtx) {
      cmeGapCtx.alignedWithSignal = cmeGapCtx.fillerDirection === direction;
    }
  }

  // BÔNUS 8: Fibonacci — entrada próxima a nível-chave de retração (+1)
  // Lookback de 96 velas = ~24h no 15m (sessão diária completa)
  const fibCtx       = calcFibonacciLevels(entryCandles, direction, 96);
  const filterFib    = fibCtx?.aligned === true;

  // CONTEXTO + BÔNUS 9: DXY para XAU/USD — correlação inversa com o dólar
  // DXY alinhado com sinal = +1 bônus; DXY contra = aviso (sem penalidade no score)
  let dxyCtx         = null;
  let filterDxy      = false;
  if (assetKey === 'xauusd') {
    dxyCtx    = await fetchDxyTrend(direction);
    filterDxy = dxyCtx?.xauAligned === true;
  }

  // BÔNUS 10: Bias 4H — filtro macro universal (EMA9/20/50 no 4H)
  // Alinha a direção do sinal com a tendência macro de 4 horas.
  // +1 se o 4H confirma a direção; aviso se opõe (sem penalidade).
  // Melhora estimada: +8–12% de precisão ao eliminar trades contra a macro.
  const candles4h      = data['4h'] || [];
  const bias4h         = candles4h.length >= 55 ? getBiasTf(candles4h) : 'NEUTRAL';
  const filter4hBias   = bias4h === direction;
  const bias4hOpposing = bias4h !== 'NEUTRAL' && bias4h !== direction;

  // BÔNUS 11: Fear & Greed Index — apenas BTC (API Alternative.me, gratuita)
  // Medo Extremo (≤24) = +1 BUY | Ganância Extrema (≥75) = +1 SELL
  // Neutro/Fear/Greed moderado = sem bônus (mas exibido no Telegram como contexto)
  let fngCtx       = null;
  let filterFng    = false;
  if (assetKey === 'btc') {
    fngCtx    = await fetchFearGreedIndex(direction);
    filterFng = fngCtx?.aligned === true;
  }

  // Score base: ema(2) + breakout(2) + adx(2) + session(1) = 7
  // Bônus universais:  insideBar+volume+bbSqueeze+pullback+divConfirm+fib+bias4h = +7
  // Bônus por ativo (fixos — não variam com disponibilidade de API):
  //   USD/JPY:  + ichimoku(+1)                        = max 15
  //   BTC:      + ichimoku(+1) + vwap(+1) + fng(+1)  = max 17
  //   XAU/USD:  + vwap(+1)    + dxy(+1)              = max 16
  //   EUR/USD:  apenas os 7 universais                = max 14
  const maxScore = _maxScore; // definido no topo da função via ASSET_MAX_SCORE (módulo)

  let score = 0;
  if (filterEma)        score += 2;
  if (filterBreakout)   score += 2;
  if (filterAdx)        score += 2;
  if (filterSession)    score += 1;
  if (filterInsideBar)  score += 1;
  if (filterVolume)     score += 1;
  if (filterBBSqueeze)  score += 1;
  if (filterIchimoku)   score += 1;
  if (filterVwap)       score += 1;
  if (filterPullback)   score += 1;
  if (filterDivConfirm) score += 1;
  if (filterFib)        score += 1;
  if (filterDxy)        score += 1;
  if (filter4hBias)     score += 1;
  if (filterFng)        score += 1;

  // Penalidade de volume: breakout com volume fraco (dados disponíveis mas abaixo da média)
  if (filterBreakout && volumeConfirmed === false) score -= 1;

  // Níveis operacionais (ATR-based, RR 1:2 fixo)
  const atr = calcATR(entryCandles) || (price * 0.001);
  let entry = price, sl, tp;
  if (direction === 'BUY') {
    sl = parseFloat((entry - MASTER_SIGNAL_CFG.stopAtrMult * atr).toFixed(cfg.decimals));
    tp = parseFloat((entry + MASTER_SIGNAL_CFG.takeAtrMult * atr).toFixed(cfg.decimals));
  } else {
    sl = parseFloat((entry + MASTER_SIGNAL_CFG.stopAtrMult * atr).toFixed(cfg.decimals));
    tp = parseFloat((entry - MASTER_SIGNAL_CFG.takeAtrMult * atr).toFixed(cfg.decimals));
  }

  const vipOperationalContext = getOperationalContext(assetKey, {
    score,
    audit: {
      regime: adx >= MASTER_SIGNAL_CFG.adxStrong ? 'TREND_FORTE' : adx >= MASTER_SIGNAL_CFG.adxTrendMin ? 'TREND_MODERADA' : adx >= 15 ? 'TREND_FRACA' : 'LATERAL',
      session: { isGood: filterSession, label: sessionInfo.sessionStr },
      news: { isBlocked: newsBlocked, name: newsInfo.nearName, time: newsInfo.nearTimeStr },
    }
  });

  // Cálculo de bônus para exibição
  const bonusCount = (filterInsideBar  ? 1 : 0) + (filterVolume    ? 1 : 0)
                   + (filterBBSqueeze  ? 1 : 0) + (filterIchimoku  ? 1 : 0)
                   + (filterVwap       ? 1 : 0) + (filterPullback  ? 1 : 0)
                   + (filterDivConfirm ? 1 : 0) + (filterFib        ? 1 : 0)
                   + (filterDxy        ? 1 : 0) + (filter4hBias     ? 1 : 0)
                   + (filterFng        ? 1 : 0);
  // maxScore calculado acima de forma dinâmica por ativo

  let status, reason;
  if (newsBlocked) {
    status = 'NEWS_BLOCKED';
    reason = `Bloqueado por notícia: ${newsInfo.nearName || 'evento de alto impacto'} (${newsInfo.nearTimeStr || ''})`;
  } else if (AUTO_BLOCK_WEAK_CONTEXT && vipOperationalContext?.status === 'EVITAR') {
    status = 'CONTEXT_BLOCKED';
    reason = `Bloqueado por contexto: ${vipOperationalContext.detail}`;
  } else if (score >= 7) {
    const bonusNote = bonusCount > 0 ? ` + ${bonusCount} bônus ativo(s)` : '';
    status = 'VALID_SIGNAL';
    reason = `Setup completo confirmado${bonusNote}. ${direction === 'BUY' ? '📈 Compra' : '📉 Venda'} com alta convicção.`;
  } else if (score >= 4) {
    status = 'PARTIAL_SIGNAL';
    reason = `Filtros parciais (${score}/${maxScore}). Aguardar confirmação adicional.`;
  } else {
    status = 'NO_SIGNAL';
    reason = `Condições insuficientes (${score}/${maxScore}). Sem setup VIP no momento.`;
  }

  const result = {
    success:   true,
    asset:     assetKey,
    biasTf,
    entryTf,
    direction,
    score,
    maxScore,
    status,
    filters: {
      // Filtros base
      emaAligned:  filterEma,
      breakout20:  filterBreakout,
      adxOk:       filterAdx,
      sessionOk:   filterSession,
      newsBlocked: newsBlocked,
      contextBlocked: AUTO_BLOCK_WEAK_CONTEXT && vipOperationalContext?.status === 'EVITAR',
      // Filtros bônus universais
      insideBar:    filterInsideBar,
      volumeOk:     filterVolume,
      volumeData:   volumeConfirmed,  // null = sem dados, true/false = confirmado/fraco
      bbSqueeze:    filterBBSqueeze,
      pullbackEma:  filterPullback,
      divConfirm:   filterDivConfirm,
      divOpposing:  divOpposing,       // aviso: divergência contra a direção
      // Filtros bônus por ativo
      ichimoku:     filterIchimoku,   // USD/JPY e BTC
      vwapOk:       filterVwap,       // BTC e XAU/USD
      fibOk:        filterFib,        // todos os ativos
      dxyOk:        filterDxy,        // XAU/USD apenas
      // Bias macro 4H — universal (todos os ativos)
      bias4hOk:       filter4hBias,   // 4H confirma direção
      bias4hOpposing: bias4hOpposing, // 4H opõe → aviso
      // Fear & Greed — BTC only
      fngOk:          filterFng,      // extremo alinhado com direção
      fngOpposing:    fngCtx?.opposing ?? false, // extremo contra direção → aviso
    },
    levels: {
      entry:   parseFloat(entry.toFixed(cfg.decimals)),
      sl,
      tp,
      atr:     parseFloat(atr.toFixed(cfg.decimals)),
      rr:      2.0,
    },
    meta: {
      adx:     parseFloat(adx.toFixed(1)),
      pdi:     parseFloat(pdi.toFixed(1)),
      mdi:     parseFloat(mdi.toFixed(1)),
      session: sessionInfo.sessionStr,
      reason,
      price:   parseFloat(entry.toFixed(cfg.decimals)),
      newsInfo: newsBlocked ? { name: newsInfo.nearName, timeStr: newsInfo.nearTimeStr } : null,
      // Contexto macro XAU
      ema200: ema200Ctx ? {
        value:   ema200Ctx.ema200,
        aligned: ema200Ctx.aligned,
        warning: !ema200Ctx.aligned ? `⚠️ Preço ${direction === 'BUY' ? 'abaixo' : 'acima'} da EMA200 — entrada contra tendência macro` : null,
      } : null,
      // Ichimoku (USD/JPY e BTC)
      ichimoku: ichimokuCtx ? {
        tenkan:      ichimokuCtx.tenkan,
        kijun:       ichimokuCtx.kijun,
        kumoTop:     ichimokuCtx.kumoTop,
        kumoBot:     ichimokuCtx.kumoBot,
        aboveKumo:   ichimokuCtx.aboveKumo,
        belowKumo:   ichimokuCtx.belowKumo,
        insideKumo:  ichimokuCtx.insideKumo,
        aligned:     ichimokuCtx.aligned,
      } : null,
      // VWAP de sessão (BTC e XAU/USD)
      vwap: vwapCtx ? {
        value:       vwapCtx.vwap,
        aligned:     vwapCtx.aligned,
        candlesUsed: vwapCtx.candlesUsed,
      } : null,
      // Divergência RSI/MACD
      divergence: {
        signal:      divCtx.signal,
        hasBullish:  divCtx.hasBullish,
        hasBearish:  divCtx.hasBearish,
        confirming:  filterDivConfirm,
        opposing:    divOpposing,
        details:     divCtx.divergences.slice(0, 2),  // máx 2 mais recentes
      },
      // CME Gap (BTC only)
      cmeGap: cmeGapCtx,
      // Fibonacci session high/low
      fibonacci: fibCtx ? {
        swingHigh:   fibCtx.swingHigh,
        swingLow:    fibCtx.swingLow,
        nearLevel:   fibCtx.nearLevel,
        aligned:     fibCtx.aligned,
        levels:      fibCtx.levels.filter(l => [0.382, 0.5, 0.618, 0.786].includes(l.ratio)),
      } : null,
      // DXY (XAU/USD only)
      dxy: dxyCtx ? {
        trend:       dxyCtx.dxyTrend,
        ema9:        dxyCtx.ema9,
        ema20:       dxyCtx.ema20,
        aligned:     dxyCtx.xauAligned,
        opposing:    dxyCtx.xauOpposing,
        warning:     dxyCtx.warning,
      } : null,
      // Bias 4H — universal
      bias4h: {
        trend:     bias4h,
        aligned:   filter4hBias,
        opposing:  bias4hOpposing,
        warning:   bias4hOpposing
          ? `⚠️ Macro 4H em ${bias4h} — sinal ${direction} vai contra a tendência maior`
          : null,
      },
      // Fear & Greed Index — BTC only
      fearGreed: fngCtx ? {
        value:          fngCtx.value,
        classification: fngCtx.classification,
        emoji:          fngCtx.emoji,
        aligned:        fngCtx.aligned,
        opposing:       fngCtx.opposing,
        warning:        fngCtx.warning,
      } : null,
    },
    operationalContext: vipOperationalContext,
    generatedAt: Date.now(),
  };

  // ── Histórico do setup atual ─────────────────────────────────────────────
  // Filtra o histórico de sinais ao vivo pelo contexto exato deste setup:
  // mesmo ativo + direção + regime + sessão → mostra WR e últimos resultados.
  const regime  = result.meta.adx >= 40 ? 'TREND_FORTE'
                : result.meta.adx >= 25 ? 'TREND_MODERADA'
                : result.meta.adx >= 15 ? 'TREND_FRACA' : 'LATERAL';
  const session = sessionInfo.sessionStr || null;

  // Contexto completo (mais específico)
  const setupHistoryFull = tradeStore.getSetupHistory({
    asset:     assetKey,
    direction: direction === 'BUY' ? 'BUY' : 'SELL',
    regime,
    session,
  });

  // Fallback: sem sessão (relaxa um filtro se amostra insuficiente)
  const setupHistoryNoSession = !setupHistoryFull
    ? tradeStore.getSetupHistory({ asset: assetKey, direction, regime })
    : null;

  // Fallback 2: só ativo + direção (máxima amostra)
  const setupHistoryBase = (!setupHistoryFull && !setupHistoryNoSession)
    ? tradeStore.getSetupHistory({ asset: assetKey, direction })
    : null;

  result.setupHistory = setupHistoryFull || setupHistoryNoSession || setupHistoryBase || null;
  result.setupHistoryScope = setupHistoryFull   ? 'full'       // ativo+dir+regime+sessão
                           : setupHistoryNoSession ? 'no_session' // ativo+dir+regime
                           : setupHistoryBase      ? 'base'       // ativo+dir
                           : 'none';

  // Scan mode: não grava no histórico nem envia Telegram
  if (!skipPersist) {
    tradeStore.appendSignal(result);

    // ── Auto-abertura de trade para monitoramento automático de SL/TP ────────
    // Apenas sinais VALID (score ≥7) criam trades automáticos.
    // Isso garante que checkOpenTradesForExit monitore o trade e notifique
    // via Telegram quando SL ou TP for atingido — sem intervenção manual.
    if (status === 'VALID_SIGNAL' && result.levels?.sl && result.levels?.tp) {
      try {
        // Verifica se já existe trade aberto para este ativo+direção
        // (evita duplicar se o mesmo sinal for re-avaliado no ciclo)
        const existingOpen = tradeStore.listTrades({ asset: assetKey, status: 'open' });
        const alreadyOpen  = existingOpen.some(t => t.direction === direction
          && (Date.now() - (t.openedAt || 0)) < VIP_COOLDOWN_MS);

        if (!alreadyOpen) {
          tradeStore.openTrade({
            asset:     assetKey,
            direction,
            biasTf,
            entryTf,
            entry:     result.levels.entry,
            sl:        result.levels.sl,
            tp:        result.levels.tp,
            atr:       result.levels.atr,
            rr:        result.levels.rr,
            score:     result.score,
            session:   result.meta.session,
            reason:    `AUTO | VIP VALID ${result.score}/${result.maxScore} | ${result.meta.reason}`,
          });
          logger.info(`Auto-trade aberto: ${assetKey.toUpperCase()} ${direction} score ${result.score}/${result.maxScore}`);
        }
      } catch (tradeErr) {
        logger.warn(`Erro ao auto-abrir trade ${assetKey}:`, tradeErr.message);
      }
    }
  }

  // ── Alerta Telegram para sinal VIP válido ou parcial ──────────────────────
  // Cooldown por chave ativo+direção+status para não repetir o mesmo sinal
  const vipAlertKey = `vip_${assetKey}_${direction}_${status}`;
  const prevVipAlert = lastSignals[vipAlertKey];
  const VIP_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h cooldown (sinal VIP é mais raro)
  const vipCooldownOk = !prevVipAlert?.lastSentAt || (Date.now() - prevVipAlert.lastSentAt) >= VIP_COOLDOWN_MS;

  if (!skipPersist && vipCooldownOk && (status === 'VALID_SIGNAL' || status === 'PARTIAL_SIGNAL')) {
    const dirEmoji = direction === 'BUY' ? '📈' : '📉';
    const statusLabel = status === 'VALID_SIGNAL' ? '✅ SINAL VÁLIDO' : '⚡ SINAL PARCIAL';
    const scoreBar = '🟡'.repeat(Math.min(result.score, result.maxScore)) + '⚫'.repeat(Math.max(0, result.maxScore - result.score));
    const f = result.filters;
    const L = result.levels;
    const m = result.meta;

    // Linhas de bônus (só exibe os ativos para o ativo)
    const bonusLines = [];
    if (f.insideBar)    bonusLines.push(`⭐ Inside Bar confirmada`);
    if (f.volumeOk)     bonusLines.push(`⭐ Volume acima da média`);
    if (f.bbSqueeze)    bonusLines.push(`⭐ BB Squeeze (compressão)`);
    if (f.ichimoku)     bonusLines.push(`⭐ Ichimoku: preço ${m.ichimoku?.aboveKumo ? 'acima' : 'abaixo'} da Kumo + Tenkan/Kijun alinhados`);
    if (f.vwapOk)       bonusLines.push(`⭐ VWAP ${direction === 'BUY' ? 'bullish' : 'bearish'}: ${m.vwap?.value ?? '—'}`);
    if (f.pullbackEma)  bonusLines.push(`⭐ Pullback EMA20 com confirmação`);
    if (f.divConfirm)   bonusLines.push(`⭐ Divergência RSI/MACD confirmando ${direction}`);
    // Avisos
    if (f.volumeData === false && f.breakout20) bonusLines.push(`⚠️ Breakout com volume fraco (-1 ponto)`);
    if (f.fibOk)        bonusLines.push(`⭐ Fibonacci ${m.fibonacci?.nearLevel?.label ?? ''} — entrada em zona de retração chave`);
    if (f.dxyOk)        bonusLines.push(`⭐ DXY ${m.dxy?.trend === 'DOWN' ? '📉 caindo' : '📈 subindo'} — favorável para ${direction} em XAU`);
    if (f.bias4hOk)     bonusLines.push(`⭐ Bias 4H confirma ${direction} — macro alinhada com o sinal`);
    if (f.fngOk)        bonusLines.push(`⭐ Fear & Greed ${m.fearGreed?.emoji} ${m.fearGreed?.value} (${m.fearGreed?.classification}) — sentimento extremo confirma ${direction}`);
    if (f.divOpposing)  bonusLines.push(`⚠️ Divergência ${direction === 'BUY' ? 'bearish' : 'bullish'} detectada — sinal contrário ao trend`);
    if (f.bias4hOpposing) bonusLines.push(`⚠️ Macro 4H em ${m.bias4h?.trend} — ${direction} vai contra a tendência maior`);
    if (f.fngOpposing)  bonusLines.push(m.fearGreed?.warning);
    if (m.ema200 && !m.ema200.aligned) bonusLines.push(m.ema200.warning);
    if (m.ichimoku?.insideKumo) bonusLines.push(`⚠️ Preço DENTRO da Kumo — zona de transição, cautela`);
    if (m.dxy?.warning) bonusLines.push(m.dxy.warning);
    if (m.cmeGap && !m.cmeGap.gapFilled) {
      const gapDir = m.cmeGap.gapDirection === 'UP' ? '📈' : '📉';
      const aligned = m.cmeGap.alignedWithSignal ? '✅ alinhado com o sinal' : '⚠️ contra o sinal';
      bonusLines.push(`${gapDir} CME Gap ${m.cmeGap.gapDirection} de ${m.cmeGap.gapPct}% — Alvo de fill: ${m.cmeGap.fillTarget} (${aligned})`);
    }

    const vipMsg = [
      `⭐ <b>ÁREA VIP — ${statusLabel}</b>`,
      ``,
      `<b>${cfg.name}</b> ${dirEmoji} <b>${direction}</b>  |  Score: ${result.score}/${result.maxScore}`,
      `${scoreBar}`,
      ``,
      `🎯 <b>Níveis</b>`,
      `Entry: <b>${L.entry}</b>`,
      `Stop:  <b>${L.sl}</b>  (-1.5×ATR)`,
      `Alvo:  <b>${L.tp}</b>  (+3.0×ATR)`,
      `ATR: ${L.atr}  |  R:R 1:2`,
      ``,
      `📋 <b>Filtros Base</b>`,
      `${f.emaAligned  ? '✅' : '❌'} EMAs alinhadas (${entryTf})`,
      `${f.breakout20  ? '✅' : '❌'} Breakout ${MASTER_SIGNAL_CFG.breakoutLookback} barras`,
      `${f.adxOk       ? '✅' : '❌'} ADX ${m.adx} (≥25)`,
      `${f.sessionOk   ? '✅' : '❌'} Sessão: ${m.session}`,
      `${!f.newsBlocked ? '✅' : '⚠️'} Notícias: ${f.newsBlocked ? 'BLOQUEADO' : 'Livre'}`,
      ...(bonusLines.length > 0 ? [``, `🚀 <b>Filtros Bônus</b>`, ...bonusLines] : []),
      ``,
      `🧭 <b>Contexto Operacional</b>`,
      `${result.operationalContext.status} — ${result.operationalContext.summary}`,
      `${result.operationalContext.detail}`,
      ``,
      `Bias: ${biasTf.toUpperCase()}  |  Entry: ${entryTf.toUpperCase()}  |  Macro 4H: ${bias4h}`
        + (fngCtx ? `  |  F&G: ${fngCtx.emoji}${fngCtx.value}` : ''),
    ].join('\n');

    sendTelegram(vipMsg).catch(() => {});
    lastSignals[vipAlertKey] = { lastSentAt: Date.now() };
    saveLastSignals();
  }

  return result;
}

// ===== ROTAS AUTH / ADMIN =====

app.get('/api/auth/config', rateLimit, (_req, res) => {
  res.json({
    success: true,
    allowPublicSignup: ALLOW_PUBLIC_SIGNUP,
    hasLegacyVipToken: !!VIP_TOKEN,
    usersCount: authStore.countUsers(),
    defaultSignupAccessStatus: DEFAULT_SIGNUP_ACCESS_STATUS,
    defaultSignupPlanCode: DEFAULT_SIGNUP_PLAN_CODE,
  });
});

app.post('/api/auth/register', rateLimit, (req, res) => {
  if (!ALLOW_PUBLIC_SIGNUP) {
    return res.status(403).json({
      success: false,
      error: 'Cadastro publico desabilitado',
      detail: 'Ative ALLOW_PUBLIC_SIGNUP=true para liberar auto-cadastro',
    });
  }

  const { email, password, name, telegramHandle } = req.body || {};

  try {
    const user = authStore.createUser({
      email,
      password,
      role: 'subscriber',
      accessStatus: DEFAULT_SIGNUP_ACCESS_STATUS,
      planCode: DEFAULT_SIGNUP_PLAN_CODE,
      profile: { name, telegramHandle, createdVia: 'public_signup' },
    });

    const session = authStore.createSession(user.id, {
      ip: getRequestIp(req),
      userAgent: req.headers['user-agent'] || '',
    });

    res.status(201).json({
      success: true,
      user: buildPublicUser({ ...user, sessionExpiresAt: session.expiresAt }),
      session: {
        token: session.token,
        expiresAt: session.expiresAt,
      },
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/login', rateLimit, (req, res) => {
  const { email, password } = req.body || {};
  const user = authStore.authenticateUser(email, password);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Email ou senha invalidos' });
  }

  const session = authStore.createSession(user.id, {
    ip: getRequestIp(req),
    userAgent: req.headers['user-agent'] || '',
  });

  res.json({
    success: true,
    user: buildPublicUser({ ...user, sessionExpiresAt: session.expiresAt }),
    session: {
      token: session.token,
      expiresAt: session.expiresAt,
    },
  });
});

app.post('/api/auth/logout', rateLimit, requireAuth, (req, res) => {
  if (req.auth.type === 'session' && req.auth.token) {
    authStore.revokeSession(req.auth.token);
  }
  res.json({ success: true });
});

app.get('/api/auth/me', rateLimit, requireAuth, (req, res) => {
  res.json({
    success: true,
    user: buildPublicUser(req.auth.user),
    authType: req.auth.type,
  });
});

// ── Relatório semanal sob demanda ──────────────────────────────────────────
app.post('/api/admin/weekly-report', rateLimit, requireAdmin, async (req, res) => {
  try {
    await sendWeeklyReport();
    res.json({ success: true, message: 'Relatório semanal enviado via Telegram' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/admin/users', rateLimit, requireAdmin, (req, res) => {
  const { accessStatus, role, limit } = req.query;
  const users = authStore.listUsers({
    accessStatus: accessStatus ? String(accessStatus) : undefined,
    role: role ? String(role) : undefined,
    limit: parseInt(limit, 10) || 100,
  });
  res.json({ success: true, count: users.length, users });
});

app.post('/api/admin/users', rateLimit, requireAdmin, (req, res) => {
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

app.patch('/api/admin/users/:id', rateLimit, requireAdmin, (req, res) => {
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

app.post('/api/admin/users/:id/revoke-sessions', rateLimit, requireAdmin, (req, res) => {
  const { id } = req.params;
  const revoked = authStore.revokeSessionsForUser(id);
  res.json({ success: true, revoked });
});

// ===== ROTAS VIP =====

// Cache de resultado por ativo — evita recalcular ao trocar de ativo na UI
// TTL: 2 minutos. O ciclo de polling do servidor (15min) sempre força recálculo.
const _signalCache = {};          // { [cacheKey]: { data, cachedAt } }
// TTL precisa ser >= ALERT_INTERVAL_MS para cobrir o gap entre ciclos de background.
// Sem OANDA o ciclo roda a cada 5 min; com OANDA a cada 2 min.
// Usando 7 min para garantir cobertura total (ciclo 5min + margem).
const SIGNAL_CACHE_TTL = 7 * 60 * 1000; // 7 minutos

app.get('/api/vip/signal', rateLimit, requireVipAccess, async (req, res) => {
  const asset   = (req.query.asset   || 'xauusd').toLowerCase();
  const entryTf = (req.query.entryTf || '15m').toLowerCase();
  const biasTf  = (req.query.biasTf  || '1h').toLowerCase();
  if (!ASSETS[asset]) return res.status(404).json({ success: false, error: `Ativo não encontrado: ${asset}` });
  const validTfs = ['15m', '1h', '4h', 'daily', '1d'];
  if (!validTfs.includes(entryTf)) return res.status(400).json({ success: false, error: `entryTf inválido` });
  if (!validTfs.includes(biasTf))  return res.status(400).json({ success: false, error: `biasTf inválido` });

  const cacheKey   = `${asset}:${entryTf}:${biasTf}`;
  const cached     = _signalCache[cacheKey];
  const forceRefresh = req.query.force === '1';

  // Retorna do cache se fresco (< 2 min) e não forçado
  if (!forceRefresh && cached && (Date.now() - cached.cachedAt) < SIGNAL_CACHE_TTL) {
    return res.json({ ...cached.data, _cached: true, _cachedAt: cached.cachedAt });
  }

  try {
    // Timeout de 20s: se cálculo travar (API externa lenta), retorna cache antigo ou erro
    const COMPUTE_TIMEOUT_MS = 20_000;
    const signal = await Promise.race([
      computeVipSignal(asset, entryTf, biasTf, { skipPersist: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout ao calcular sinal (>20s)')), COMPUTE_TIMEOUT_MS)),
    ]);
    _signalCache[cacheKey] = { data: signal, cachedAt: Date.now() };
    res.json(signal);
  } catch (err) {
    logger.error('VIP signal error:', err.message);
    // Se falhou mas tem cache (mesmo expirado), retorna cache como fallback
    if (cached) return res.json({ ...cached.data, _cached: true, _stale: true, _staleReason: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/vip/signals', rateLimit, requireVipAccess, (req, res) => {
  const { asset, status, limit } = req.query;
  const signals = tradeStore.listSignals({ asset, status, limit: parseInt(limit) || 100 });
  res.json({ success: true, count: signals.length, signals });
});

app.post('/api/vip/trades/open', rateLimit, requireVipAccess, async (req, res) => {
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
  });

  // ── Alerta Telegram: trade aberto ────────────────────────────────────────
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

app.post('/api/vip/trades/close', rateLimit, requireVipAccess, (req, res) => {
  const { id, closePrice, outcome } = req.body;
  if (!id || closePrice == null)
    return res.status(400).json({ success: false, error: 'Campos obrigatórios: id, closePrice' });
  const trade = tradeStore.closeTrade(id, { closePrice: parseFloat(closePrice), outcome: outcome || 'MANUAL' });
  if (!trade) return res.status(404).json({ success: false, error: `Trade não encontrado: ${id}` });

  // ── Alerta Telegram: trade fechado ────────────────────────────────────────
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

app.get('/api/vip/trades', rateLimit, requireVipAccess, (req, res) => {
  const { asset, status, limit } = req.query;
  const trades = tradeStore.listTrades({ asset, status, limit: parseInt(limit) || 100 });
  res.json({ success: true, count: trades.length, trades });
});

app.get('/api/vip/stats', rateLimit, requireVipAccess, (req, res) => {
  const { asset } = req.query;
  const stats = tradeStore.getStats({ asset });
  res.json({ success: true, stats });
});

// PATCH /api/vip/trades/:id — atualiza notes/tags de um trade
app.patch('/api/vip/trades/:id', rateLimit, requireVipAccess, (req, res) => {
  const { id } = req.params;
  if (!id || typeof id !== 'string') return res.status(400).json({ success: false, error: 'ID inválido' });
  const updated = tradeStore.updateTrade(id, req.body || {});
  if (!updated) return res.status(404).json({ success: false, error: 'Trade não encontrado' });
  res.json({ success: true, trade: updated });
});

/**
 * GET /api/vip/scan?entryTf=15m&biasTf=4h
 * Escaneia todos os ativos de uma vez e retorna resumo de cada um
 */
app.get('/api/vip/scan', rateLimit, requireVipAccess, async (req, res) => {
  const entryTf = (req.query.entryTf || '15m').toLowerCase();
  const biasTf  = (req.query.biasTf  || '1h').toLowerCase();
  const validTfs = ['15m', '1h', '4h', 'daily', '1d'];
  if (!validTfs.includes(entryTf)) return res.status(400).json({ success: false, error: 'entryTf inválido' });
  if (!validTfs.includes(biasTf))  return res.status(400).json({ success: false, error: 'biasTf inválido' });
  const results = {};
  await Promise.all(Object.keys(ASSETS).map(async (key) => {
    try {
      const sig = await computeVipSignal(key, entryTf, biasTf, { skipPersist: true });
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

// ===== ROTAS =====
async function safeGetAsset(key, res) {
  try { res.json(attachSignals(await getAsset(key), key)); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
}
app.get('/api/btc',    rateLimit, (req, res) => safeGetAsset('btc', res));
app.get('/api/xauusd', rateLimit, (req, res) => safeGetAsset('xauusd', res));
app.get('/api/eurusd', rateLimit, (req, res) => safeGetAsset('eurusd', res));
app.get('/api/usdjpy', rateLimit, (req, res) => safeGetAsset('usdjpy', res));

// ===== ROTA: BACKTEST DATA (consolidada) =====
// Retorna candlesticks de todos os ativos em todos os TFs para o backtester.html
// Usa dados em cache + fetches em paralelo se cache estiver velho
app.get('/api/backtest-data', rateLimit, (req, res) => {
  try {
    const result = {};
    const assetMap = {
      'xauusd': 'xau',
      'btc':    'btc',
      'eurusd': 'eur',
      'usdjpy': 'jpy'
    };

    // Retorna dados do cache (ou fallback)
    for (const [key, assetName] of Object.entries(assetMap)) {
      const cached = cache[key];
      if (cached && cached.data && cached.data['15m']) {
        result[assetName] = {
          '15m':  cached.data['15m'],
          '1h':   cached.data['1h']   || [],
          '4h':   cached.data['4h']   || [],
          'daily': cached.data['daily'] || []
        };
      }
    }

    res.json(result);

    // Refresh async (sem bloquear resposta) se cache estiver velho
    for (const key of Object.keys(assetMap)) {
      if (!isCacheValid(key)) {
        getAsset(key).catch(e => logger.warn(`Auto-refresh ${key} falhou: ${e.message}`));
      }
    }
  } catch (err) {
    logger.error('Erro ao buscar dados para backtester:', err.message);
    res.status(500).json({ error: 'Erro ao carregar dados para backtester', detail: err.message });
  }
});

app.get('/api/health', rateLimit, (req, res) => {
  const status = {};
  Object.entries(ASSETS).forEach(([key, cfg]) => {
    const c   = cache[key];
    const age = c.updatedAt ? Math.round((Date.now() - c.updatedAt) / 60000) : null;
    status[cfg.name] = c.data?.price
      ? `${c.data.price.toFixed(cfg.decimals)} (${age}min atrás) [${c.data.source || 'n/a'}]`
      : 'carregando...';
  });
  const risk = tradeStore.getRiskState();
  const riskEmoji = { NORMAL: '🟢', CAUTIOUS: '🟡', DEFENSIVE: '🟠', BLOCKED: '🔴' };
  res.json({
    status:        'ok',
    version:       VERSION,
    twelveDataKey: TWELVE_DATA_KEY === 'COLE_SUA_CHAVE_AQUI' ? '❌ não configurado' : '✅ ok',
    btcFonte:      cache['btc']?.data?.source || 'carregando...',
    oanda:         OANDA_API_KEY  ? `✅ configurado (${OANDA_PRACTICE ? 'prática' : 'real'})` : 'ℹ️ não configurado',
    finnhub:       FINNHUB_API_KEY ? '✅ configurado (preço spot 2min)' : 'ℹ️ não configurado',
    autoBlockWeakContext: AUTO_BLOCK_WEAK_CONTEXT ? '✅ ativo' : '⏸ desativado',
    yahooFinance:  '⏸ desativado',
    alertInterval: `${ALERT_INTERVAL_MS / 60000} min`,
    riskManagement: {
      level:          risk.level,
      emoji:          riskEmoji[risk.level] || '⚪',
      reason:         risk.reason,
      streakLoss:     risk.streakLoss,
      drawdownPct:    risk.drawdownPct,
      dailyLoss:      risk.dailyLoss,
      sizingMultiplier: risk.sizingMultiplier,
    },
    ativos:        status,
  });
});

// ===== ROTA: TESTE MANUAL DO TELEGRAM =====
// Aceita GET e POST para compatibilidade com botão do dashboard e chamada direta no browser
app.get('/api/telegram/test', rateLimit, async (req, res) => {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.json({ ok: false, error: 'TELEGRAM_TOKEN ou TELEGRAM_CHAT_ID não configurado no .env' });
  }
  try {
    await sendTelegram('✅ <b>Trading Dashboard — Teste de conexão OK!</b>\n\nBot conectado ao grupo. Alertas automáticos serão enviados aqui quando os sinais mudarem.');
    res.json({ ok: true, message: 'Mensagem enviada com sucesso ao Telegram!' });
  } catch (err) {
    // sendTelegram relança o erro — aqui sabemos que a entrega falhou de verdade
    const detail = err.response?.data?.description || err.message;
    res.json({ ok: false, error: `Falha na entrega ao Telegram: ${detail}` });
  }
});
app.post('/api/telegram/test', rateLimit, async (req, res) => {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.json({ ok: false, error: 'TELEGRAM_TOKEN ou TELEGRAM_CHAT_ID não configurado no .env' });
  }
  try {
    await sendTelegram('✅ <b>Trading Dashboard — Teste de conexão OK!</b>\n\nBot conectado ao grupo. Alertas automáticos serão enviados aqui quando os sinais mudarem.');
    res.json({ ok: true, message: 'Mensagem enviada com sucesso ao Telegram!' });
  } catch (err) {
    const detail = err.response?.data?.description || err.message;
    res.json({ ok: false, error: `Falha na entrega ao Telegram: ${detail}` });
  }
});

// ===== ROTA: STATUS DOS ALERTAS =====
app.get('/api/telegram/status', rateLimit, (req, res) => {
  const now = Date.now();
  const signalStatus = {};
  Object.entries(lastSignals).forEach(([k, v]) => {
    const remainMs = v.lastSentAt ? Math.max(0, ALERT_COOLDOWN_MS - (now - v.lastSentAt)) : 0;
    signalStatus[k] = {
      lastLabel: v.masterLabel,
      cooldownRestante: remainMs > 0 ? `${Math.ceil(remainMs / 60000)}min` : 'livre'
    };
  });
  res.json({
    configured: !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID),
    botToken: TELEGRAM_TOKEN ? '✅ configurado' : '❌ faltando TELEGRAM_TOKEN no .env',
    chatId: TELEGRAM_CHAT_ID ? '✅ configurado' : '❌ faltando TELEGRAM_CHAT_ID no .env',
    cooldownPorAtivo: signalStatus
  });
});

// ===== ROTA: CALENDÁRIO ECONÔMICO =====
app.get('/api/news', rateLimit, async (req, res) => {
  try {
    const events = await fetchEconomicCalendar();
    const statusByAsset = {};
    for (const key of Object.keys(ASSETS)) {
      statusByAsset[key] = getNewsStatus(key);
    }
    res.json({ success: true, events, statusByAsset, cacheAge: newsCache.updatedAt ? Math.round((Date.now() - newsCache.updatedAt) / 60000) + 'min' : 'n/a' });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ===== ROTA: SUPORTE/RESISTÊNCIA + DIVERGÊNCIA =====
app.get('/api/analysis/:asset', rateLimit, async (req, res) => {
  const key = req.params.asset;
  if (!ASSETS[key]) return res.status(404).json({ error: 'Ativo não encontrado' });
  try {
    const data = await getAsset(key);
    const candles = data['15m'];
    if (!candles || candles.length < 50) return res.json({ sr: null, div: null });
    const sr = calcSupportResistance(candles);
    const div = detectDivergence(candles);
    res.json({ success: true, asset: key, sr, div });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/live-signals', rateLimit, (req, res) => {
  const { asset, status, limit } = req.query;
  const signals = tradeStore.listLiveSignals({
    asset,
    status,
    limit: parseInt(limit, 10) || 100,
  });
  res.json({ success: true, count: signals.length, signals });
});

app.get('/api/live-signals/stats', rateLimit, (req, res) => {
  const { asset } = req.query;
  const stats = tradeStore.getLiveSignalStats({ asset });
  res.json({ success: true, stats });
});

app.get('/api/live-signals/executive', rateLimit, (req, res) => {
  const { asset } = req.query;
  const stats = tradeStore.getLiveSignalStats({ asset });
  res.json({
    success: true,
    executive: stats.executive || {},
    recent: stats.recent || {},
    recentDaily: stats.recentDaily || [],
    drawdown: stats.drawdown || {},
    streaks: stats.streaks || {},
    strongContexts: stats.strongContexts || [],
    weakContexts: stats.weakContexts || [],
  });
});

app.get('/api/risk-state', rateLimit, (req, res) => {
  try {
    const risk = tradeStore.getRiskState();
    const levelEmoji = { NORMAL: '🟢', CAUTIOUS: '🟡', DEFENSIVE: '🟠', BLOCKED: '🔴' };
    res.json({
      success: true,
      level: risk.level,
      emoji: levelEmoji[risk.level] || '⚪',
      reason: risk.reason,
      streakLoss: risk.streakLoss,
      drawdownPct: risk.drawdownPct,
      dailyLoss: risk.dailyLoss,
      sizingMultiplier: risk.sizingMultiplier,
      minScore: risk.minScore === Infinity ? null : risk.minScore,
      allowedAssets: risk.allowedAssets,
      description: {
        NORMAL:    'Sistema operando normalmente. Todos os sinais elegíveis emitidos.',
        CAUTIOUS:  'Cautela ativa. Apenas score 3 (máximo) permite emissão. Sizing 75%.',
        DEFENSIVE: 'Modo defensivo. Apenas BTC/XAU, score 3 obrigatório. Sizing 50%.',
        BLOCKED:   'Sistema pausado. Nenhum sinal emitido até recuperação.',
      }[risk.level],
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== AUTO-CLOSE VIP TRADES (SL/TP) =====
/**
 * Verifica se algum trade VIP aberto para este ativo teve seu SL ou TP atingido
 * na ultima vela 15m. Fecha automaticamente e notifica via Telegram.
 *
 * Logica de deteccao via candle high/low (mais precisa que so close):
 *   BUY:  TP hit  -> candle.high >= tp  | SL hit -> candle.low  <= sl
 *   SELL: TP hit  -> candle.low  <= tp  | SL hit -> candle.high >= sl
 *
 * TP tem prioridade sobre SL (se ambos tocados na mesma vela, assume TP).
 * Trades sem TP (trailing stop) so verificam SL.
 */
async function checkOpenTradesForExit(asset, data) {
  if (data.isSimulation || data.isMarketClosed) return;

  const candles = data['15m'];
  if (!candles || candles.length < 2) return;

  // Usa a vela anterior a ultima (a ultima pode ainda estar formando)
  const candle = candles[candles.length - 2];
  if (!candle) return;

  const candleOpenAtMs  = (candle.time || 0) * 1000;
  const candleCloseAtMs = candleOpenAtMs + (15 * 60 * 1000);

  const openTrades = tradeStore.listTrades({ asset, status: 'open' });
  if (!openTrades.length) return;

  for (const trade of openTrades) {
    const { id, direction, entry, sl, tp, openedAt } = trade;
    if (!sl || isNaN(sl)) continue; // sem SL definido - pular

    // So avalia candles totalmente posteriores a abertura do trade.
    // Se o trade abriu no meio da vela, o high/low dessa vela e ambiguo.
    if (!openedAt || candleOpenAtMs <= openedAt || candleCloseAtMs <= openedAt) continue;

    const isBuy  = direction === 'BUY';
    const hasTP  = tp != null && !isNaN(tp);

    // Detecta qual nivel foi tocado
    let outcome   = null;
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
      // SELL
      if (hasTP && candle.low <= tp) {
        outcome    = 'TP';
        closePrice = tp;
      } else if (candle.high >= sl) {
        outcome    = 'SL';
        closePrice = sl;
      }
    }

    if (!outcome) continue;

    // Fecha o trade no SQLite
    const closed = tradeStore.closeTrade(id, { closePrice, outcome });
    if (!closed) continue;

    logger.info(`Auto-close ${asset.toUpperCase()} ${direction} -> ${outcome} @ ${closePrice} | ${closed.pnlR}R`);

    // Telegram - mesmo formato do fechamento manual
    const pnlPos       = (closed.pnlR || 0) >= 0;
    const outcomeEmoji = outcome === 'TP' ? '\u2705' : '\u274C';
    const pnlEmoji     = pnlPos ? '\uD83D\uDCB0' : '\uD83D\uDCC9';
    const autoMsg = [
      `\u2B50 <b>VIP - AUTO-FECHADO</b> ${outcomeEmoji}`,
      ``,
      `<b>${asset.toUpperCase()}</b>  ${direction}  ->  ${outcome} <i>(automatico)</i>`,
      `Entry: ${entry}  |  Close: <b>${closePrice}</b>`,
      `Resultado: ${pnlEmoji} <b>${pnlPos ? '+' : ''}${closed.pnlR}R</b>  (${pnlPos ? '+' : ''}${closed.pnlPct}%)`,
      closed.session ? `Sessao: ${closed.session}` : '',
    ].filter(Boolean).join('\n');

    sendTelegram(autoMsg).catch(() => {});
  }
}

// ===== RELATÓRIO SEMANAL AUTOMÁTICO =====
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

// Rastreia quando o relatório semanal foi enviado pela última vez
let lastWeeklyReportDay = null;

// Job: verifica toda hora se é segunda-feira >= 08:00 UTC e relatório ainda não foi enviado hoje
setInterval(async () => {
  try {
    const now  = new Date();
    const day  = now.getUTCDay();   // 1 = segunda
    const hour = now.getUTCHours();
    const todayStr = now.toISOString().slice(0, 10);

    if (day === 1 && hour >= 8 && lastWeeklyReportDay !== todayStr) {
      lastWeeklyReportDay = todayStr;
      await sendWeeklyReport();
    }
  } catch (e) {
    logger.warn('Erro no job de relatório semanal:', e.message);
  }
}, 60 * 60 * 1000); // checa a cada hora

// Endpoint manual para forçar relatório imediato (admin)
// POST /api/admin/weekly-report
// (adicionado junto com os outros endpoints admin mais abaixo)

// ===== AUTO-REFRESH + ALERTAS =====
// Prioridade: OANDA (2min) > Finnhub (2min) > padrão Twelve Data (5min)
const ALERT_INTERVAL_MS = (OANDA_API_KEY || FINNHUB_API_KEY) ? 2 * 60 * 1000 : 5 * 60 * 1000;

setInterval(async () => {
  for (const key of Object.keys(ASSETS)) {
    try {
      const data = await getAsset(key);
      await checkAndSendAlerts(key, data);
      if (!data.isSimulation && !data.isMarketClosed) {
        await checkOpenTradesForExit(key, data);
      }
      if (data['15m']?.length) {
        tradeStore.evaluateLiveSignals({ asset: key, candles: data['15m'], tf: '15m', horizonCandles: 4 });
      }

      if (!data.isSimulation && !data.isMarketClosed) {
        try {
          const sig = await computeVipSignal(key, '15m', '1h', { skipPersist: false });
          // Pre-aquece o cache da rota /api/vip/signal para troca de ativo instantânea
          _signalCache[`${key}:15m:1h`] = { data: sig, cachedAt: Date.now() };
        } catch (vipErr) {
          logger.warn(`VIP scan ${key}:`, vipErr.message);
        }
      }
    } catch (err) {
      logger.warn(`Erro no ciclo de ${key}:`, err.message);
    }
  }
}, ALERT_INTERVAL_MS);

// Kraken polling BTC a cada 2 min
setInterval(pollBtcKraken, 2 * 60 * 1000);

// OANDA polling separado a cada 2 min (independente do ciclo de alertas)
if (OANDA_API_KEY) {
  setInterval(pollOanda, OANDA_POLL_MS);
}

// Finnhub polling a cada 2 min (alternativa ao OANDA para preço spot)
if (FINNHUB_API_KEY && !OANDA_API_KEY) {
  setInterval(pollFinnhub, 2 * 60 * 1000);
  logger.info('Finnhub configurado — preço spot EUR/USD, USD/JPY, XAU/USD, BTC a cada 2 min');
}

// Yahoo Finance polling desativado: Twelve Data voltou a ser o fallback principal

// ===== START =====
app.listen(PORT, async () => {
  logger.info(`Trading Dashboard v${VERSION} iniciado | porta ${PORT} | ${Object.keys(ASSETS).length} ativos: ${Object.values(ASSETS).map(a=>a.name).join(', ')}`);

  bootstrapAdminAccount();

  if (TWELVE_DATA_KEY === 'COLE_SUA_CHAVE_AQUI') {
    logger.warn('TWELVE_DATA_KEY não configurada — usando Twelve Data apenas como fallback');
  }

  // ── Binance WebSocket (BTC) ──────────────────────────────────────────────
  logger.info('Iniciando Binance WebSocket (BTC)...');
  await loadBtcHistory();   // carrega histórico inicial via REST
  connectBinanceWS();       // conecta stream em tempo real

  // ── OANDA (XAU/EUR/JPY) ─────────────────────────────────────────────────
  if (OANDA_API_KEY) {
    logger.info(`OANDA configurado — XAU/EUR/JPY em tempo real (${OANDA_PRACTICE ? 'prática' : 'real'})`);
    await pollOanda(); // carrega histórico inicial via REST
  } else if (FINNHUB_API_KEY) {
    logger.info('Finnhub configurado — preço spot atualizado a cada 2 min (ciclo acelerado)');
    await pollFinnhub(); // atualiza preços na primeira carga
  } else {
    logger.warn('OANDA_API_KEY e FINNHUB_API_KEY não configuradas — usando Twelve Data para XAU/EUR/JPY');
  }

  // Carga inicial dos ativos restantes (só se ainda sem dados reais)
  for (const key of Object.keys(ASSETS).filter(k => k !== 'btc')) {
    if (!cache[key].data || cache[key].data.isSimulation) {
      getAsset(key).catch(e => logger.warn(`${key}: carga inicial falhou — ${e.message}`));
    }
  }
});
