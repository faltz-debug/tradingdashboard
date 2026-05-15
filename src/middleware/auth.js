'use strict';

/**
 * src/middleware/auth.js
 *
 * Rate-limit + camada de autenticacao/autorizacao + helpers de request.
 *
 * Funcoes expostas:
 *   - rateLimit(req,res,next)              middleware de rate limiting (300 req/min/IP)
 *   - authenticateRequest(req,_res,next)   resolve req.auth a partir do token (VIP_TOKEN ou sessao)
 *   - requireAuth / requireAdmin / requireVipAccess  guards declarativos
 *   - bootstrapAdminAccount()              cria/atualiza primeiro admin a partir de ADMIN_EMAIL/PASSWORD
 *   - startRateLimitCleanup()              dispara o setInterval que limpa IPs antigos
 *
 * Helpers expostos:
 *   - getRequestIp(req)         IP do cliente (respeita x-forwarded-for)
 *   - getRequestToken(req)      Bearer token ou ?token=
 *   - buildPublicUser(user)     versao "safe" do usuario para respostas JSON
 *
 * Estado interno:
 *   - rateLimitMap (Map<ip, {count, start}>)
 *
 * Config: lida direto de process.env no carregamento do modulo (mesmo padrao
 * de src/services/alerts.js): VIP_TOKEN, ADMIN_EMAIL, ADMIN_PASSWORD,
 * ADMIN_NAME, ADMIN_TELEGRAM.
 *
 * Dependencias externas: ../../authStore (sessoes/usuarios), ../../logger.
 */

const authStore = require('../../authStore');
const logger    = require('../../logger');

// ── Config (env) ────────────────────────────────────────────────────────────
const VIP_TOKEN      = process.env.VIP_TOKEN      || '';
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_NAME     = process.env.ADMIN_NAME     || 'Admin';
const ADMIN_TELEGRAM = process.env.ADMIN_TELEGRAM || '';

// ── Rate limiting ───────────────────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT   = 300;        // maximo de requisicoes por janela
const RATE_WINDOW  = 60 * 1000;  // janela de 1 minuto

function rateLimit(req, res, next) {
  const ip  = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = rateLimitMap.get(ip) || { count: 0, start: now };

  // Reseta janela se passou 1 minuto
  if (now - rec.start > RATE_WINDOW) {
    rec.count = 0;
    rec.start = now;
  }

  rec.count++;
  rateLimitMap.set(ip, rec);

  if (rec.count > RATE_LIMIT) {
    const retryAfter = Math.ceil((RATE_WINDOW - (now - rec.start)) / 1000);
    res.set('Retry-After', retryAfter);
    return res.status(429).json({ error: 'Too many requests', retryAfter });
  }

  next();
}

/**
 * Inicia o job que limpa IPs antigos do rateLimitMap a cada 5 minutos.
 * Retorna o handle do setInterval para que o caller possa parar (testes).
 */
function startRateLimitCleanup() {
  return setInterval(() => {
    const cutoff = Date.now() - RATE_WINDOW * 2;
    for (const [ip, rec] of rateLimitMap.entries()) {
      if (rec.start < cutoff) rateLimitMap.delete(ip);
    }
    const loginCutoff = Date.now() - LOGIN_RATE_WINDOW * 2;
    for (const [ip, rec] of loginAttemptMap.entries()) {
      if (rec.start < loginCutoff) loginAttemptMap.delete(ip);
    }
  }, 5 * 60 * 1000);
}

// ─── RATE LIMIT ESPECÍFICO PARA LOGIN (anti brute-force) ─────────────────────

/**
 * Rate limit dedicado ao endpoint POST /api/auth/login.
 * Limite bem mais conservador que o rateLimit genérico:
 *   - 10 tentativas por janela de 15 minutos por IP
 * Isso previne ataques de força bruta sem bloquear uso legítimo.
 */
const loginAttemptMap = new Map();
const LOGIN_RATE_LIMIT  = 10;             // tentativas por janela
const LOGIN_RATE_WINDOW = 15 * 60 * 1000; // 15 minutos

function rateLimitLogin(req, res, next) {
  const ip  = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = loginAttemptMap.get(ip) || { count: 0, start: now };

  if (now - rec.start > LOGIN_RATE_WINDOW) {
    rec.count = 0;
    rec.start = now;
  }

  rec.count++;
  loginAttemptMap.set(ip, rec);

  if (rec.count > LOGIN_RATE_LIMIT) {
    const retryAfter = Math.ceil((LOGIN_RATE_WINDOW - (now - rec.start)) / 1000);
    res.set('Retry-After', retryAfter);
    return res.status(429).json({
      error: 'Muitas tentativas de login. Tente novamente em ' + Math.ceil(retryAfter / 60) + ' minutos.',
      retryAfter,
    });
  }

  next();
}

// ── Helpers de request ──────────────────────────────────────────────────────
function getRequestIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function getRequestToken(req) {
  const header     = req.headers['authorization'] || '';
  const bearer     = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const queryToken = typeof req.query?.token === 'string' ? req.query.token.trim() : '';
  return bearer || queryToken || '';
}

function buildPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    accessStatus: user.accessStatus,
    planCode: user.planCode,
    hasVipAccess: !!user.hasVipAccess,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    profile: user.profile || {},
    sessionExpiresAt: user.sessionExpiresAt || null,
  };
}

// ── Auth middleware ─────────────────────────────────────────────────────────
function authenticateRequest(req, _res, next) {
  const token = getRequestToken(req);
  req.auth = null;

  if (!token) return next();

  if (VIP_TOKEN && token === VIP_TOKEN) {
    req.auth = {
      type: 'legacy_token',
      role: 'subscriber',
      hasVipAccess: true,
      user: {
        id: 'legacy-vip-token',
        email: 'legacy-token@local',
        role: 'subscriber',
        accessStatus: 'active',
        planCode: 'legacy',
        hasVipAccess: true,
        profile: { name: 'Legacy VIP Token' },
      },
    };
    return next();
  }

  const user = authStore.getUserBySessionToken(token);
  if (user) {
    req.auth = {
      type: 'session',
      role: user.role,
      hasVipAccess: !!user.hasVipAccess,
      user,
      token,
    };
  }

  next();
}

function requireAuth(req, res, next) {
  if (!req.auth?.user) {
    return res.status(401).json({ success: false, error: 'Autenticacao obrigatoria' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.auth?.user || req.auth.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Acesso restrito a admin' });
  }
  next();
}

function requireVipAccess(req, res, next) {
  if (!req.auth?.user) {
    return res.status(401).json({ success: false, error: 'Autenticacao obrigatoria' });
  }
  if (req.auth.role === 'admin' || req.auth.hasVipAccess) return next();
  return res.status(403).json({
    success: false,
    error: 'Plano sem acesso VIP',
    detail: 'Ative um plano com acesso VIP para usar esta rota',
  });
}

// ── Bootstrap admin (idempotente, com readiness check + retry) ──────────────
//
// Em teoria better-sqlite3 eh sincrono e o `require('./authStore')` ja deixa o
// banco pronto. Na pratica, no entanto, podemos pegar o DB em estado
// inconsistente em cenarios reais:
//
//   - Restart apos crash com WAL/SHM nao limpos -> SQLITE_BUSY na 1a query
//   - Multiplo deploy concorrente (PM2 cluster, restart graceful) -> lock
//     transitorio
//   - Disco lento ou volume montado ainda nao disponivel
//
// Implementamos um probe de readiness (authStore.isReady) seguido de uma
// pequena rampa de retries com backoff. Apenas erros transitorios do SQLite
// disparam retry — erros de codigo / config falham rapido.
const _BOOTSTRAP_RETRY_DELAYS_MS = [100, 500, 2000];
const _TRANSIENT_SQLITE_CODES = new Set([
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_CANTOPEN',
  'SQLITE_IOERR',
  'SQLITE_PROTOCOL',
]);

async function bootstrapAdminAccount() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    logger.info('Bootstrap admin desativado - defina ADMIN_EMAIL e ADMIN_PASSWORD para criar o primeiro admin');
    return;
  }

  // 1) Probe de readiness — testa SELECT 1 + SELECT na tabela users.
  //    Se falhar, espera o DB estabilizar antes de tentar o ensureBootstrapAdmin.
  if (typeof authStore.isReady === 'function') {
    let ready = authStore.isReady();
    for (let i = 0; !ready && i < _BOOTSTRAP_RETRY_DELAYS_MS.length; i++) {
      const delay = _BOOTSTRAP_RETRY_DELAYS_MS[i];
      logger.warn(`Bootstrap admin: DB nao pronto (tentativa ${i + 1}/${_BOOTSTRAP_RETRY_DELAYS_MS.length}), retry em ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      ready = authStore.isReady();
    }
    if (!ready) {
      logger.error('Bootstrap admin abortado: DB nao ficou pronto apos retries — verifique data/trades.db e WAL files');
      return;
    }
  }

  // 2) Tenta ensureBootstrapAdmin com retries exclusivos para erros transitorios.
  for (let attempt = 0; attempt <= _BOOTSTRAP_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const admin = authStore.ensureBootstrapAdmin({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        name: ADMIN_NAME,
        telegramHandle: ADMIN_TELEGRAM,
        planCode: 'vip',
      });

      if (admin) {
        logger.info(`Bootstrap admin pronto: ${admin.email} (${admin.role}/${admin.accessStatus})`);
      }
      return;
    } catch (err) {
      const isTransient   = err && err.code && _TRANSIENT_SQLITE_CODES.has(err.code);
      const isLastAttempt = attempt === _BOOTSTRAP_RETRY_DELAYS_MS.length;

      if (!isTransient || isLastAttempt) {
        logger.error(`Falha ao bootstrapar admin: ${err.message}`);
        return;
      }

      const delay = _BOOTSTRAP_RETRY_DELAYS_MS[attempt];
      logger.warn(`Bootstrap admin: tentativa ${attempt + 1} falhou (${err.code}), retry em ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

module.exports = {
  // middleware
  rateLimit,
  rateLimitLogin,
  authenticateRequest,
  requireAuth,
  requireAdmin,
  requireVipAccess,
  // bootstrap / runtime
  bootstrapAdminAccount,
  startRateLimitCleanup,
  // helpers
  getRequestIp,
  buildPublicUser,
};
