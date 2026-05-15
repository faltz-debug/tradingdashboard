# Roadmap: Trading Dashboard → Ferramenta Profissional Confiável

**Objetivo:** Transformar de "app interessante com sinais" para "ferramenta confiável para operar com dinheiro real"

**Timeline estimada:** 6-8 semanas de trabalho focado (~200 horas)

---

## FASE 1: UNIFICAÇÃO DE LÓGICA (Semana 1-2) — 40h
**Impacto:** CRÍTICO | **Bloqueador:** Sim

### 1.1 Criar classe Strategy única
**O problema:** Dashboard, VIP, Backtester cada um interpreta sinais diferente
**Solução:** Uma classe `TradingStrategy` central que todos chamam

```javascript
// trading-strategy.js — fonte única de verdade
class TradingStrategy {
  constructor(asset, timeframe) {
    this.asset = asset;
    this.tf = timeframe;
  }
  
  // Retorna sinal UNIFICADO usado por todos
  generateSignal(candles15m, candles1h, candles4h) {
    return {
      direction: 'BUY' | 'SELL' | 'NONE',
      confidence: 1-3,
      entryPrice: X,
      stopLoss: X,
      takeProfit: X,
      reasoning: {
        trendOk: bool,
        rsiOk: bool,
        confluenceOk: bool,
        adxOk: bool,
        sessionOk: bool,
        newsOk: bool,
        regime: 'TREND' | 'RANGE',
      },
      auditLog: { ... } // para rastreabilidade
    }
  }
}
```

**Arquivos a refatorar:**
- `server.js` → use `Strategy.generateSignal()` instead of `computeSignals()`
- `backtester.html` → use `Strategy.generateSignal()` for each trade
- `vip.html` → use `Strategy.generateSignal()` for scan
- `dashboard.html` → use `Strategy.generateSignal()` for live signals

**Critério de pronto:**
- [ ] Classe Strategy implementada e testada
- [ ] Dashboard usa Strategy
- [ ] VIP usa Strategy
- [ ] Backtester usa Strategy
- [ ] Telegram usa Strategy
- [ ] Sinais são idênticos em todos os 4 lugares

**Horas:** 40h

---

## FASE 2: BACKTEST REALISTA (Semana 3-4) — 35h
**Impacto:** ALTO | **Bloqueador:** Sim para traders operarem

### 2.1 Adicionar slippage
**O problema:** Backtest entra exato no SL, life entra 5 pips pior

```javascript
const SLIPPAGE = {
  BTC: 50,      // USD
  XAU: 0.50,    // USD
  EUR: 0.0005,  // pips (0.5 pips)
  JPY: 0.01,    // pips
};

// Na saída: aplica slippage negativo
exitPrice += SLIPPAGE[asset]; // SHORT: soma (piora)
exitPrice -= SLIPPAGE[asset]; // LONG: subtrai (piora)
```

### 2.2 Spread variável por hora
**O problema:** Spread é 1 pip de manhã, 10 pips antes de notícia

```javascript
const SPREAD = {
  '14:00-16:00': { BTC: 100, XAU: 0.3, EUR: 0.0003 }, // NY aberto
  '07:00-16:00': { BTC: 50,  XAU: 0.2, EUR: 0.0002 }, // London
  'default':     { BTC: 150, XAU: 0.5, EUR: 0.0005 },  // noite
};

const hourKey = new Date(candle.time * 1000).getHours();
const spread = SPREAD[hourKey] || SPREAD['default'];
```

### 2.3 Candle FECHADO obrigatoriamente
**O problema:** Backtest entra no 1º tick do candle, reality entra só na abertura

```javascript
// Backtester: só valida entrada na abertura do PRÓXIMO candle
if (signalBar === i) {
  // Entra na abertura do candle i+1 (fechado)
  entry = candles[i+1].open;
  entryTime = candles[i+1].time;
}
```

### 2.4 Filtros aplicados (sessão + notícia)
**O problema:** Backtest entra fora de horário mesmo com filtro no dashboard

```javascript
// Durante backtest: aplica mesmos filtros do live
const sessionOk = isGoodSession(asset, candle.time);
const newsOk = !isNearHighImpactNews(asset, candle.time);

if (!sessionOk || !newsOk) {
  signal = 'NONE'; // bloqueia entrada mesmo que EMA/RSI sinalize
}
```

