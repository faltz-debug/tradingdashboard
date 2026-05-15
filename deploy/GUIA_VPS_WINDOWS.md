# Guia de Deploy — VPS Windows (Tudo Online 24/7)

**Tempo estimado: 30–45 minutos**  
Depois disto o PC fica completamente desligado e o bot corre sozinho.

---

## Arquitectura final

```
VPS Windows (Contabo ~€4/mês, ligado 24/7)
├── MT5 Terminal → conectado à FTMO
├── mt5_feed_sync.py  → lê MT5, gera feed (serviço Windows)
├── bot_webhook_receiver.py → abre ordens (serviço Windows)
└── Node.js dashboard → sinais + VIP panel (PM2)

Telemóvel / Browser → http://IP-DO-VPS:3000/vip.html
Telegram → alertas e confirmações de trade
```

---

## Parte 1 — Contratar o VPS no Contabo

1. Acede a **contabo.com** → **VPS** → **VPS Windows**
2. Escolhe o plano mais barato (VPS S ou VPS 1 — suficiente):
   - 4 vCPUs, 8 GB RAM, SSD 50 GB → ~€4–6/mês
3. Em **Operating System** selecciona **Windows Server 2022**
4. Escolhe a região **Europe (Germany)** ou **Europe (Netherlands)**
5. Completa o pagamento
6. Recebes um email com:
   - **IP do servidor**
   - **Utilizador:** Administrator
   - **Password:** gerada pelo Contabo

---

## Parte 2 — Entrar no VPS (Remote Desktop)

No teu PC Windows:

1. Pesquisa **"Conexão de Área de Trabalho Remota"** no menu Iniciar
2. Em **Computador** coloca o IP do VPS
3. Clica **Ligar** → utilizador `Administrator` → password do email
4. Já estás dentro do VPS — vês um ambiente Windows normal

---

## Parte 3 — Instalar tudo automaticamente

Dentro do VPS:

1. Abre o **PowerShell como Administrador**  
   (botão direito no menu Iniciar → Windows PowerShell (Admin))

2. Cola este comando e prime Enter:
```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
```

3. Copia os ficheiros do projecto para `C:\dashboard\`  
   Podes arrastar e largar pelo Remote Desktop, ou usar o comando:
```powershell
# No teu PC local, abre o PowerShell e corre:
scp -r "C:\Users\cinti\Desktop\claude\dashboard com mt5\*" Administrator@IP-DO-VPS:C:\dashboard\
```

4. Dentro do VPS, no PowerShell Admin:
```powershell
cd C:\dashboard\deploy
.\setup_windows.ps1
```

O script instala automaticamente: Node.js 20, Python 3.11, PM2, NSSM, e todas as dependências Python.

---

## Parte 4 — Configurar o .env

1. Dentro do VPS, navega até `C:\dashboard\`
2. Copia o ficheiro de template:
```powershell
Copy-Item "C:\dashboard\deploy\.env.production" "C:\dashboard\.env"
```
3. Abre para editar:
```powershell
notepad C:\dashboard\.env
```
4. **Preenche apenas estas linhas** (o resto já está pronto):
```
MT5_LOGIN=← o teu novo login FTMO
MT5_PASSWORD=← a tua nova password FTMO
MT5_SERVER=FTMO-Demo
ADMIN_PASSWORD=← escolhe uma password para o dashboard
```
5. Guarda e fecha o Notepad

---

## Parte 5 — Instalar o MT5 e configurar a conta FTMO

1. Dentro do VPS, abre o **Internet Explorer** ou **Edge**
2. Vai a **ftmo.com** → faz download do MT5 para a nova conta demo
3. Instala o MT5 normalmente
4. Abre o MT5 e faz login com os novos dados FTMO
5. Garante que o MT5 está conectado (barra de status no canto inferior deve mostrar o servidor)
6. **Mantém o MT5 aberto** (pode ficar minimizado na barra de tarefas)

---

## Parte 6 — Instalar dependências Node e arrancar tudo

No PowerShell Admin dentro do VPS:

```powershell
cd C:\dashboard
npm install
.\deploy\start_services.ps1
```

O script arranca os 3 serviços:
- **Dashboard** (PM2) → porta 3000
- **MT5 Feed Sync** (serviço Windows) → lê MT5 a cada 5s
- **Bot Webhook** (serviço Windows) → abre ordens na porta 5000

---

## Parte 7 — Verificar que tudo funciona

```powershell
# Estado dos processos
pm2 status

# Logs em tempo real
pm2 logs dashboard --lines 30

# Verificar feed MT5
Invoke-WebRequest http://localhost:3000/api/health | Select-Object -ExpandProperty Content
```

No telemóvel ou browser: `http://IP-DO-VPS:3000/vip.html`

Deves ver o dashboard com sinais a actualizar.

---

## Parte 8 — Como fazer alterações depois do deploy

Quando eu fizer uma alteração no código (ex: filtro de sessão, novo parâmetro):

1. No teu PC, os ficheiros já estão actualizados na pasta local
2. Envias para o VPS:
```powershell
# No teu PC local:
scp "C:\Users\cinti\Desktop\claude\dashboard com mt5\src\scheduler.js" Administrator@IP-DO-VPS:C:\dashboard\src\
```
3. No VPS, reiniciar o dashboard:
```powershell
pm2 restart dashboard
```

Para alterar credenciais (.env) — só abres o Notepad no VPS, editas, e `pm2 restart dashboard`.

---

## Parte 9 — Trocar conta FTMO no futuro

Quando a conta demo expirar de novo:

1. Entras no VPS pelo Remote Desktop
2. Abres o MT5, fazes login com a nova conta
3. Abres o Notepad: `notepad C:\dashboard\.env`
4. Alteras `MT5_LOGIN`, `MT5_PASSWORD`, `MT5_SERVER`
5. No PowerShell: `pm2 restart dashboard`
6. Pronto — menos de 2 minutos

---

## Comandos do dia a dia

```powershell
pm2 status                    # ver estado de tudo
pm2 logs dashboard            # logs do dashboard
pm2 restart dashboard         # reiniciar após alteração de código
pm2 restart dashboard --update-env  # reiniciar após alteração do .env

nssm status mt5-feed          # estado do feed MT5
nssm restart mt5-feed         # reiniciar feed MT5

nssm status mt5-bot           # estado do bot webhook
nssm restart mt5-bot          # reiniciar bot webhook
```

---

## Segurança — o que já está protegido

| Elemento | Protecção |
|----------|-----------|
| MT5 credentials | Só no .env local no VPS, nunca no GitHub |
| BOT_WEBHOOK_TOKEN | Token aleatório de 48 chars gerado — valida cada pedido |
| MT5_PUSH_TOKEN | Token aleatório de 48 chars gerado — valida o feed |
| Dashboard | Login com email + password (ADMIN_PASSWORD) |
| Porta 5000 (Flask) | Só acessível em localhost — não exposta ao exterior |
| Porta 3000 (Node) | Acessível pelo IP do VPS — acesso pelo browser/telemóvel |

---

## Se o VPS reiniciar (ex: manutenção Contabo)

PM2 e NSSM arrancam automaticamente com o Windows.  
O MT5 **não arranca sozinho** — tens de entrar pelo Remote Desktop e abri-lo manualmente.  
Para evitar isto, podes adicionar o MT5 ao **Arranque do Windows**:
```
Win + R → shell:startup → arrasta o atalho do MT5 para essa pasta
```
