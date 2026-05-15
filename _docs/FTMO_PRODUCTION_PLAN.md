# FTMO Production Plan

## Objetivo

Transformar este projeto em uma arquitetura operacional confiavel para mesa proprietaria, mantendo o preco mais proximo possivel do MT5/FTMO.

## Arquitetura recomendada

```text
MT5 FTMO (VPS Windows ou maquina local)
  -> mt5_bridge/bridge.py
     -> cache local data/mt5_feed.json
     -> POST autenticado /api/internal/mt5/feed
  -> backend Node online
     -> dashboard / vip / sinais / alertas
```

## Modos do sistema

- `FTMO_SYNCED`: feed operacional vindo do MT5 FTMO
- `PROXY_FEED`: fallback de broker/API externa
- `ANALYSIS_ONLY`: sem feed operacional confiavel

## O que ja foi implementado

- Bridge MT5 local com ticks + candles fechados
- Backend priorizando `mt5_ftmo`
- Dashboard com preco live separado de candle fechado
- Entrada operacional por `ask/bid`
- Dashboard com WebSocket para reduzir atraso visual
- Endpoint de ingestao remota do feed MT5:
  - `POST /api/internal/mt5/feed`
- Endpoint de status da bridge:
  - `GET /api/mt5/bridge-status`

## Configuracao de producao

### Backend online

Variaveis principais:

```env
MT5_PUSH_TOKEN=troque_este_token
MT5_FEED_MAX_AGE_MS=3000
DASHBOARD_PUSH_MS=1000
LOCAL_SAFE=false
```

### Bridge na VPS Windows

```powershell
$env:MT5_BRIDGE_MODE="loop"
$env:MT5_POLL_SECONDS="1"
$env:MT5_BRIDGE_PUSH_URL="https://SEU_BACKEND/api/internal/mt5/feed"
$env:MT5_BRIDGE_PUSH_TOKEN="troque_este_token"
py mt5_bridge/bridge.py
```

## Fases de implementacao

### Fase 1 - Feed operacional confiavel

- MT5 aberto e logado na FTMO
- bridge pushando snapshot para o backend online
- backend expondo health do feed

### Fase 2 - Transparencia operacional

- rodape do dashboard mostrando `MT5 FTMO` quando o feed vier do bridge
- badge grande com `FTMO_SYNCED`, `PROXY_FEED` ou `ANALYSIS_ONLY`
- alerta visual quando o feed ficar velho

### Fase 3 - Modularizacao

- extrair `mt5FeedStore.js`
- extrair `marketDataProviders.js`
- extrair `signalEngine.js`
- reduzir o acoplamento atual do `server.js`

### Fase 4 - Observabilidade

- historico de freshness do feed
- alerta de spread alto
- alerta de divergencia entre live e ultimo candle fechado
- log de failover de `FTMO_SYNCED` para `PROXY_FEED`

### Fase 5 - Hardening de producao

- service/Task Scheduler para iniciar bridge automaticamente
- restart automatico do MT5/bridge
- watchdog do feed
- TLS/reverse proxy no backend

## Recomendacao honesta

Para FTMO, o melhor caminho nao e "100% online sem MT5". O melhor caminho e:

- backend/dashboard online
- feed operacional vindo do MT5
- preferencialmente em VPS Windows

Isso entrega acesso remoto sem perder a fidelidade do preco da mesa.
