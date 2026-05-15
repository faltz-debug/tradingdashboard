require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const http      = require('http');
const authStore = require('./authStore');

// Fonte única de verdade para parâmetros do Master Signal
// (compartilhado com backtester.html e dashboard.html via /signal-config.js)
const MASTER_SIGNAL_CFG = require('./signal-config');

// Logger estruturado com níveis e timestamps (configurável via LOG_LEVEL env var)
const logger = require('./logger');

// Indicadores técnicos (módulo extraído — funções puras de análise técnica).
// Os demais indicadores (EMA/RSI/MACD/Bollinger/ADX/Ichimoku/VWAP/Fibo),
// todos os filtros, contexto externo (DXY, Fear & Greed) e calcATR sao
// consumidos internamente por src/services/signals.js e
// src/services/alerts.js apos as extracoes.
const {
  calcSupportResistance,
  detectDivergence,
} = require('./src/services/indicators');

// Estado compartilhado: config de ativos, cache de mercado.
// SESSION_HOURS e ASSET_BEST_SESSIONS sao consumidos diretamente pelo
// modulo src/services/context.js apos a extracao da camada de contexto.
const {
  ASSETS,
  cache,
  isCacheValid,
} = require('./src/services/state');

// Telegram: envio de alertas, estado de sinais persistido (lastSignals).
// Os demais simbolos (STARTUP_GRACE_MS, SERVER_START_AT, SIGNALS_FILE,
// saveLastSignals, fmt, buildTelegramMessage) sao consumidos internamente
// por src/services/alerts.js apos a extracao da camada de alertas.
const {
  ALERT_COOLDOWN_MS,
  lastSignals,
  sendTelegram,
} = require('./src/services/telegram');

// Fontes de dados de mercado (MT5, Kraken, OANDA, Finnhub, Twelve Data)
const {
  TWELVE_DATA_KEY,
  OANDA_API_KEY,
  OANDA_PRACTICE,
  OANDA_POLL_MS,
  FINNHUB_API_KEY,
  MT5_FEED_FILE,
  MT5_FEED_MAX_AGE_MS,
  mt5BridgeState,
  normalizeEpochMs,
  getPreferredMt5Snapshot,
  readMt5SnapshotFromFile,
  isMarketOpen,
  validateCandles,
  agregateCandles,
  axiosWithRetry,
  pollBtcKraken,
  loadBtcHistory,
  pollOanda,
  pollFinnhub,
  getAsset,
} = require('./src/services/dataSources');

// Motor de sinais (computeSignals/computeVipSignal + cache + helpers).
// Sessoes/news/calendario importados diretamente de src/services/context.js
// dentro do proprio modulo — nao ha mais setContextProviders.
const signals = require('./src/services/signals');
const {
  computeSignals,
  computeVipSignal,
  _signalCache,
  SIGNAL_CACHE_TTL_MS: SIGNAL_CACHE_TTL,
} = signals;

// Camada de alertas + manutencao de trades + relatorio semanal.
// Tambem consome context.js direto (sem injecao via setContextProviders).
const alerts = require('./src/services/alerts');
const {
  checkAndSendAlerts,
  attachSignals,
  checkOpenTradesForExit,
  sendWeeklyReport,
} = alerts;

// Contexto operacional: sessoes de mercado + calendario economico de alto
// impacto. Consumido aqui para alimentar o system router (rota /api/news).
// signals.js e alerts.js importam direto desse mesmo modulo.
const {
  fetchEconomicCalendar,
  getNewsStatus,
  getNewsCache,
} = require('./src/services/context');

// Webhook do bot MT5 (auto-open) com idempotency cache por trade.id.
// Extraido de alerts.js para isolamento + testabilidade da camada de execucao.
const { callBotWebhook } = require('./src/services/botWebhook');

// Scheduler: timers de alertas/scan/auto-trade, polling de fontes e WebSocket
// do dashboard. Mantem o estado mutavel de auto-trade (toggle + cooldown por
// ativo) — exposto via setAutoTradeEnabled/getAutoTradeEnabled/getAutoTradeLastAt
// para as rotas admin abaixo.
const scheduler = require('./src/scheduler');

