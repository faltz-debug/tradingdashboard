#!/bin/bash
# Trading Dashboard - Inicializar no Mac/Linux

echo ""
echo "╔════════════════════════════════════════╗"
echo "║      Trading Dashboard - Startup       ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Verificar Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js não encontrado!"
    echo "   Baixe em: https://nodejs.org/"
    exit 1
fi
echo "✅ Node.js OK"

# Criar .env se não existir
if [ ! -f ".env" ]; then
    echo ""
    echo "⚠️  Arquivo .env não encontrado!"
    echo "   Copie .env.example para .env e coloque sua chave da API."
    echo "   Continuando com chave demo..."
    echo ""
fi

# Instalar dependências se necessário
if [ ! -d "node_modules" ]; then
    echo "📦 Instalando dependências..."
    npm install
    echo ""
fi

echo ""
echo "🚀 Iniciando servidor..."
echo "   Acesse: http://localhost:3000/dashboard.html"
echo "   Pressione Ctrl+C para parar"
echo ""

node server.js
