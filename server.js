require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

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
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ── Segurança: bloqueia arquivos sensíveis ANTES do express.static ──────────
// O setHeaders vinha depois do match e causava ERR_HTTP_HEADERS_SENT.
// Middleware de bloqueio explícito resolve isso sem crash.
const BLOCKED_PATHS = new Set([
  '/server.js', '/tradestore.js',
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
      console.log('📂 lastSignals restaurado do disco');
      return data;
    }
  } catch (e) {
    console.log('⚠️  Erro ao ler lastSignals.json — iniciando vazio:', e.message);
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
        console.log('⚠️  Erro ao salvar lastSignals.json:', err.message);
        _saveInProgress = false;
        return;
      }
      fs.rename(tmpFile, SIGNALS_FILE, (renameErr) => {
        if (renameErr) console.log('⚠️  Erro ao renomear lastSignals.tmp:', renameErr.message);
        _saveInProgress = false;
      });
    });
  }, 300);
}

// Guarda o último sinal enviado por ativo (evita mensagens repetidas)
const lastSignals = loadLastSignals();

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    }, { timeout: 8000 });
    console.log('📨 Telegram enviado!');
  } catch (err) {
    // Loga e RELANÇA — quem chama decide se ignora ou propaga
    console.error('⚠️  Telegram erro:', err.response?.data?.description || err.message);
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
      console.log(`📅 Calendário: ${events.length} eventos de alto impacto carregados`);
      return events;
    }
  } catch (err) {
    console.log(`📅 Calendário API falhou: ${err.message} — usando recorrentes`);
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
  // RSI > 55 = momentum bullish ativo | RSI < 45 = momentum bearish ativo | 45-55 = sem direção
  const rsiTrendSig = rsi > 55 ? 'COMPRA' : rsi < 45 ? 'VENDA' : 'NEUTRO';

  // 4. Breakout (exclui vela atual — senão close nunca > próprio high)
  const prevCandles = candles15m.slice(-21, -1);
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
    sl = price - 1.5 * atr;
    tp = price + 3.0 * atr;
  } else if (score < 0) {
    sl = price + 1.5 * atr;
    tp = price - 3.0 * atr;
  }

  // ADX — força da tendência
  const { adx, pdi, mdi } = calcADX(candles15m);
  const adxTrend    = adx >= 40 ? 'FORTE'    : adx >= 25 ? 'MODERADA' : adx >= 15 ? 'FRACA' : 'LATERAL';
  const adxOk       = adx >= 25;   // abaixo de 25 = mercado lateral, tendência pouco confiável
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
  const signal = {
    asset: assetName, price, dec, score, rawScore, masterLabel, masterEmoji, tf,
    trendSig, emaSig, rsiTrendSig, bkSig,
    rsi, rsiSig, rsiReversalAlert, bb,
    atr, entry, sl, tp, tfConfluence: [tf],
    adx, pdi, mdi, adxTrend, adxOk, adxDir,
    sr, div
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
    msg += `\n🔀 <b>Divergência Detectada:</b>\n`;
    for (const d of s.div.divergences) {
      const emoji = d.type.startsWith('bullish') ? '🟢' : '🔴';
      msg += `  ${emoji} ${d.label}\n`;
    }
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
    console.log(`🚫 Alerta ${key} suprimido: fonte é Simulação — sem dados reais da API`);
    return;
  }
  // Não dispara alerta com mercado fechado
  if (data.isMarketClosed) {
    console.log(`🔒 Alerta ${key} suprimido: mercado fechado`);
    return;
  }
  // Grace period: após restart, espera 2min para estabilizar dados antes de alertar
  if (Date.now() - SERVER_START_AT < STARTUP_GRACE_MS) {
    console.log(`⏳ Alerta ${key} suprimido: grace period pós-restart`);
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
    console.log(`🚫 Alerta ${cfg.name} suprimido: ${reason}`);
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
    console.log(`${riskReason}`);
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

  if ((masterChanged || reversalChanged) && cooldownOk && !filterBlock && !riskFilterBlock) {
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
      console.error(`❌ Falha ao entregar alerta ${cfg.name} — será retentado no próximo ciclo`);
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
  if (removed > 0) console.log(`⚠️  ${source}: ${removed} candles inválidos removidos de ${candles.length}`);
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
  const res = await axios.get('https://api.kraken.com/0/public/OHLC', {
    params: { pair: 'XBTUSD', interval: 15 }, // interval em minutos
    timeout: 12000,
  });
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
    console.log(`⚡ BTC Kraken: $${data.price.toFixed(0)}`);
  } catch (e) {
    console.log('⚠️  Kraken poll BTC:', e.message, '— mantendo cache anterior');
  }
}

