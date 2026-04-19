#!/usr/bin/env node
/**
 * create-admin.js — Cria ou atualiza o usuário admin no banco local.
 *
 * Uso:
 *   node create-admin.js <email> <senha>
 *
 * Exemplo:
 *   node create-admin.js admin@dashboard.com minhasenha123
 *
 * Execute no Railway via: Settings → Deploy → Run Command
 * ou localmente se tiver acesso ao data/trades.db
 */
'use strict';

const [,, email, password] = process.argv;

if (!email || !password) {
  console.error('Uso: node create-admin.js <email> <senha>');
  process.exit(1);
}

const authStore = require('./authStore');

try {
  const admin = authStore.ensureBootstrapAdmin({
    email,
    password,
    name:     'Admin',
    planCode: 'vip',
  });

  if (admin) {
    console.log('✅ Admin criado/atualizado com sucesso!');
    console.log(`   Email: ${admin.email}`);
    console.log(`   Role:  ${admin.role}`);
    console.log(`   Plan:  ${admin.planCode}`);
    console.log(`   Status: ${admin.accessStatus}`);
    console.log('\nUse essas credenciais para entrar na Área VIP.');
  } else {
    console.error('❌ Falha ao criar admin. Verifique os logs.');
    process.exit(1);
  }
} catch (err) {
  console.error('❌ Erro:', err.message);
  process.exit(1);
}
