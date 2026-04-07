@echo off
REM Trading Dashboard - Inicializar no Windows

echo.
echo ╔════════════════════════════════════════╗
echo ║      Trading Dashboard - Startup       ║
echo ╚════════════════════════════════════════╝
echo.

REM Verificar Node.js
node -v >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js nao encontrado!
    echo    Baixe em: https://nodejs.org/
    pause
    exit /b 1
)
echo ✅ Node.js OK

REM Criar .env se não existir
if not exist ".env" (
    echo.
    echo ⚠️  Arquivo .env nao encontrado!
    echo    Copie .env.example para .env e coloque sua chave da API.
    echo    Continuando com chave demo...
    echo.
)

REM Instalar dependências se necessário
if not exist "node_modules" (
    echo 📦 Instalando dependencias...
    call npm install
    echo.
)

echo.
echo 🚀 Iniciando servidor...
echo    Acesse: http://localhost:3000/dashboard.html
echo    Pressione Ctrl+C para parar
echo.

node server.js
pause
