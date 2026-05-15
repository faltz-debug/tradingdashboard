#!/bin/bash
# ============================================================
# setup.sh — Instalação automática do Trading Dashboard VIP
# Oracle Cloud Free Tier — Ubuntu 22.04 ARM
#
# USO: bash setup.sh SEU_DOMINIO
#   ex: bash setup.sh trading.meusite.com
# ============================================================

set -e

DOMAIN="${1:-}"
APP_DIR="/opt/dashboard"
NODE_VERSION="20"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

if [ -z "$DOMAIN" ]; then
  error "Informe o domínio: bash setup.sh trading.meusite.com"
fi

echo ""
echo "=================================================="
echo " Trading Dashboard VIP — Setup Oracle Cloud"
echo " Domínio: $DOMAIN"
echo "=================================================="
echo ""

# ── 1. Sistema ────────────────────────────────────────────
info "Atualizando sistema..."
sudo apt-get update -qq && sudo apt-get upgrade -y -qq

info "Instalando dependências do sistema..."
sudo apt-get install -y -qq \
  curl wget git unzip build-essential \
  nginx certbot python3-certbot-nginx \
  ufw

# ── 2. Node.js ────────────────────────────────────────────
info "Instalando Node.js $NODE_VERSION..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash - -qq
sudo apt-get install -y -qq nodejs

info "Versão Node: $(node -v) | npm: $(npm -v)"

# ── 3. PM2 ────────────────────────────────────────────────
info "Instalando PM2..."
sudo npm install -g pm2 -q
pm2 startup | tail -1 | sudo bash || true

# ── 4. Firewall ────────────────────────────────────────────
info "Configurando firewall (ufw)..."
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
# NOTA: porta 3000 (Node.js) NÃO exposta — só acessível via nginx
# NOTA: porta 5000 (Flask bot) NÃO exposta — só localhost
sudo ufw --force enable

# ── 4b. Fail2ban (bloqueia IPs com muitas tentativas) ─────
info "Instalando fail2ban..."
sudo apt-get install -y -qq fail2ban
sudo tee /etc/fail2ban/jail.local > /dev/null << F2B
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true

[nginx-http-auth]
enabled = true

[nginx-limit-req]
enabled  = true
filter   = nginx-limit-req
logpath  = /var/log/nginx/error.log
maxretry = 10
F2B
sudo systemctl enable fail2ban
sudo systemctl restart fail2ban
info "Fail2ban activo."

# ── 5. Pasta da aplicação ─────────────────────────────────
info "Criando pasta $APP_DIR..."
sudo mkdir -p "$APP_DIR/data"
sudo chown -R $USER:$USER "$APP_DIR"

# ── 6. Nginx ──────────────────────────────────────────────
info "Configurando nginx para $DOMAIN..."
sudo tee /etc/nginx/sites-available/dashboard > /dev/null << NGINX
# Rate limiting — máx 20 req/s por IP
limit_req_zone \$binary_remote_addr zone=api:10m rate=20r/s;
limit_req_zone \$binary_remote_addr zone=login:10m rate=5r/m;

server {
    listen 80;
    server_name $DOMAIN;

    # Cabeçalhos de segurança
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Rate limit na rota de login (mais restritivo)
    location /api/auth/login {
        limit_req zone=login burst=3 nodelay;
        proxy_pass http://localhost:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Bloquear acesso directo ao feed MT5 (só o PC com token pode enviar)
    location /api/internal/ {
        allow 127.0.0.1;
        deny all;
        proxy_pass http://localhost:3000;
    }

    # WebSocket
    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 86400;
    }

    # API geral — rate limit moderado
    location /api/ {
        limit_req zone=api burst=40 nodelay;
        proxy_pass http://localhost:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Frontend estático
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/dashboard /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# ── 7. HTTPS (certbot) ────────────────────────────────────
info "Solicitando certificado SSL para $DOMAIN..."
warn "Certifique-se que o DNS já aponta para este IP antes de continuar."
read -p "DNS já configurado? (s/n): " DNS_OK
if [ "$DNS_OK" = "s" ]; then
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" || \
    warn "SSL falhou — continue sem HTTPS por enquanto e rode: sudo certbot --nginx -d $DOMAIN"
else
  warn "Pule o SSL por agora. Rode depois: sudo certbot --nginx -d $DOMAIN"
fi

# ── 8. .env de produção ───────────────────────────────────
if [ ! -f "$APP_DIR/.env" ]; then
  info "Criando .env de produção..."
  cat > "$APP_DIR/.env" << ENV
# ===== PRODUÇÃO — preencha antes de iniciar =====
PORT=3000
LOCAL_SAFE=false
FRONTEND_ORIGIN=https://$DOMAIN

# Chave Twelve Data
TWELVE_DATA_KEY=

# Telegram
TELEGRAM_TOKEN=
TELEGRAM_CHAT_ID=

# Admin
ADMIN_EMAIL=
ADMIN_PASSWORD=
ADMIN_NAME=

# MT5 Push Token (escolha um token secreto qualquer)
MT5_PUSH_TOKEN=TROQUE_POR_TOKEN_SECRETO_AQUI

# Auto-trade
AUTO_TRADE_MODE=true
AUTO_OPEN_SCORE_THRESHOLD=7.0
AUTO_TRADE_PYRAMID=true
AUTO_TRADE_MAX_PER_ASSET=3
AUTO_TRADE_PYRAMID_COOLDOWN_MS=1800000
AUTO_BLOCK_WEAK_CONTEXT=false

# Bot webhook (bot Python local no seu PC)
BOT_WEBHOOK_ENABLED=true
BOT_WEBHOOK_URL=http://localhost:5000/webhook/signal
BOT_WEBHOOK_TOKEN=seu_token_super_seguro_aqui

# Risco
MAX_POSITION_SIZE=1.0
EQUITY_RISK_PERCENT=2.0

# SQLite persistente
DATABASE_PATH=/opt/dashboard/data/trades.db
ENV
  warn "IMPORTANTE: edite $APP_DIR/.env com suas credenciais antes de iniciar!"
fi

# ── 9. PM2 ecosystem ──────────────────────────────────────
cat > "$APP_DIR/ecosystem.config.js" << 'ECO'
module.exports = {
  apps: [{
    name: 'dashboard',
    script: './server.js',
    cwd: '/opt/dashboard',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: { NODE_ENV: 'production' },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/opt/dashboard/logs/err.log',
    out_file:   '/opt/dashboard/logs/out.log',
    merge_logs: true,
  }]
};
ECO

mkdir -p "$APP_DIR/logs"

echo ""
echo "=================================================="
info "Setup concluído!"
echo ""
echo "  Próximos passos:"
echo ""
echo "  1. Copie os arquivos do projeto para $APP_DIR:"
echo "     scp -r ./* ubuntu@$DOMAIN:/opt/dashboard/"
echo ""
echo "  2. Edite o .env:"
echo "     nano $APP_DIR/.env"
echo ""
echo "  3. Instale as dependências:"
echo "     cd $APP_DIR && npm install --production"
echo ""
echo "  4. Inicie com PM2:"
echo "     cd $APP_DIR && pm2 start ecosystem.config.js"
echo "     pm2 save"
echo ""
echo "  5. Configure o mt5_push.py no seu PC Windows"
echo "     (arquivo deploy/mt5_push.py no projeto)"
echo ""
echo "  Dashboard: https://$DOMAIN/dashboard.html"
echo "  VIP Panel: https://$DOMAIN/vip.html"
echo "=================================================="