**Critério de pronto:**
- [ ] Slippage aplicado e variável
- [ ] Spread variável por hora
- [ ] Entrada sempre no candle fechado
- [ ] Filtro de sessão aplicado
- [ ] Filtro de notícia aplicado
- [ ] Backtest vs Live tem divergência < 5%

**Horas:** 35h

---

## FASE 3: MÉTRICA REAL DE PERFORMANCE (Semana 5) — 20h
**Impacto:** ALTO | **Bloqueador:** Não, mas essencial para confiança

### 3.1 Cálculo de métricas
**Adicionar ao backtester:**

```javascript
function calculateMetrics(trades) {
  const wins = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  
  const avgWin = wins.length ? wins.reduce((a,b) => a + b.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a,b) => a + b.pnl, 0) / losses.length : 0;
  
  // Expectancy = (win% × avg_win) − (loss% × avg_loss)
  const winRate = wins.length / trades.length;
  const lossRate = losses.length / trades.length;
  const expectancy = (winRate * avgWin) - (lossRate * Math.abs(avgLoss));
  
  // Profit Factor = total_wins / total_losses
  const totalWins = wins.reduce((a,b) => a + b.pnl, 0);
  const totalLosses = Math.abs(losses.reduce((a,b) => a + b.pnl, 0));
  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : 0;
  
  // Max Drawdown = maior queda de equity
  const equity = [1000];
  trades.forEach(t => equity.push(equity[equity.length-1] * (1 + t.pnl/equity[equity.length-1])));
  let maxDD = 0;
  for (let i = 0; i < equity.length; i++) {
    for (let j = i+1; j < equity.length; j++) {
      if (equity[j] < equity[i]) {
        const dd = (equity[i] - equity[j]) / equity[i];
        maxDD = Math.max(maxDD, dd);
      }
    }
  }
  
  // Sharpe Ratio = (return - risk_free_rate) / volatility
  const returns = trades.map(t => t.pnl / 1000);
  const avgReturn = returns.reduce((a,b) => a+b, 0) / returns.length;
  const volatility = Math.sqrt(returns.reduce((a,b) => a + Math.pow(b - avgReturn, 2), 0) / returns.length);
  const sharpe = volatility > 0 ? avgReturn / volatility : 0;
  
  // Sequência de perdas
  let maxConsecutiveLosses = 0;
  let currentLosses = 0;
  for (const trade of trades) {
    if (!trade.win) {
      currentLosses++;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
    } else {
      currentLosses = 0;
    }
  }
  
  return {
    winRate: (winRate * 100).toFixed(1) + '%',
    profitFactor: profitFactor.toFixed(2),
    expectancy: expectancy.toFixed(2),
    maxDrawdown: (maxDD * 100).toFixed(1) + '%',
    sharpeRatio: sharpe.toFixed(2),
    maxConsecutiveLosses,
    totalTrades: trades.length,
    totalProfit: totalWins.toFixed(2),
    totalLoss: totalLosses.toFixed(2),
  };
}
```

### 3.2 Separar por ativo/sessão/regime
```javascript
// Mesmas métricas, mas filtradas por:
const metricsXAU = calculateMetrics(trades.filter(t => t.asset === 'xauusd'));
const metricsBTC = calculateMetrics(trades.filter(t => t.asset === 'btc'));
const metricsLondon = calculateMetrics(trades.filter(t => isLondonSession(t.entryTime)));
const metricsTrend = calculateMetrics(trades.filter(t => t.regime === 'TREND'));
const metricsRange = calculateMetrics(trades.filter(t => t.regime === 'RANGE'));
```

**Critério de pronto:**
- [ ] Expectancy calculado corretamente
- [ ] Profit factor funciona
- [ ] Max DD rastreado
- [ ] Sharpe ratio computado
- [ ] Separação por ativo/sessão/regime
- [ ] Dashboard mostra métricas, não só win%

**Horas:** 20h

---

## FASE 4: AUDITORIA DE SINAL (Semana 5-6) — 25h
**Impacto:** MÉDIO | **Bloqueador:** Não, mas essencial para DEBUG

### 4.1 Log estruturado de cada sinal
**Criar arquivo `signalAudit.json`:**

