/**
 * fix_db.js — Corrige banco de dados corrompido (WAL/SHM conflitante)
 * Uso: node fix_db.js
 *
 * O que faz:
 *  1. Deleta trades.db-wal e trades.db-shm (causa do erro SQLITE_CORRUPT)
 *  2. Deleta (ou faz backup de) trades.db corrompido
 *  3. O servidor recria tudo do zero na próxima inicialização,
 *     incluindo o admin via ADMIN_EMAIL/ADMIN_PASSWORD do .env
 */
'use strict';

const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = process.env.DATABASE_PATH || path.join(DATA_DIR, 'trades.db');
const WAL_FILE = DB_FILE + '-wal';
const SHM_FILE = DB_FILE + '-shm';
const BAK_FILE = DB_FILE + '.bak_' + Date.now();

console.log('=== fix_db.js — Correção do banco SQLite ===\n');
console.log('Pasta:', DATA_DIR);
console.log('Banco:', DB_FILE, '\n');

let ok = true;

// 1. Deletar WAL
if (fs.existsSync(WAL_FILE)) {
  try { fs.unlinkSync(WAL_FILE); console.log('✅ Deletado: trades.db-wal'); }
  catch (e) { console.error('❌ Não conseguiu deletar WAL:', e.message); ok = false; }
} else {
  console.log('ℹ️  WAL não encontrado (já deletado)');
}

// 2. Deletar SHM
if (fs.existsSync(SHM_FILE)) {
  try { fs.unlinkSync(SHM_FILE); console.log('✅ Deletado: trades.db-shm'); }
  catch (e) { console.error('❌ Não conseguiu deletar SHM:', e.message); ok = false; }
} else {
  console.log('ℹ️  SHM não encontrado (já deletado)');
}

// 3. Testar se o DB abre corretamente
if (ok && fs.existsSync(DB_FILE)) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_FILE);
    db.pragma('integrity_check');
    db.close();
    console.log('\n✅ Banco de dados OK — sem necessidade de recriar!');
    console.log('\nAgora rode: node server.js');
    process.exit(0);
  } catch (e) {
    console.log('\n⚠️  Banco ainda corrompido:', e.message);
    console.log('Fazendo backup e recriando...\n');
    try {
      fs.renameSync(DB_FILE, BAK_FILE);
      console.log('✅ Backup salvo em:', path.basename(BAK_FILE));
    } catch (e2) {
      console.warn('Não conseguiu fazer backup:', e2.message);
      try { fs.unlinkSync(DB_FILE); console.log('✅ DB corrompido deletado'); }
      catch (e3) { console.error('❌ Não conseguiu deletar DB corrompido:', e3.message); }
    }
  }
}

// 4. Se chegou aqui, o DB foi removido — servidor vai recriar na próxima vez
if (!fs.existsSync(DB_FILE)) {
  console.log('\n✅ Banco removido. O servidor vai recriá-lo automaticamente.');
  console.log('\n⚠️  IMPORTANTE: seu login admin será recriado a partir do .env');

  // Mostrar o admin configurado no .env
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      const emailMatch = envContent.match(/ADMIN_EMAIL\s*=\s*(.+)/);
      const nameMatch  = envContent.match(/ADMIN_NAME\s*=\s*(.+)/);
      if (emailMatch) console.log('   Admin email:', emailMatch[1].trim());
      if (nameMatch)  console.log('   Admin nome: ', nameMatch[1].trim());
    }
  } catch (_) {}

  console.log('\nAgora rode: node server.js');
} else {
  console.log('\n❌ Não foi possível remover o banco corrompido.');
  console.log('   Delete manualmente o arquivo:', DB_FILE);
  console.log('   E também:', WAL_FILE);
  console.log('   E também:', SHM_FILE);
}
