# Arquitetura — Trading Dashboard v6.0.0

## Visão Geral

O servidor foi refatorado de um `server.js` monolítico (~3900 linhas) para uma estrutura modular com responsabilidades bem separadas. O `server.js` atual tem ~680 linhas e funciona apenas como ponto de entrada: carrega módulos, monta middlewares, registra rotas e dispara o scheduler.

```
server.js  (ponto de entrada — ~680 linhas)
├── src/
│   ├── services/       camada de lógica de negócio
│   ├── routes/         rotas Express por domínio
│   ├── middleware/     autenticação, rate-limit
│   ├── scheduler.js    timers, polling, WebSocket
│   └── ws/
│       └── server.js   WebSocket /ws (dashboard em tempo real)
└── src/tests/          testes unitários Jest
```

---

## Camada de Serviços (`src/services/`)

### `indicators.js` — 464 linhas
Funções puras de análise técnica. Sem I/O, sem estado global. Mesma entrada → mesma saída.

| Função | Descrição |
|--------|-----------|
| `calcEMA(closes, period)` | Média móvel exponencial |
| `calcRSI(closes, period=14)` | Relative Strength Index |
| `calcMACD(closes)` | MACD 12/26/9 → `{ macd, signal }` |
| `calcBollinger(closes, period=20)` | Bandas de Bollinger → `{ upper, mid, lower }` |
| `calcATR(candles, period=14)` | Average True Range |
| `calcADX(candles, period=14)` | ADX com Wilder smoothing → `{ adx, pdi, mdi }` |
| `calcSupportResistance(candles, lb=5)` | Swing highs/lows → `{ supports, resistances, nearestSup, nearestRes }` |
| `detectDivergence(candles, period=14)` | Divergência RSI/MACD → `{ divergences, hasBullish, hasBearish }` |
| `calcIchimoku(candles, direction)` | Nuvem Ichimoku |
| `calcSessionVwap(candles, direction)` | VWAP da sessão atual |
| `calcFibonacciLevels(candles, direction, lb=96)` | Níveis de Fibonacci |

### `filters.js` — 318 linhas
Filtros de trading. Puras, dependem apenas de `calcEMA` de `indicators.js`.

| Função | Descrição |
|--------|-----------|
| `emaAligned(closes, direction)` | EMA9 > EMA20 > EMA50 alinhadas |
| `hasBreakout(candles, direction, bars=20)` | Close além do range das últimas N velas |
| `hasInsideBar(candles, direction)` | Padrão mãe → inside bar → confirmação |
| `hasVolumeConfirmation(candles, mult=1.1)` | Volume acima da média (null se sem dados) |
| `hasBollingerSqueeze(closes, period=20, lb=20)` | Banda atual ≥ 15% abaixo da média histórica |
| `getEma200Context(candles, direction)` | Preço vs EMA200 (null se < 200 candles) |
| `hasPullbackEma20(candles, direction)` | Pullback tocou EMA20 na direção correta |
| `detectCMEGap(candles)` | Gap CME (abertura vs fechamento anterior) |
| `getBiasTf(candles)` | Bias do timeframe → `'BUY' \| 'SELL' \| 'NEUTRAL'` |

### `state.js` — 119 linhas
Singleton de configuração e cache. Qualquer módulo que importar `cache` acessa o mesmo objeto em memória (padrão Node.js singleton por `require()`).

| Export | Tipo | Descrição |
|--------|------|-----------|
| `ASSETS` | object | Config dos 4 ativos (btc, xauusd, eurusd, usdjpy) |
| `ASSET_MAX_SCORE` | object | Score máximo teórico por ativo |
| `cache` | object | Cache mutável de candles `{ [key]: { data, updatedAt } }` |
| `isCacheValid(key)` | function | Verifica TTL de 15min |
| `SESSION_HOURS` | object | Horários UTC das sessões (tokyo/london/ny/overlap) |
| `ASSET_BEST_SESSIONS` | object | Sessões ideais por ativo |