// Camada de rate-limit + autenticacao/autorizacao + bootstrap admin.
// VIP_TOKEN, ADMIN_EMAIL/PASSWORD/NAME/TELEGRAM sao lidos diretamente do
// process.env dentro do modulo (mesmo padrao de alerts.js).
const {
  rateLimit,
  rateLimitLogin,
  authenticateRequest,
  requireAuth,
  requireAdmin,
  requireVipAccess,
  bootstrapAdminAccount,
  startRateLimitCleanup,
  getRequestIp,
  buildPublicUser,
} = require('./src/middleware/auth');

// Routers Express por dominio. Cada modulo expoe createXxxRouter(deps) e
// devolve um Router com middlewares aplicados — evita dependencias compartilhadas
// implicitas via closure.
const { createAuthRouter }   = require('./src/routes/auth');
const { createAdminRouter }  = require('./src/routes/admin');
const { createVipRouter }    = require('./src/routes/vip');
const { createMarketRouter } = require('./src/routes/market');
const { createMt5Router }    = require('./src/routes/mt5');
const { createSystemRouter }  = require('./src/routes/system');
const { createBacktestRouter } = require('./src/routes/backtest');

const app = express();
const server = http.createServer(app);

// CORS — lista de origens permitidas
// FRONTEND_ORIGIN=https://app.example.com,https://other.example.com
// Se não configurado em produção (NODE_ENV=production), bloqueia todas as
// origens desconhecidas. Em desenvolvimento aceita qualquer localhost.
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

app.use(cors({
  origin: function(origin, callback) {
    // Permite requisições sem origin (curl, Postman, server-to-server, mobile apps)
    if (!origin) return callback(null, true);
    // Permite localhost em desenvolvimento
    if (!IS_PRODUCTION && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
      return callback(null, true);
    }
    // Permite *.up.railway.app (deploy Railway)
    if (origin.endsWith('.up.railway.app')) return callback(null, true);
    // Permite origens explicitamente configuradas (ou wildcard '*')
    if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    // Bloqueia origens não reconhecidas
    callback(new Error('Blocked by CORS: ' + origin));
  },
  methods: ['GET', 'POST', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
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
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }
  }
}));

const VERSION          = '6.0.0';
const PORT             = process.env.PORT || 3000;
// TWELVE_DATA_KEY importado de src/services/dataSources.js
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const VIP_TOKEN        = process.env.VIP_TOKEN        || '';
const ALLOW_PUBLIC_SIGNUP = process.env.ALLOW_PUBLIC_SIGNUP === 'true';
const DEFAULT_SIGNUP_ACCESS_STATUS = process.env.DEFAULT_SIGNUP_ACCESS_STATUS || 'trial';
const DEFAULT_SIGNUP_PLAN_CODE = process.env.DEFAULT_SIGNUP_PLAN_CODE || 'starter';
// ADMIN_EMAIL/PASSWORD/NAME/TELEGRAM lidos em src/middleware/auth.js (bootstrapAdminAccount).
const AUTO_BLOCK_WEAK_CONTEXT = process.env.AUTO_BLOCK_WEAK_CONTEXT !== 'false';
const LOCAL_SAFE       = process.env.LOCAL_SAFE !== 'false';
const TELEGRAM_ENABLED = !LOCAL_SAFE && !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID);
// CACHE_TTL_MS consumido internamente em src/services/dataSources.js
// MT5_FEED_FILE, MT5_FEED_MAX_AGE_MS importados de src/services/dataSources.js
const DASHBOARD_PUSH_MS = parseInt(process.env.DASHBOARD_PUSH_MS || '1000', 10);
const MT5_PUSH_TOKEN   = process.env.MT5_PUSH_TOKEN || '';
// mt5FeedHealthState (interno) em dataSources.js
const VIP_SIGNAL_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h cooldown para sinais/trades VIP

// ===== INTERVALO DE ALERTAS =====
// Prioridade: OANDA (2min) > Finnhub (2min) > padrão Twelve Data (5min).
// O loop principal vive em src/scheduler.js (_scheduleAlertScan); aqui
// declaramos cedo porque /api/health (em src/routes/system.js) reporta o
// intervalo via factory.
const ALERT_INTERVAL_MS = (OANDA_API_KEY || FINNHUB_API_KEY) ? 2 * 60 * 1000 : 5 * 60 * 1000;

