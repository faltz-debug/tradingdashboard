# Guia de Deploy — Oracle Cloud Free + Domínio

## Visão geral

```
Seu PC Windows (MT5 + bot Python)
  └─ mt5_push.py → POST a cada 5s
        ↓ HTTPS
Servidor Oracle Cloud (Node.js + nginx + SQLite)
  └─ dashboard.html / vip.html acessível de qualquer lugar
```

---

## Parte 1 — Domínio (Cloudflare Registrar)

**Por que Cloudflare?** Menor preço do mercado, sem markup, DNS gratuito e rápido.

1. Acesse **cloudflare.com** → crie conta gratuita
2. Clique em **Domain Registration** → **Register Domains**
3. Pesquise um nome (ex: `meutrading.com`) → compre (~$10/ano)
4. O DNS já fica gerenciado pelo Cloudflare automaticamente

> Você só vai apontar o domínio para o IP da Oracle depois de criar a VM.

---

## Parte 2 — Conta Oracle Cloud

1. Acesse **cloud.oracle.com** → **Start for free**
2. Preencha nome, e-mail, endereço
3. **Cartão de crédito:** é necessário para verificar identidade — **não cobra nada**
4. Escolha a região mais próxima (ex: Brazil East — São Paulo)
5. Aguarde o e-mail de confirmação (~5 minutos)

---

## Parte 3 — Criar a VM (instância gratuita)

1. No painel Oracle → **Compute** → **Instances** → **Create Instance**

2. **Name:** `dashboard`

3. **Image:** clique em **Change image**
   - Selecione: **Canonical Ubuntu**
   - Version: **22.04**
   - Clique OK

4. **Shape:** clique em **Change shape**
   - Selecione: **Ampere** (ARM)
   - Shape: **VM.Standard.A1.Flex**
   - OCPUs: **4** | Memory: **24 GB** (limite do free tier)
   - Clique OK

5. **SSH Keys:**
   - Selecione **Generate a key pair for me**
   - Clique **Save Private Key** → salve o arquivo `ssh-key-*.key` em lugar seguro

6. Clique **Create** → aguarde ~2 minutos

7. Copie o **Public IP** da instância criada

---

## Parte 4 — Abrir portas na Oracle (muito importante!)

A Oracle bloqueia tudo por padrão. É preciso abrir as portas manualmente.

1. Na instância → clique na **Virtual Cloud Network (VCN)**
2. Clique em **Security Lists** → **Default Security List**
3. Clique **Add Ingress Rules** e adicione:

| Source CIDR | Protocol | Port Range | Descrição         |
|-------------|----------|------------|-------------------|
| 0.0.0.0/0   | TCP      | 80         | HTTP              |
| 0.0.0.0/0   | TCP      | 443        | HTTPS             |
| 0.0.0.0/0   | TCP      | 3000       | Node.js (opcional)|

4. Clique **Add Ingress Rules**

---

## Parte 5 — Apontar domínio para a Oracle

1. Volte no **Cloudflare** → seu domínio → **DNS** → **Records**
2. Clique **Add record**:
   - Type: **A**
   - Name: `@` (ou subdomínio como `trading`)
   - IPv4 address: **IP da Oracle**
   - Proxy: **DNS only** (nuvem cinza, não laranja)
3. Aguarde ~5 minutos para propagar

---

## Parte 6 — Conectar na VM e rodar o setup

### No Windows — abra o PowerShell:

```powershell
# Ajuste o caminho da chave e o IP da Oracle
ssh -i C:\Users\cinti\Downloads\ssh-key-XXXX.key ubuntu@SEU_IP_ORACLE
```

### Dentro da VM — copie e cole:

```bash
# Baixa e roda o script de setup
curl -fsSL https://raw.githubusercontent.com/SEU_USUARIO/SEU_REPO/main/deploy/setup.sh -o setup.sh

# OU transfira manualmente (veja abaixo) e rode:
bash setup.sh trading.seudominio.com
```

### Alternativa — transferir os arquivos via SCP:

```powershell
# No PowerShell do Windows — envia a pasta toda
scp -i C:\Users\cinti\Downloads\ssh-key-XXXX.key -r "C:\Users\cinti\Desktop\claude\dashboard com mt5\*" ubuntu@SEU_IP:/opt/dashboard/

# Depois conecta e roda o setup
ssh -i C:\Users\cinti\Downloads\ssh-key-XXXX.key ubuntu@SEU_IP
bash /opt/dashboard/deploy/setup.sh trading.seudominio.com
```

---

## Parte 7 — Configurar o .env no servidor

```bash
nano /opt/dashboard/.env
```

Preencha os campos em branco (copie do seu .env local):
- `TWELVE_DATA_KEY`
- `TELEGRAM_TOKEN` e `TELEGRAM_CHAT_ID`
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`
- `MT5_PUSH_TOKEN` — **invente um token secreto** (ex: `meu_token_secreto_2024`)

Salve: **Ctrl+X** → **Y** → **Enter**

---

## Parte 8 — Instalar dependências e iniciar

```bash
cd /opt/dashboard
npm install --production
pm2 start ecosystem.config.js
pm2 save
pm2 logs dashboard --lines 30
```

Se tudo ok, você verá:
```
[INFO] WSS /ws iniciado
[INFO] Scheduler iniciado
```

Acesse: **https://trading.seudominio.com/vip.html**

---

## Parte 9 — Configurar o MT5 Push no seu PC Windows

O `mt5_push.py` lê o `mt5_feed.json` local (gerado pelo bridge existente)
e envia para o servidor online a cada 5 segundos.

### Edite o arquivo `deploy/mt5_push.py`:

```python
SERVER_URL  = "https://trading.seudominio.com"   # seu domínio
PUSH_TOKEN  = "meu_token_secreto_2024"            # mesmo valor do MT5_PUSH_TOKEN no .env
```

### Instale a dependência (se ainda não tiver):
```cmd
pip install requests
```

### Rode junto com o bridge existente:
```cmd
python deploy\mt5_push.py
```

Você verá:
```
2026-04-27 10:00:00 [INFO] MT5 Push iniciado → https://trading.seudominio.com
2026-04-27 10:00:05 [INFO] Push OK — 6 ativo(s)
```

---

## Parte 10 — Manutenção

### Ver logs:
```bash
pm2 logs dashboard
```

### Reiniciar após atualização:
```bash
# Envie os arquivos novos via SCP, depois:
pm2 restart dashboard
```

### Renovar SSL (automático, mas pode forçar):
```bash
sudo certbot renew
```

### Ver status dos serviços:
```bash
pm2 status
sudo systemctl status nginx
```

---

## Resumo de URLs

| Serviço | URL |
|---------|-----|
| Dashboard | `https://trading.seudominio.com/dashboard.html` |
| VIP Panel | `https://trading.seudominio.com/vip.html` |
| Bridge status | `https://trading.seudominio.com/api/mt5/bridge-status` |
| Health check | `https://trading.seudominio.com/api/health` |

---

## Quando o PC desligar

- O servidor continua online normalmente
- O dashboard mostra "Feed MT5 offline" após 30 segundos sem push
- Sinais VIP ficam indisponíveis (sem dados novos)
- Quando o PC ligar de novo e o `mt5_push.py` iniciar, tudo volta automaticamente