### `dataSources.js` — 738 linhas
Toda a lógica de busca de dados de mercado. Lê variáveis de ambiente diretamente.

**Fontes de dados (por prioridade):**
1. **MT5 Bridge** — feed push em tempo real via `POST /api/internal/mt5/feed`
2. **Kraken REST** — candles BTC (polling a cada 2min)
3. **OANDA** — XAU/EUR/JPY em tempo real (requer `OANDA_API_KEY`)
4. **Finnhub** — preço spot como alternativa ao OANDA (requer `FINNHUB_API_KEY`)
5. **Twelve Data** — fallback para candles históricos (requer `TWELVE_DATA_KEY`)
6. **Simulação** — geração de dados de fallback quando todas as fontes falham

**Variáveis de ambiente:**

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `TWELVE_DATA_KEY` | — | Chave API Twelve Data |
| `OANDA_API_KEY` | — | Chave OANDA (v20) |
| `OANDA_PRACTICE` | `false` | Conta prática OANDA |
| `FINNHUB_API_KEY` | — | Chave Finnhub |
| `MT5_FEED_FILE` | `data/mt5_feed.json` | Path do feed MT5 em arquivo |
| `MT5_FEED_MAX_AGE_MS` | `120000` | Idade máxima do feed (2min) |

### `telegram.js` — 263 linhas
Envio de alertas e estado persistido de sinais.

| Export | Descrição |
|--------|-----------|
| `sendTelegram(message)` | POST para Bot API (no-op se `LOCAL_SAFE=true`) |
| `fmt(v, dec)` | Formata preço para exibição |
| `buildTelegramMessage(s, sessionInfo, newsInfo)` | Monta HTML completo do alerta |
| `lastSignals` | Singleton `{ [key]: { lastSentAt, ... } }` — persistido em `data/lastSignals.json` |
| `saveLastSignals()` | Escrita atômica debounced (300ms, tmp + rename) |
| `ALERT_COOLDOWN_MS` | 1 hora entre alertas do mesmo ativo |
| `STARTUP_GRACE_MS` | 2min de grace period pós-restart |

### `marketContext.js` — 230 linhas
Contexto externo de mercado. Estado interno (caches de 15min), chamadas HTTP.

| Função | Descrição |
|--------|-----------|
| `fetchDxyTrend(direction)` | Tendência do Dollar Index via EMA9/20/50. Correlação inversa com XAU. |
| `fetchFearGreedIndex(direction)` | Fear & Greed 0–100 (Alternative.me). Bônus BUY em medo extremo, SELL em ganância. |

### `score.js` — 232 linhas
Camada de scoring e auditoria de sinais. Sem I/O.

Funções principais: `classifyMasterScore`, `buildSignalAudit`, `getOperationalContext`, `getOperationalSnapshot`.

### `signals.js` — 905 linhas
Motor principal de sinais. Maior módulo do projeto.

- `computeSignals(key, candles)` — calcula o sinal Master para um ativo no timeframe 15M
- `computeVipSignal(key, tf1, tf2)` — sinal VIP com confluência de 2 timeframes
- `setContextProviders({ getSessionInfo, getNewsStatus, fetchEconomicCalendar })` — injeta helpers que ainda vivem no `server.js`
- `_signalCache` / `SIGNAL_CACHE_TTL_MS` — cache de 7min por ativo+timeframe

### `alerts.js` — 565 linhas
Ciclo de alertas, monitoramento de trades abertos e relatório semanal.

- `checkAndSendAlerts(key, candles)` — verifica se deve enviar alerta Telegram
- `checkOpenTradesForExit(key, candles)` — detecta SL/TP atingido nas velas 15M
- `attachSignals(assetData, key)` — anexa sinais ao payload de resposta da API
- `sendWeeklyReport()` — relatório de performance toda segunda às 08:00 UTC
- `setContextProviders({ getSessionInfo, getNewsStatus })` — mesma injeção do signals.js

### `botWebhook.js` — 161 linhas
Execução automática no MT5 via webhook.