// ── BOT WEBHOOK (execução automática no MT5) ────────────────────────────────
// BOT_WEBHOOK_URL e BOT_WEBHOOK_TOKEN agora sao lidos diretamente de
// process.env dentro de src/services/alerts.js (callBotWebhook).
const BOT_WEBHOOK_ENABLED = process.env.BOT_WEBHOOK_ENABLED === 'true';
const AUTO_OPEN_SCORE_THRESHOLD = parseFloat(process.env.AUTO_OPEN_SCORE_THRESHOLD || '7.0');

// ── AUTO-TRADE (liga/desliga em runtime sem reiniciar) ────────────────────────
// AUTO_TRADE_MODE=true no .env = começa ligado; false = começa desligado (manual)
// O estado mutavel (enabled + lastAt por ativo) vive em src/scheduler.js;
// aqui ficam apenas o valor inicial e a constante de cooldown (compartilhada
// com scheduler.start({...}) e exposta na rota /api/admin/auto-trade/status).
const AUTO_TRADE_MODE_INITIAL        = process.env.AUTO_TRADE_MODE === 'true';
const AUTO_TRADE_COOLDOWN_MS         = parseInt(process.env.AUTO_TRADE_COOLDOWN_MS || String(4 * 60 * 60 * 1000), 10);
// Pyramiding: permite ate N trades abertos por ativo com cooldown proprio
// AUTO_TRADE_MAX_PER_ASSET=1 -> comportamento padrao (sem duplicacao)
// AUTO_TRADE_MAX_PER_ASSET=3 -> permite ate 3 posicoes por ativo (30min entre cada)
const AUTO_TRADE_MAX_PER_ASSET       = parseInt(process.env.AUTO_TRADE_MAX_PER_ASSET        || '1',  10);
const AUTO_TRADE_PYRAMID_COOLDOWN_MS = parseInt(process.env.AUTO_TRADE_PYRAMID_COOLDOWN_MS  || String(30 * 60 * 1000), 10);
const AUTO_TRADE_PYRAMID_INITIAL     = process.env.AUTO_TRADE_PYRAMID === 'true';
scheduler.setAutoTradeEnabled(AUTO_TRADE_MODE_INITIAL);
scheduler.setPyramidEnabled(AUTO_TRADE_PYRAMID_INITIAL);

// ── OANDA, FINNHUB — importados de src/services/dataSources.js ──────────────

// ── ASSET_MAX_SCORE consumido internamente em src/services/signals.js ──

// ===== TELEGRAM ALERTS =====
// ALERT_COOLDOWN_MS,
// lastSignals — importado de src/services/telegram.js

// ===== RETRY COM BACKOFF EXPONENCIAL =====
// axiosWithRetry importado de src/services/dataSources.js

// sendTelegram importado de src/services/telegram.js

// ===== CÁLCULO DE SINAIS (fonte única — dashboard consome via data.signals) =====
// Sessoes de mercado + calendario economico migraram para
// src/services/context.js (consumido diretamente por signals.js / alerts.js,
// sem setContextProviders).

// classifyMasterScore migrado para src/services/signals.js
// (re-exportado por signals — usado apenas internamente lá pelo buildSignalAudit)

// buildSignalAudit migrado para src/services/signals.js

// getOperationalContext migrado para src/services/signals.js

// getOperationalSnapshot migrado para src/services/signals.js

// computeSignals migrado para src/services/signals.js (re-importado no topo)


// checkAndSendAlerts migrado para src/services/alerts.js

// isMarketOpen, buildMarketClosedPayload, validateCandles, agregateCandles,
// normalizeEpochMs, normalizeMt5Candles, generateFallback, mt5BridgeState,
// readMt5SnapshotFromFile, getPreferredMt5Snapshot, buildMt5AssetData,
// readMt5FeedAsset, fetchBtcFromKraken, pollBtcKraken, loadBtcHistory,
// fetchFromOanda, pollOanda, pollFinnhub, fetchFromTwelveData, getAsset
// — todos importados de src/services/dataSources.js

