# MT5 Bridge

Bridge local para ler dados do MetaTrader 5 e gravar um cache JSON consumivel pelo backend Node.

## O que ela coleta

- Tick atual com `bid`, `ask` e `last`
- Candles fechados de `15m`, `1h`, `4h` e `daily`
- Horario do servidor
- Simbolo real do broker

## Instalar

```bash
py -m pip install -r mt5_bridge/requirements.txt
```

## Rodar uma vez

```bash
$env:MT5_BRIDGE_MODE="once"
python mt5_bridge/bridge.py
```

## Rodar em loop

```bash
$env:MT5_BRIDGE_MODE="loop"
$env:MT5_POLL_SECONDS="1"
python mt5_bridge/bridge.py
```

## Variaveis uteis

- `MT5_LOGIN`
- `MT5_PASSWORD`
- `MT5_SERVER`
- `MT5_PATH`
- `MT5_ASSETS`
- `MT5_CANDLE_COUNT`
- `MT5_POLL_SECONDS`
- `MT5_BRIDGE_OUTPUT`
- `MT5_BRIDGE_PUSH_URL`
- `MT5_BRIDGE_PUSH_TOKEN`
- `MT5_BRIDGE_PUSH_TIMEOUT_MS`

## Exemplo de assets

```bash
$env:MT5_ASSETS="xauusd:XAUUSD,eurusd:EURUSD,usdjpy:USDJPY"
```

## Saida

Por padrao a bridge grava em:

```text
data/mt5_feed.json
```

## Modo producao online

Se quiser rodar o MT5 em uma VPS Windows e enviar o feed direto para o backend online:

```bash
$env:MT5_BRIDGE_MODE="loop"
$env:MT5_POLL_SECONDS="1"
$env:MT5_BRIDGE_PUSH_URL="https://SEU_BACKEND/api/internal/mt5/feed"
$env:MT5_BRIDGE_PUSH_TOKEN="SEU_TOKEN"
python mt5_bridge/bridge.py
```

No backend Node, configure:

```env
MT5_PUSH_TOKEN=SEU_TOKEN
MT5_FEED_MAX_AGE_MS=3000
DASHBOARD_PUSH_MS=1000
```

Estrutura principal:

```json
{
  "source": "MT5_FTMO_BRIDGE",
  "mode": "FTMO_SYNCED",
  "assets": {
    "xauusd": {
      "price": 0,
      "bid": 0,
      "ask": 0,
      "candles": {
        "15m": [],
        "1h": [],
        "4h": [],
        "daily": []
      }
    }
  }
}
```