```json
{
  "timestamp": 1713052800,
  "asset": "xauusd",
  "signal": "BUY",
  "confidence": 3,
  "entry": 2405.50,
  "sl": 2400.00,
  "tp": 2415.00,
  "filters": {
    "trendEMA": "ALIGNED (EMA9 > EMA20 > EMA50)",
    "rsiMomentum": "BULLISH (RSI 58)",
    "macdCrossover": "POSITIVE",
    "adxTrend": "STRONG (ADX 35)",
    "session": "LONDON (07:30 UTC)",
    "nearNews": "NO (CPI em 2h 15min)",
    "confluenceHour": "YES (1H também BUY)",
  },
  "divergences": [
    { "type": "bullish_rsi", "label": "Divergência Bullish RSI", "priceHigh": 2410, "rsiVal": 62 }
  ],
  "regime": "TREND",
  "result": {
    "exitTime": 1713053400,
    "exitPrice": 2416.30,
    "exitReason": "TP_HIT",
    "pnl": 580,
    "pnlPercent": 2.35,
    "slippageApplied": 0.50,
    "spreadPaid": 0.20,
  }
}
```

### 4.2 Visualizar no dashboard
**Nova aba "Signal History":**
- Listar últimos 50 sinais
- Clique abre audit log completo
- Mostra: por quê entrou, por quê saiu, qual regime, qual resultado

**Critério de pronto:**
- [ ] Audit log completo para cada sinal
- [ ] Backtester salva audit de cada trade
- [ ] Dashboard mostra histórico
- [ ] Trader pode ver "por quê isso entrou"

**Horas:** 25h

---

## FASE 5: GESTÃO DE RISCO SÉRIA (Semana 6-7) — 30h
**Impacto:** MÉDIO | **Bloqueador:** Não, mas essencial para segurança

### 5.1 Position sizing por volatilidade
**O problema:** Posição fixa 1 lote. ATR = 100 em calma, 500 em caos. Risco descontrola.

```javascript
function calculatePositionSize(asset, atr, accountRisk = 100) {
  // Risco fixo: 1% da conta = $100
  // SL = ATR * 1.5
  const slDistance = atr * 1.5;
  
  // Posição = Risco / SL distance
  const positionSize = accountRisk / (slDistance * ASSET_PRICE[asset]);
  
  // Capped: min 0.1 lote, max 2 lotes
  return Math.max(0.1, Math.min(2, positionSize));
}
```

### 5.2 Limite diário de risco
```javascript
const dailyRiskLimit = 500; // USD
const dailyLoss = getTodayLosses(); // acumula PnL negativo

if (dailyLoss >= dailyRiskLimit) {
  signal = 'BLOCKED_DAILY_LIMIT';
  console.log('⛔ Limite diário de risco atingido. Stop trading hoje.');
}
```

### 5.3 Bloqueio após sequência de perdas
```javascript
const lastNTrades = trades.slice(-5);
const losses = lastNTrades.filter(t => !t.win).length;

if (losses >= 3) {
  // Reduz posição para 50% após 3 perdas
  positionSize *= 0.5;
  console.log('⚠️ 3 perdidas seguidas. Posição reduzida a 50%.');
}

if (losses >= 5) {
  // Para após 5 perdas
  signal = 'BLOCKED_LOSS_STREAK';
  console.log('⛔ 5 perdidas seguidas. Stop trading hoje.');
}
```

### 5.4 Redução em mercado ruim
```javascript
if (adx < 20) {
  // Mercado lateral: reduz a 30% da posição
  positionSize *= 0.3;
}

if (adx < 15) {
  // Mercado muito lateral: bloqueia entrada
  signal = 'BLOCKED_MARKET_RANGE';
}
```

**Critério de pronto:**
- [ ] Position sizing varia com ATR
- [ ] Limite diário implementado
- [ ] Bloqueio após perdas funciona
- [ ] Redução em mercado lateral ativa
- [ ] Dashboard mostra risco acumulado do dia

**Horas:** 30h

---

## FASE 6: ROBUSTEZ DE DADOS (Semana 7) — 20h
**Impacto:** MÉDIO | **Bloqueador:** Não, mas afeta confiança

### 6.1 Timestamp visível do último dado
```javascript
// No dashboard, mostra:
📊 XAU/USD: $2405.50
⏱️ Dados de 3min atrás (16:47:00 UTC)
🟢 Fonte: Yahoo Finance
```

### 6.2 Aviso se fallback pra simulação
```javascript
if (data.isSimulation) {
  console.warn('⚠️ Nenhuma fonte disponível. Usando dados aleatórios (NÃO REAL)');
  // Dashboard mostra banner vermelho:
  // "⚠️ SIMULAÇÃO ATIVA — Dados não são reais. Não operem!"
}
```