// ===== RATE LIMITING + AUTENTICACAO / AUTORIZACAO =====
// rateLimit, authenticateRequest, requireAuth/Admin/VipAccess,
// bootstrapAdminAccount, getRequestIp, getRequestToken, buildPublicUser e
// startRateLimitCleanup() vivem em src/middleware/auth.js (importados no topo).
// O estado interno (rateLimitMap) tambem foi para la.
startRateLimitCleanup();
app.use(authenticateRequest);

// ===== SINAIS NA RESPOSTA DA API =====
// Computa e anexa sinais ao payload antes de devolver ao frontend
// Elimina a duplicação de lógica entre server.js e dashboard.html
// attachSignals migrado para src/services/alerts.js

// ===== ÁREA VIP — MOTOR DE SINAL =====
const tradeStore = require('./tradeStore');

// computeVipSignal migrado para src/services/signals.js (importado no topo).

// ===== ROTAS AUTH / ADMIN =====

// As 5 rotas /api/auth/* vivem em src/routes/auth.js
app.use('/api/auth', createAuthRouter({
  authStore,
  rateLimit,
  rateLimitLogin,
  requireAuth,
  getRequestIp,
  buildPublicUser,
  config: {
    ALLOW_PUBLIC_SIGNUP,
    DEFAULT_SIGNUP_ACCESS_STATUS,
    DEFAULT_SIGNUP_PLAN_CODE,
    VIP_TOKEN,
  },
}));

// As 7 rotas /api/admin/* vivem em src/routes/admin.js
app.use('/api/admin', createAdminRouter({
  authStore,
  scheduler,
  sendWeeklyReport,
  sendTelegram,
  rateLimit,
  requireAdmin,
  buildPublicUser,
  logger,
  mt5BridgeState,
  MT5_FEED_MAX_AGE_MS,
  config: {
    BOT_WEBHOOK_ENABLED,
    AUTO_OPEN_SCORE_THRESHOLD,
    AUTO_TRADE_COOLDOWN_MS,
    AUTO_TRADE_MAX_PER_ASSET,
    AUTO_TRADE_PYRAMID_COOLDOWN_MS,
  },
}));

// ===== ROTAS VIP =====
// _signalCache e SIGNAL_CACHE_TTL migrados para src/services/signals.js.
// As 8 rotas /api/vip/* vivem em src/routes/vip.js.
app.use('/api/vip', createVipRouter({
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
  config: { BOT_WEBHOOK_ENABLED, BOT_WEBHOOK_TOKEN: process.env.BOT_WEBHOOK_TOKEN || '' },
}));

// ===== ROTAS DE MERCADO =====
// Snapshots de ativos (/btc, /xauusd, /eurusd, /usdjpy), suporte/resistencia
// + divergencia (/analysis/:asset) e backtest-data consolidado vivem em
// src/routes/market.js.
app.use('/api', createMarketRouter({
  getAsset,
  attachSignals,
  calcSupportResistance,
  detectDivergence,
  ASSETS,
  cache,
  isCacheValid,
  rateLimit,
  logger,
}));

// ===== ROTAS MT5 (bridge feed + status) =====
app.use('/api', createMt5Router({
  mt5BridgeState,
  normalizeEpochMs,
  getPreferredMt5Snapshot,
  readMt5SnapshotFromFile,
  MT5_FEED_FILE,
  MT5_FEED_MAX_AGE_MS,
  rateLimit,
  logger,
  config: { MT5_PUSH_TOKEN, LOCAL_SAFE },
}));

