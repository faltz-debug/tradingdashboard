"""
mt5_push.py — Envia dados do MT5 para o servidor online.

Substitui a leitura local de mt5_feed.json:
em vez de gravar o arquivo localmente, faz POST HTTP
para o servidor na nuvem a cada PUSH_INTERVAL_S segundos.

CONFIGURAÇÃO:
  Edite as variáveis SERVER_URL e PUSH_TOKEN abaixo,
  ou defina as variáveis de ambiente:
    MT5_SERVER_URL=https://trading.seusite.com
    MT5_PUSH_TOKEN=TROQUE_POR_TOKEN_SECRETO_AQUI

EXECUÇÃO:
  python mt5_push.py
  (rode junto com o mt5_feed_sync.py existente,
   ou substitua o loop de escrita por este)
"""

import os
import json
import time
import logging
import requests
from datetime import datetime

# ── Configuração ──────────────────────────────────────────
SERVER_URL   = os.getenv("MT5_SERVER_URL",   "http://194.34.232.12")
PUSH_TOKEN   = os.getenv("MT5_PUSH_TOKEN",   "2fc0a66a39eeb1518d6d250e10d766a745439ec16fbac9e7")
FEED_FILE    = os.getenv("MT5_FEED_FILE",    r"C:\Users\cinti\Desktop\claude\dashboard com mt5\data\mt5_feed.json")
PUSH_INTERVAL_S = int(os.getenv("MT5_PUSH_INTERVAL_S", "5"))  # segundos entre envios
TIMEOUT_S    = 10

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("mt5_push")

# ── Funções ───────────────────────────────────────────────

def read_feed():
    """Lê o mt5_feed.json gerado pelo mt5_feed_sync.py existente."""
    try:
        with open(FEED_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        log.warning(f"Feed não encontrado: {FEED_FILE}")
        return None
    except json.JSONDecodeError as e:
        log.warning(f"JSON inválido no feed: {e}")
        return None


def push_to_server(feed_data: dict) -> bool:
    """Envia os dados para o endpoint /api/internal/mt5/feed no servidor."""
    url = f"{SERVER_URL.rstrip('/')}/api/internal/mt5/feed"
    try:
        resp = requests.post(
            url,
            json=feed_data,
            headers={
                "Content-Type": "application/json",
                "X-MT5-Token": PUSH_TOKEN,
            },
            timeout=TIMEOUT_S,
        )
        if resp.status_code == 200:
            return True
        else:
            log.warning(f"Servidor retornou {resp.status_code}: {resp.text[:200]}")
            return False
    except requests.exceptions.ConnectionError:
        log.warning(f"Servidor offline ou sem conexão: {SERVER_URL}")
        return False
    except requests.exceptions.Timeout:
        log.warning("Timeout ao enviar para o servidor")
        return False
    except Exception as e:
        log.error(f"Erro inesperado: {e}")
        return False


def main():
    log.info(f"MT5 Push iniciado → {SERVER_URL}")
    log.info(f"Feed local: {FEED_FILE}")
    log.info(f"Intervalo: {PUSH_INTERVAL_S}s")

    consecutive_errors = 0

    while True:
        try:
            feed = read_feed()
            if feed is not None:
                ok = push_to_server(feed)
                if ok:
                    consecutive_errors = 0
                    assets = list(feed.keys()) if isinstance(feed, dict) else "?"
                    log.info(f"Push OK — {len(assets) if isinstance(assets, list) else assets} ativo(s)")
                else:
                    consecutive_errors += 1
                    if consecutive_errors >= 5:
                        log.error(f"{consecutive_errors} erros consecutivos — verifique a conexão")
            else:
                log.info("Feed vazio ou MT5 offline — aguardando...")

        except KeyboardInterrupt:
            log.info("Push encerrado pelo usuário.")
            break
        except Exception as e:
            log.error(f"Erro no loop: {e}")
            consecutive_errors += 1

        time.sleep(PUSH_INTERVAL_S)


if __name__ == "__main__":
    main()