// Alias para compatibilidade com o boot
async function loadBtcHistory() {
  await pollBtcKraken();
}
function connectBinanceWS() {
  // Binance bloqueado nos EUA (Railway us-west). Usando Kraken como fonte de BTC.
  console.log('ℹ️  Binance desabilitado (bloqueio 451 EUA) — BTC via Kraken polling a cada 2min');
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
      console.log(`⚡ OANDA ${cfg.name}: ${data.price.toFixed(cfg.decimals)}`);
    } catch (e) {
      console.log(`⚠️  OANDA poll ${key}: ${e.message}`);
    }
  }
}

// ===== BUSCA TWELVE DATA =====
async function fetchFromTwelveData(symbol) {
  // Busca velas de 15min — suficiente para agregar em 1h, 4h e daily
  const res = await axios.get('https://api.twelvedata.com/time_series', {
    params: { symbol, interval: '15min', outputsize: 600, apikey: TWELVE_DATA_KEY },
    timeout: 10000
  });
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

  const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
    params:  { interval: '15m', range: '5d' },
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingDashboard/1.0)' },
    timeout: 12000,
  });

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
      console.log(`📊 Yahoo ${cfg.name}: ${data.price.toFixed(cfg.decimals)}`);
    } catch (e) {
      console.log(`⚠️  Yahoo poll ${key}: ${e.message}`);
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
    console.log(`🔒 ${cfg.name}: mercado fechado — sem chamada à API`);
    return payload;
  }

  // ── Tenta OANDA para XAU/EUR/JPY se chave configurada ───────────────────
  if (OANDA_API_KEY && OANDA_INSTRUMENT[key]) {
    try {
      const now  = Date.now();
      const data = { ...await fetchFromOanda(key), asset: cfg.name, updatedAt: now, nextUpdateAt: now + OANDA_POLL_MS };
      cache[key] = { data, updatedAt: now };
      console.log(`✅ ${cfg.name}: ${data.price.toFixed(cfg.decimals)} [OANDA]`);
      return data;
    } catch (oandaErr) {
      console.log(`⚠️  OANDA ${key}: ${oandaErr.message} — tentando Twelve Data...`);
    }
  }

  // ── Fallback 1: Yahoo Finance (gratuito, sem API key) ─────────────────────
  if (false && YAHOO_SYMBOLS[key]) {
    console.log(`📥 Buscando ${cfg.name} via Yahoo Finance...`);
    try {
      const now  = Date.now();
      const data = { ...await fetchFromYahoo(key), asset: cfg.name, updatedAt: now, nextUpdateAt: now + CACHE_TTL_MS };
      cache[key] = { data, updatedAt: now };
      console.log(`✅ ${cfg.name}: ${data.price.toFixed(cfg.decimals)} [Yahoo Finance]`);
      return data;
    } catch (yahooErr) {
      console.log(`⚠️  Yahoo ${key}: ${yahooErr.message} — tentando Twelve Data...`);
    }
  }

  // ── Fallback 2: Twelve Data ───────────────────────────────────────────────
  console.log(`📥 Buscando ${cfg.name} via Twelve Data...`);
  try {
    const now  = Date.now();
    const data = { ...await fetchFromTwelveData(cfg.symbol), asset: cfg.name, updatedAt: now, nextUpdateAt: now + CACHE_TTL_MS };
    cache[key] = { data, updatedAt: now };
    console.log(`✅ ${cfg.name}: ${data.price.toFixed(cfg.decimals)} [Twelve Data]`);
    return data;
  } catch (err) {
    console.log(`❌ ${cfg.name} erro: ${err.message} — fallback simulação`);
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

// ===== AUTENTICAÇÃO VIP =====
// Protege todas as rotas /api/vip/* com token via header ou query string
// Header:       Authorization: Bearer SEU_TOKEN
// Query string: ?token=SEU_TOKEN
// Se VIP_TOKEN não estiver configurado no .env, acesso é bloqueado por segurança
function vipAuth(req, res, next) {
  if (!VIP_TOKEN) {
    return res.status(503).json({
      error: 'VIP não configurado',
      detail: 'Configure VIP_TOKEN nas variáveis de ambiente do Railway'
    });
  }
  const header = req.headers['authorization'] || '';
  const tokenFromHeader = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const tokenFromQuery  = req.query.token || '';
  const provided = tokenFromHeader || tokenFromQuery;

  if (!provided || provided !== VIP_TOKEN) {
    return res.status(401).json({ error: 'Token inválido ou ausente' });
  }
  next();
}

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
    console.log(`⚠️  attachSignals ${key}:`, e.message);
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

  const data = await getAsset(assetKey);
  const entryCandles = data[entryKey] || [];
  const biasCandles  = data[biasKey]  || [];

  if (entryCandles.length < 55 || biasCandles.length < 30) {
    return {
      success: false,
      asset: assetKey,
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
      score: 0, status: 'NO_BIAS',
      filters: { emaAligned: false, breakout20: false, adxOk: false, sessionOk: false, newsBlocked: false },
      levels: null, meta: { reason: 'EMAs sem tendência definida no timeframe de viés' },
    };
  }

  // FILTRO 2: EMAs alinhadas no entry TF
  const filterEma = emaAligned(closes, direction);

  // FILTRO 3: Breakout de 20 barras
  const filterBreakout = hasBreakout(entryCandles, direction, 20);

  // FILTRO 4: ADX >= 25
  const { adx, pdi, mdi } = calcADX(entryCandles);
  const filterAdx = adx >= 25;

  // FILTRO 5A: Sessão ideal
  const sessionInfo = getSessionInfo(assetKey);
  const filterSession = sessionInfo.isGood;

  // FILTRO 5B: Sem notícia forte
  await fetchEconomicCalendar();
  const newsInfo = getNewsStatus(assetKey);
  const newsBlocked = newsInfo.isNearNews;

  // Score: ema(2) + breakout(2) + adx(2) + session(1) = máx 7
  let score = 0;
  if (filterEma)      score += 2;
  if (filterBreakout) score += 2;
  if (filterAdx)      score += 2;
  if (filterSession)  score += 1;

  // Níveis operacionais (ATR-based, RR 1:2 fixo)
  const atr = calcATR(entryCandles) || (price * 0.001);
  let entry = price, sl, tp;
  if (direction === 'BUY') {
    sl = parseFloat((entry - 1.5 * atr).toFixed(cfg.decimals));
    tp = parseFloat((entry + 3.0 * atr).toFixed(cfg.decimals));
  } else {
    sl = parseFloat((entry + 1.5 * atr).toFixed(cfg.decimals));
    tp = parseFloat((entry - 3.0 * atr).toFixed(cfg.decimals));
  }

  const vipOperationalContext = getOperationalContext(assetKey, {
    score,
    audit: {
      regime: adx >= 40 ? 'TREND_FORTE' : adx >= 25 ? 'TREND_MODERADA' : adx >= 15 ? 'TREND_FRACA' : 'LATERAL',
      session: { isGood: filterSession, label: sessionInfo.sessionStr },
      news: { isBlocked: newsBlocked, name: newsInfo.nearName, time: newsInfo.nearTimeStr },
    }
  });

  let status, reason;
  if (newsBlocked) {
    status = 'NEWS_BLOCKED';
    reason = `Bloqueado por notícia: ${newsInfo.nearName || 'evento de alto impacto'} (${newsInfo.nearTimeStr || ''})`;
  } else if (AUTO_BLOCK_WEAK_CONTEXT && vipOperationalContext?.status === 'EVITAR') {
    status = 'CONTEXT_BLOCKED';
    reason = `Bloqueado por contexto: ${vipOperationalContext.detail}`;
  } else if (score >= 7) {
    status = 'VALID_SIGNAL';
    reason = `Todos os filtros passaram. ${direction === 'BUY' ? '📈 Compra' : '📉 Venda'} confirmada.`;
  } else if (score >= 4) {
    status = 'PARTIAL_SIGNAL';
    reason = `Filtros parciais (${score}/7). Aguardar confirmação adicional.`;
  } else {
    status = 'NO_SIGNAL';
    reason = `Condições insuficientes (${score}/7). Sem setup VIP no momento.`;
  }

  const result = {
    success:   true,
    asset:     assetKey,
    biasTf,
    entryTf,
    direction,
    score,
    status,
    filters: {
      emaAligned:  filterEma,
      breakout20:  filterBreakout,
      adxOk:       filterAdx,
      sessionOk:   filterSession,
      newsBlocked: newsBlocked,
      contextBlocked: AUTO_BLOCK_WEAK_CONTEXT && vipOperationalContext?.status === 'EVITAR',
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
    },
    operationalContext: vipOperationalContext,
    generatedAt: Date.now(),
  };

  // Scan mode: não grava no histórico nem envia Telegram
  if (!skipPersist) {
    tradeStore.appendSignal(result);
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
    const scoreBar = '🟡'.repeat(result.score) + '⚫'.repeat(7 - result.score);
    const f = result.filters;
    const L = result.levels;
    const vipMsg = [
      `⭐ <b>ÁREA VIP — ${statusLabel}</b>`,
      ``,
      `<b>${cfg.name}</b> ${dirEmoji} <b>${direction}</b>  |  Score: ${result.score}/7`,
      `${scoreBar}`,
      ``,
      `🎯 <b>Níveis</b>`,
      `Entry: <b>${L.entry}</b>`,
      `Stop:  <b>${L.sl}</b>  (-1.5×ATR)`,
      `Alvo:  <b>${L.tp}</b>  (+3.0×ATR)`,
      `ATR: ${L.atr}  |  R:R 1:2`,
      ``,
      `📋 <b>Filtros</b>`,
      `${f.emaAligned  ? '✅' : '❌'} EMAs alinhadas (${entryTf})`,
      `${f.breakout20  ? '✅' : '❌'} Breakout 20 barras`,
      `${f.adxOk       ? '✅' : '❌'} ADX ${result.meta.adx} (≥25)`,
      `${f.sessionOk   ? '✅' : '❌'} Sessão: ${result.meta.session}`,
      `${!f.newsBlocked ? '✅' : '⚠️'} Notícias: ${f.newsBlocked ? 'BLOQUEADO' : 'Livre'}`,
      ``,
      `🧭 <b>Contexto Operacional</b>`,
      `${result.operationalContext.status} — ${result.operationalContext.summary}`,
      `${result.operationalContext.detail}`,
      ``,
      `Bias: ${biasTf.toUpperCase()}  |  Entry: ${entryTf.toUpperCase()}`,
    ].join('\n');

    sendTelegram(vipMsg).catch(() => {});
    lastSignals[vipAlertKey] = { lastSentAt: Date.now() };
    saveLastSignals();
  }

  return result;
}