// ===== ROTAS DO SISTEMA (health, telegram, news, live-signals, risk-state) =====
app.use('/api', createSystemRouter({
  ASSETS,
  cache,
  tradeStore,
  lastSignals,
  ALERT_COOLDOWN_MS,
  sendTelegram,
  fetchEconomicCalendar,
  getNewsStatus,
  newsCacheRef: { get: () => getNewsCache() },
  normalizeEpochMs,
  getPreferredMt5Snapshot,
  rateLimit,
  logger,
  config: {
    VERSION,
    TWELVE_DATA_KEY,
    TELEGRAM_TOKEN,
    TELEGRAM_CHAT_ID,
    TELEGRAM_ENABLED,
    LOCAL_SAFE,
    OANDA_API_KEY,
    OANDA_PRACTICE,
    FINNHUB_API_KEY,
    MT5_PUSH_TOKEN,
    MT5_FEED_MAX_AGE_MS,
    DASHBOARD_PUSH_MS,
    AUTO_BLOCK_WEAK_CONTEXT,
    ALERT_INTERVAL_MS,
  },
}));

// ===== ROTAS DE BACKTEST =====================================================
app.use('/api', createBacktestRouter({
  cache,
  ASSETS,
  rateLimit,
  requireAuth,
  logger,
}));

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
// checkOpenTradesForExit migrado para src/services/alerts.js

// ===== RELATÓRIO SEMANAL AUTOMÁTICO =====
/**
 * Gera e envia relatório de performance semanal via Telegram.
 * Chamado toda segunda-feira às 08:00 UTC.
 *
 * Usa os dados reais do live_signals + vip_signals acumulados no SQLite.
 * Não requer dados de candle em tempo real — trabalha só com histórico persistido.
 */
// sendWeeklyReport migrado para src/services/alerts.js

// Job de relatorio semanal migrado para src/scheduler.js (_scheduleWeeklyReport).
// O estado lastWeeklyReportDay tambem vive no scheduler agora.
// Endpoint manual /api/admin/weekly-report continua junto com os outros admin (mais abaixo).

// ===== AUTO-REFRESH + ALERTAS =====
// ALERT_INTERVAL_MS declarada acima (perto das outras constantes globais)
// porque /api/health (system router) la em cima ja consome o valor via
// factory injection. O loop principal vive em src/scheduler.js (_scheduleAlertScan).

// Polling de Kraken / OANDA / Finnhub migrado para src/scheduler.js (_schedulePolling).
// Yahoo Finance polling desativado: Twelve Data voltou a ser o fallback principal.

// WebSocket /ws + push de snapshot consolidado migrados para src/scheduler.js
// (_setupDashboardWss + buildDashboardSnapshot + pushDashboardSnapshot).

// ===== START =====
server.listen(PORT, async () => {
  logger.info(`Trading Dashboard v${VERSION} iniciado | porta ${PORT} | ${Object.keys(ASSETS).length} ativos: ${Object.values(ASSETS).map(a=>a.name).join(', ')}`);

  // bootstrapAdminAccount eh assincrono (faz readiness probe + retry com
  // backoff em SQLITE_BUSY/LOCKED) — await para garantir admin pronto
  // antes de qualquer requisicao ser processada.
  await bootstrapAdminAccount();

  if (TWELVE_DATA_KEY === 'COLE_SUA_CHAVE_AQUI') {
    logger.warn('TWELVE_DATA_KEY não configurada — usando Twelve Data apenas como fallback');
  }

  // ── BTC via Kraken REST polling (a cada 2min) ───────────────────────────
  logger.info('Carregando histórico BTC via Kraken...');
  await loadBtcHistory();

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

  // ── Scheduler: dispara timers de alertas/scan/auto-trade, polling e WSS ───
  scheduler.start({
    ASSETS,
    getAsset,
    checkAndSendAlerts,
    checkOpenTradesForExit,
    attachSignals,
    sendWeeklyReport,
    callBotWebhook,
    computeVipSignal,
    _signalCache,
    sendTelegram,
    pollBtcKraken,
    pollOanda,
    pollFinnhub,
    tradeStore,
    server,
    authStore,
    logger,
    config: {
      ALERT_INTERVAL_MS,
      BOT_WEBHOOK_ENABLED,
      AUTO_OPEN_SCORE_THRESHOLD,
      AUTO_TRADE_COOLDOWN_MS,
      AUTO_TRADE_MAX_PER_ASSET,
      AUTO_TRADE_PYRAMID_COOLDOWN_MS,
      OANDA_API_KEY,
      OANDA_POLL_MS,
      FINNHUB_API_KEY,
      DASHBOARD_PUSH_MS,
    },
  });
});