- `callBotWebhook(signal, trade)` — POST para o bot MT5 com idempotency cache de 24h por `trade.id`
- Lê `BOT_WEBHOOK_URL`, `BOT_WEBHOOK_TOKEN`, `AUTO_OPEN_SCORE_THRESHOLD` do `process.env`

---

## Rotas (`src/routes/`)

Todas as rotas usam o padrão **factory com injeção de dependências**: `createXxxRouter(deps)` recebe explicitamente tudo que precisa e devolve um `express.Router`. Isso elimina imports circulares e facilita testes.

| Arquivo | Prefixo | Rotas |
|---------|---------|-------|
| `auth.js` | `/api/auth` | `GET /config`, `POST /register`, `POST /login`, `POST /logout`, `GET /me` |
| `admin.js` | `/api/admin` | `GET /users`, `PATCH /users/:id`, `POST /weekly-report`, `GET /auto-trade/status`, `POST /auto-trade/toggle`, `GET /bot-webhook/status`, `POST /force-signal` |
| `vip.js` | `/api/vip` | `GET /signal`, `GET /trades`, `GET /trades/history`, `POST /trades/open`, `POST /trades/close/:id`, `POST /trades/update/:id`, `GET /scan`, `GET /checklist` |
| `market.js` | `/api` | `GET /btc`, `GET /xauusd`, `GET /eurusd`, `GET /usdjpy`, `GET /analysis/:asset`, `GET /backtest-data` |
| `mt5.js` | `/api` | `POST /internal/mt5/feed`, `GET /mt5/bridge-status` |
| `system.js` | `/api` | `GET /health`, `GET /telegram/test`, `POST /telegram/test`, `GET /telegram/status`, `GET /news`, `GET /live-signals`, `GET /live-signals/stats`, `GET /live-signals/executive`, `GET /risk-state` |

---

## Middleware (`src/middleware/auth.js`) — 260 linhas

| Export | Descrição |
|--------|-----------|
| `rateLimit` | 300 req/min por IP (genérico) |
| `rateLimitLogin` | **10 tentativas/15min por IP** (anti brute-force no login) |
| `authenticateRequest` | Lê Bearer token de sessão ou VIP token — popula `req.auth` |
| `requireAuth` | Bloqueia se não autenticado (401) |
| `requireAdmin` | Bloqueia se não admin (403) |
| `requireVipAccess` | Bloqueia se sem acesso VIP ativo |
| `bootstrapAdminAccount` | Cria conta admin no startup se `ADMIN_EMAIL` + `ADMIN_PASSWORD` configurados |

**Variáveis de ambiente de auth:**

| Variável | Descrição |
|----------|-----------|
| `ADMIN_EMAIL` | Email do admin criado no bootstrap |
| `ADMIN_PASSWORD` | Senha do admin |
| `ADMIN_NAME` | Nome exibido |
| `ADMIN_TELEGRAM` | Telegram do admin |
| `VIP_TOKEN` | Token legado para acesso VIP direto |
| `ALLOW_PUBLIC_SIGNUP` | `true` = cadastro aberto |

---

## Scheduler (`src/scheduler.js`) — 303 linhas

Gerencia todos os timers do sistema. Recebe todas as dependências via `scheduler.start({ ... })`.

**Jobs gerenciados:**

| Job | Intervalo | Descrição |
|-----|-----------|-----------|
| `_scheduleAlertScan` | 2–5min | Loop principal: `getAsset` → `checkAndSendAlerts` → `checkOpenTradesForExit` |
| `_scheduleAutoTrade` | junto com alertas | Auto-open de trades via bot webhook (se `BOT_WEBHOOK_ENABLED=true`) |
| `_schedulePolling` | 2min | Kraken + OANDA ou Finnhub |
| `_scheduleWeeklyReport` | diário 08:00 UTC | Segunda-feira dispara `sendWeeklyReport()` |
| `_setupDashboardWss` | push 1s | WebSocket `/ws` com snapshot consolidado dos 4 ativos |