// ===== ROTAS VIP =====

app.get('/api/vip/signal', rateLimit, vipAuth, async (req, res) => {
  const asset   = (req.query.asset   || 'xauusd').toLowerCase();
  const entryTf = (req.query.entryTf || '15m').toLowerCase();
  const biasTf  = (req.query.biasTf  || '1h').toLowerCase();
  if (!ASSETS[asset]) return res.status(404).json({ success: false, error: `Ativo não encontrado: ${asset}` });
  const validTfs = ['15m', '1h', '4h', 'daily', '1d'];
  if (!validTfs.includes(entryTf)) return res.status(400).json({ success: false, error: `entryTf inválido` });
  if (!validTfs.includes(biasTf))  return res.status(400).json({ success: false, error: `biasTf inválido` });
  try {
    const signal = await computeVipSignal(asset, entryTf, biasTf);
    res.json(signal);
  } catch (err) {
    console.error('⚠️  VIP signal error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/vip/signals', rateLimit, vipAuth, (req, res) => {
  const { asset, status, limit } = req.query;
  const signals = tradeStore.listSignals({ asset, status, limit: parseInt(limit) || 100 });
  res.json({ success: true, count: signals.length, signals });
});

app.post('/api/vip/trades/open', rateLimit, vipAuth, async (req, res) => {
  const { asset, direction, entry, sl, tp, atr, rr, score, biasTf, entryTf, session, reason } = req.body;
  if (!asset || !direction || entry == null || sl == null || tp == null)
    return res.status(400).json({ success: false, error: 'Campos obrigatórios: asset, direction, entry, sl, tp' });
  if (!['BUY', 'SELL'].includes((direction || '').toUpperCase()))
    return res.status(400).json({ success: false, error: 'direction deve ser BUY ou SELL' });
  if (!ASSETS[asset.toLowerCase()])
    return res.status(404).json({ success: false, error: `Ativo não encontrado: ${asset}` });

  try {
    const freshSignal = await computeVipSignal(asset.toLowerCase(), entryTf || '15m', biasTf || '1h', { skipPersist: true });
    const blockedStatuses = ['NEWS_BLOCKED', 'CONTEXT_BLOCKED', 'NO_SIGNAL', 'NO_BIAS', 'INSUFFICIENT_DATA'];
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

app.post('/api/vip/trades/close', rateLimit, vipAuth, (req, res) => {
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

app.get('/api/vip/trades', rateLimit, vipAuth, (req, res) => {
  const { asset, status, limit } = req.query;
  const trades = tradeStore.listTrades({ asset, status, limit: parseInt(limit) || 100 });
  res.json({ success: true, count: trades.length, trades });
});

app.get('/api/vip/stats', rateLimit, vipAuth, (req, res) => {
  const { asset } = req.query;
  const stats = tradeStore.getStats({ asset });
  res.json({ success: true, stats });
});

/**
 * GET /api/vip/scan?entryTf=15m&biasTf=4h
 * Escaneia todos os ativos de uma vez e retorna resumo de cada um
 */
app.get('/api/vip/scan', rateLimit, vipAuth, async (req, res) => {
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
        getAsset(key).catch(e => console.log(`⚠️  Auto-refresh ${key} falhou: ${e.message}`));
      }
    }
  } catch (err) {
    console.error('Erro ao buscar dados para backtester:', err.message);
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
    oanda:         OANDA_API_KEY  ? `✅ configurado (${OANDA_PRACTICE ? 'prática' : 'real'})` : 'ℹ️ não configurado (usando Twelve Data)',
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

// ===== AUTO-REFRESH + ALERTAS =====
// Com fontes real-time ativas, o ciclo roda a cada 5 min para processar alertas.
// Yahoo Finance (sempre disponível) mantém ciclos de 5 min; OANDA mantém 2 min.
const ALERT_INTERVAL_MS = OANDA_API_KEY ? 2 * 60 * 1000 : 5 * 60 * 1000;

setInterval(async () => {
  for (const key of Object.keys(ASSETS)) {
    try {
      const data = await getAsset(key);
      await checkAndSendAlerts(key, data);
      if (data['15m']?.length) {
        tradeStore.evaluateLiveSignals({ asset: key, candles: data['15m'], tf: '15m', horizonCandles: 4 });
      }

      if (!data.isSimulation && !data.isMarketClosed) {
        try {
          await computeVipSignal(key, '15m', '1h', { skipPersist: false });
        } catch (vipErr) {
          console.log(`⚠️  VIP scan ${key}:`, vipErr.message);
        }
      }
    } catch (err) {
      console.log(`⚠️  Erro no ciclo de ${key}:`, err.message);
    }
  }
}, ALERT_INTERVAL_MS);

// Kraken polling BTC a cada 2 min
setInterval(pollBtcKraken, 2 * 60 * 1000);

// OANDA polling separado a cada 2 min (independente do ciclo de alertas)
if (OANDA_API_KEY) {
  setInterval(pollOanda, OANDA_POLL_MS);
}

// Yahoo Finance polling desativado: Twelve Data voltou a ser o fallback principal

// ===== START =====
app.listen(PORT, async () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  🚀 Trading Dashboard v${VERSION} — ${Object.keys(ASSETS).length} ativos     ║`);
  console.log(`║  🔗 http://localhost:${PORT}               ║`);
  console.log(`║  📊 Ativos: ${Object.values(ASSETS).map(a=>a.name).join(' | ')}   ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  if (TWELVE_DATA_KEY === 'COLE_SUA_CHAVE_AQUI') {
    console.log('⚠️  TWELVE_DATA_KEY não configurada — usando como fallback apenas\n');
  }

  // ── Binance WebSocket (BTC) ──────────────────────────────────────────────
  console.log('🔗 Iniciando Binance WebSocket (BTC)...');
  await loadBtcHistory();   // carrega histórico inicial via REST
  connectBinanceWS();       // conecta stream em tempo real

  // ── OANDA (XAU/EUR/JPY) ─────────────────────────────────────────────────
  if (OANDA_API_KEY) {
    console.log(`⚡ OANDA_API_KEY detectada — XAU/EUR/JPY em tempo real (${OANDA_PRACTICE ? 'prática' : 'real'})`);
    await pollOanda(); // carrega histórico inicial via REST
  } else {
    // Sem OANDA: Twelve Data volta a ser a fonte principal para XAU/EUR/JPY.
    console.log('📥 OANDA não configurado — usando Twelve Data para XAU/EUR/JPY...');
  }

  // Carga inicial dos ativos restantes (só se ainda sem dados reais)
  for (const key of Object.keys(ASSETS).filter(k => k !== 'btc')) {
    if (!cache[key].data || cache[key].data.isSimulation) {
      getAsset(key).catch(e => console.log(`⚠️  ${key}: ${e.message}`));
    }
  }
});
