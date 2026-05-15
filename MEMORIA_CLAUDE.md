# Memória do Projeto — Bot de Trading MT5 Dashboard
_Atualizado em: 06/05/2026_

## Identidade do Projeto
- **Nome:** Dashboard com MT5 — Bot de Trading Automatizado
- **Versão:** 6.0.0 (arquitetura modular)
- **Usuário:** Lucas (lucasaguiarfaltz@gmail.com)
- **Stack:** Node.js 20 + Express + SQLite + Python (MT5 bridge)
- **Pasta:** `C:\Users\cinti\Desktop\claude\dashboard com mt5`

## O que o bot faz
- Conecta ao MetaTrader 5 (FTMO Demo: conta 1513145586)
- Gera sinais em tempo real para: BTC/USD, XAU/USD, EUR/USD, USD/JPY
- Dashboard web com sinais VIP multi-timeframe (15m + 1H/4H bias)
- Abre trades automaticamente via webhook (Flask na porta 5000)
- Envia alertas e relatórios via Telegram

## Performance Atual (113 trades — MT5 confirmado, 06/05/2026)
| Métrica | Valor |
|---------|-------|
| Win Rate | 38.1% |
| Total R | +7.63R |
| Profit Factor | 1.11 |
| Drawdown Máx | 16.7R |
| Maior sequência de losses | 9 |

## Análise por Sessão (CRÍTICO — base para filtros)
| Sessão | WR | PF | Total R | Decisão |
|--------|----|----|---------|---------|
| Tokyo + Londres | 50.0% | 1.95 | +6.90R | ✅ MANTER |
| Londres + NY + Overlap | 47.1% | 1.54 | +5.00R | ✅ MANTER |
| Tokyo | 44.8% | 1.38 | +6.32R | ✅ MANTER |
| Londres | 31.8% | 0.89 | -1.79R | ⚠️ MONITORAR |
| NY puro | 18.2% | 0.35 | -11.95R | ❌ DESLIGAR |
| Sem sessão | 16.7% | 0.39 | -3.06R | ❌ DESLIGAR |

## Análise por Ativo (decisões tomadas)
- ✅ BTC BUY — manter (WR 40.5%, PF 1.27, +6.22R)
- ✅ EURUSD BUY + SELL — manter (ambos positivos)
- ✅ XAUUSD BUY — manter (WR 41.7%, PF 1.42)
- ❌ BTC SELL — desligar (WR 30%, PF 0.54, -3.31R)
- ❌ USDJPY — pausar (WR 33.3%, PF 0.78, -2.45R)
- ⚠️ XAUUSD SELL — reduzir peso

## Horários de Sessão (Portugal — UTC+1 em maio)
| Sessão | Horário PT |
|--------|-----------|
| Tokyo | 01:00 – 10:00 |
| Londres | 09:00 – 18:00 |
| NY | 14:00 – 23:00 |
| Overlap Londres+NY | 14:00 – 18:00 |
| Transição Tokyo+Londres | 09:00 – 10:00 |

## Arquitetura Técnica
```
server.js → Express + routers (src/routes/)
scheduler.js → Jobs: alertas 2-5min, WebSocket 1s, relatório semanal
signals.js → Motor de sinais Master (-3 a +3) e VIP (0 a maxScore)
dataSources.js → MT5 feed → Kraken → OANDA → Finnhub → TwelveData
indicators.js → EMA, RSI, MACD, ADX, ATR, Bollinger, Ichimoku, VWAP
alerts.js → Telegram + saída automática de trades
tradeStore.js → SQLite (trades.db)
bot_webhook_receiver.py → Flask :5000, abre ordens no MT5
mt5_feed_sync.py → Lê MT5, escreve mt5_feed.json a cada 5s
deploy/mt5_push.py → Envia feed local para servidor cloud
```

## Plano de Deploy Online (próxima fase)
**Arquitetura híbrida:**
- **PC Windows** → MT5 + mt5_feed_sync.py + mt5_push.py (push a cada 5s)
- **Oracle Cloud Free** → Node.js + nginx + PM2 (servidor online 24/7)
- O PC pode desligar; servidor continua. Ao religar, feed volta automaticamente.

**Opções de servidor:**
1. Oracle Cloud Free (4 OCPUs, 24GB RAM ARM — gratuito) ← RECOMENDADO
2. Railway (mais simples, mas pago para SQLite persistente)
3. VPS (DigitalOcean, Hetzner ~€5/mês)

**Guia de deploy:** `deploy/GUIA_DEPLOY.md` (completo, passo a passo)

## Próximas Implementações (por prioridade)
1. **Deploy Oracle Cloud** — servidor online, PC não precisa ficar ligado 24h
2. **Filtro de sessão** — desligar NY puro + sem sessão no código
3. **Filtro de ativo/direção** — desligar BTC SELL, pausar USDJPY
4. **Score 7-8 como threshold** — recalibrar AUTO_OPEN_SCORE_THRESHOLD
5. **Horários automáticos** — bot opera apenas em janelas rentáveis

## Modelo Claude Recomendado por Fase
| Fase | Tarefa | Modelo |
|------|--------|--------|
| Deploy + código | Implementação, scripts, config | claude-sonnet-4-6 |
| Arquitetura | Decisões complexas, trade-offs | claude-opus-4-6 |
| Perguntas rápidas | Status, dúvidas simples | claude-haiku-4-5 |

## Issues / Alertas
- `OANDA_API_KEY` está **vazia** → dados de XAUUSD/EURUSD/USDJPY vêm do Twelve Data (mais lento)
- `BOT_WEBHOOK_TOKEN` ainda é o valor padrão (`seu_token_super_seguro_aqui`) — ALTERAR antes do deploy
- `ADMIN_PASSWORD=admin123` — ALTERAR antes de expor online
- `FRONTEND_ORIGIN=*` — restringir para o domínio real em produção