**Estado de auto-trade:**
- `scheduler.setAutoTradeEnabled(bool)` — liga/desliga sem reiniciar
- `scheduler.getAutoTradeEnabled()` — lido pelas rotas admin
- `scheduler.getAutoTradeLastAt(key)` — timestamp do último trade por ativo (cooldown de 4h)

---

## WebSocket (`src/ws/server.js`) — 239 linhas

Endpoint `/ws` para o dashboard em tempo real.

- Autenticação opcional via `?token=` na URL de conexão
- Mensagens suportadas: `dashboard_ping` → `dashboard_pong`, `dashboard_refresh` → snapshot completo
- Push automático a cada `DASHBOARD_PUSH_MS` (padrão 1s) via `scheduler`

---

## Testes (`src/tests/`)

72 testes unitários Jest, todos passando.

| Arquivo | Testes | Cobertura |
|---------|--------|-----------|
| `indicators.test.js` | 40 | `calcEMA`, `calcRSI`, `calcMACD`, `calcBollinger`, `calcATR`, `calcADX`, `calcSupportResistance`, `detectDivergence` |
| `filters.test.js` | 32 | `emaAligned`, `hasBreakout`, `hasInsideBar`, `hasVolumeConfirmation`, `hasBollingerSqueeze`, `getEma200Context`, `hasPullbackEma20`, `detectCMEGap`, `getBiasTf` |

```bash
npx jest src/tests/
# ou após npm install:
npm test
```

---

## Variáveis de Ambiente — Resumo

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `PORT` | não (3000) | Porta HTTP |
| `NODE_ENV` | não | `production` fecha CORS para origens desconhecidas |
| `FRONTEND_ORIGIN` | prod | Origens CORS permitidas (vírgula-separado ou `*`) |
| `TELEGRAM_TOKEN` | não | Bot token para alertas |
| `TELEGRAM_CHAT_ID` | não | Chat/canal de destino |
| `LOCAL_SAFE` | não (`true`) | `false` = habilita envio real pelo Telegram |
| `TWELVE_DATA_KEY` | não | Fallback de candles históricos |
| `OANDA_API_KEY` | não | XAU/EUR/JPY em tempo real |
| `FINNHUB_API_KEY` | não | Alternativa ao OANDA |
| `VIP_TOKEN` | não | Token legado VIP |
| `ADMIN_EMAIL` | recomendado | Email admin para bootstrap |
| `ADMIN_PASSWORD` | recomendado | Senha admin |
| `BOT_WEBHOOK_URL` | não | URL do bot MT5 para auto-open |
| `BOT_WEBHOOK_ENABLED` | não | `true` = auto-trade ativo |
| `AUTO_OPEN_SCORE_THRESHOLD` | não (7.0) | Score mínimo para auto-open |
| `MT5_PUSH_TOKEN` | não | Token para autenticar o bridge MT5 |

---

## Dependência entre Módulos

```
indicators.js  ←──────────────────────────────────────┐
filters.js     ← indicators.js                         │
state.js       (sem deps internas)                     │
telegram.js    (sem deps internas)                     │
marketContext.js ← indicators.js                       │
dataSources.js ← state.js                              │
score.js       ← indicators.js, filters.js             │
signals.js     ← indicators.js, filters.js, score.js  │
               ← marketContext.js, state.js, telegram.js│
alerts.js      ← signals.js, telegram.js, state.js    │
botWebhook.js  (sem deps internas)                     │
scheduler.js   ← todos os serviços acima               │
routes/*       ← injeção via factory (sem imports diretos)
middleware/auth.js (sem deps internas)
server.js      ← tudo (ponto de entrada)
```

> **Nota:** `signals.js` e `alerts.js` recebem `getSessionInfo`, `getNewsStatus` e `fetchEconomicCalendar` via `setContextProviders()` — essas funções ainda residem no `server.js` e serão extraídas para `src/services/context.js` numa etapa futura.