### 6.3 Log quando API falha
```javascript
try {
  data = await fetchFromOanda(asset);
} catch (err) {
  console.error(`❌ OANDA ${asset} falhou: ${err.message}. Tentando Yahoo...`);
  // Salva em arquivo de auditoria:
  // { timestamp, asset, error, fallback: 'Yahoo' }
}
```

### 6.4 Indicador de "candle fechado"
```javascript
const candle = latestCandle;
const age = (Date.now() - candle.time * 1000) / 1000 / 60; // minutos

if (age < 1) {
  status = '⏳ Candle formando';  // amarelo
} else if (age < 15) {
  status = '🟢 Candle fechado';  // verde
} else {
  status = '⚠️ Dados atrasados'; // vermelho
}
```

**Critério de pronto:**
- [ ] Timestamp visível
- [ ] Aviso de simulação clara
- [ ] API fallback logado
- [ ] Candle status indicado

**Horas:** 20h

---

## FASE 7: FORWARD TEST (Semana 8) — Manual
**Impacto:** CRÍTICO | **Não é código, é processo**

### Processo:
1. **Semana 1-2:** Paper trading (simulação pura, sem dinheiro)
   - Registrar cada sinal emitido vs execução possível
   - Comparar: backtest vs paper vs vida real possível
   
2. **Registro:**
   ```json
   {
     "date": "2026-04-21",
     "backtest_entry": 2405.50,
     "paper_entry": 2405.80,     // +0.30 slippage
     "divergence": "0.01%",
     "passed": true
   }
   ```

3. **Critério de aprovação:**
   - Divergência media < 1%
   - Max drawdown real vs backtest < 10% relativo
   - Win rate dentro de ±5%

**Se passar:** Liberado para small size real

---

## RESUMO DE HORAS POR FASE

| Fase | Descrição | Horas | Impacto | Prioridade |
|------|-----------|-------|--------|-----------|
| 1 | Unificar lógica | 40h | CRÍTICO | 1️⃣ |
| 2 | Backtest realista | 35h | ALTO | 2️⃣ |
| 3 | Métricas reais | 20h | ALTO | 3️⃣ |
| 4 | Auditoria de sinal | 25h | MÉDIO | 4️⃣ |
| 5 | Gestão de risco | 30h | MÉDIO | 5️⃣ |
| 6 | Robustez de dados | 20h | MÉDIO | 6️⃣ |
| 7 | Forward test | - | CRÍTICO | 7️⃣ |
| **TOTAL** | | **170h** | | |

---

## TIMELINE REALISTA

- **Semana 1-2:** Fase 1 (unificação) — BLOQUEADOR, sem isso nada funciona
- **Semana 3-4:** Fase 2 (backtest real) — sem isso trader perde confiança
- **Semana 5:** Fase 3 + 4 (métricas + auditoria) — agora trader entende o que está acontecendo
- **Semana 6-7:** Fase 5 + 6 (risco + robustez) — agora trader sente segurança
- **Semana 8:** Fase 7 (forward test) — validação final antes de real

**Se trabalhar 25h/semana:** ~7-8 semanas
**Se trabalhar 40h/semana:** ~4-5 semanas

---

## O QUE MUDA NO PRODUTO

### Antes (Hoje):
- "App interessante com sinais"
- Win rate 60% no backtest
- Operador: "Por quê entrou? Não sei"
- Divergência backtest vs live: 15-20%
- Sem limite de risco: 3 perdidas seguidas = 100% conta

### Depois (Pronto):
- "Ferramenta profissional de trading"
- Expectancy +$45/trade (metricá real)
- Operador: "Por quê entrou? Vejo cada filtro que passou"
- Divergência backtest vs live: 1-3%
- Com limite de risco: para após 5 perdidas, reduz em lateral

---

## CRITÉRIO FINAL: "PRONTO PARA OPERAR"

✅ Pode sair da auditoria quando:
- [ ] Fase 1-2 completas (lógica unificada + backtest realista)
- [ ] Backtester mostra Expectancy > $0
- [ ] Win rate no backtest matches win rate no paper (±5%)
- [ ] Forward test 2 semanas: Sharpe ratio > 0.5
- [ ] Nenhum aviso "⚠️ SIMULAÇÃO ATIVA" durante paper
- [ ] Position sizing varia com risco
- [ ] Trader consegue ver PORQUE cada sinal entrou e saiu

---

**Próximo passo:** Qual fase você quer começar?
