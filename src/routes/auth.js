'use strict';

/**
 * src/routes/auth.js
 *
 * Roteador Express com as 5 rotas de autenticacao:
 *   GET  /api/auth/config     — flags publicas (allowSignup, hasLegacyVipToken, ...)
 *   POST /api/auth/register   — auto-cadastro (so se ALLOW_PUBLIC_SIGNUP=true)
 *   POST /api/auth/login      — login email/senha → sessao
 *   POST /api/auth/logout     — revoga a sessao corrente
 *   GET  /api/auth/me         — devolve o usuario autenticado
 *
 * Padrao de injecao: factory createAuthRouter({...}) recebe deps explicitas
 * para evitar imports circulares e facilitar teste.
 *
 * @param {object} deps
 * @param {object} deps.authStore       — modulo de sessoes/usuarios
 * @param {Function} deps.rateLimit
 * @param {Function} deps.rateLimitLogin — rate limit dedicado ao login (10/15min)
 * @param {Function} deps.requireAuth
 * @param {Function} deps.getRequestIp
 * @param {Function} deps.buildPublicUser
 * @param {object} deps.config
 * @param {boolean} deps.config.ALLOW_PUBLIC_SIGNUP
 * @param {string}  deps.config.DEFAULT_SIGNUP_ACCESS_STATUS
 * @param {string}  deps.config.DEFAULT_SIGNUP_PLAN_CODE
 * @param {string}  deps.config.VIP_TOKEN
 *
 * @returns {import('express').Router}
 */

const express = require('express');

function createAuthRouter(deps) {
  const {
    authStore,
    rateLimit,
    rateLimitLogin,
    requireAuth,
    getRequestIp,
    buildPublicUser,
    config,
  } = deps;

  const {
    ALLOW_PUBLIC_SIGNUP,
    DEFAULT_SIGNUP_ACCESS_STATUS,
    DEFAULT_SIGNUP_PLAN_CODE,
    VIP_TOKEN,
  } = config;

  const router = express.Router();

  router.get('/config', rateLimit, (_req, res) => {
    res.json({
      success: true,
      allowPublicSignup: ALLOW_PUBLIC_SIGNUP,
      hasLegacyVipToken: !!VIP_TOKEN,
      usersCount: authStore.countUsers(),
      defaultSignupAccessStatus: DEFAULT_SIGNUP_ACCESS_STATUS,
      defaultSignupPlanCode: DEFAULT_SIGNUP_PLAN_CODE,
    });
  });

  router.post('/register', rateLimit, (req, res) => {
    if (!ALLOW_PUBLIC_SIGNUP) {
      return res.status(403).json({
        success: false,
        error: 'Cadastro publico desabilitado',
        detail: 'Ative ALLOW_PUBLIC_SIGNUP=true para liberar auto-cadastro',
      });
    }

    const { email, password, name, telegramHandle } = req.body || {};

    try {
      const user = authStore.createUser({
        email,
        password,
        role: 'subscriber',
        accessStatus: DEFAULT_SIGNUP_ACCESS_STATUS,
        planCode: DEFAULT_SIGNUP_PLAN_CODE,
        profile: { name, telegramHandle, createdVia: 'public_signup' },
      });

      const session = authStore.createSession(user.id, {
        ip: getRequestIp(req),
        userAgent: req.headers['user-agent'] || '',
      });

      res.status(201).json({
        success: true,
        user: buildPublicUser({ ...user, sessionExpiresAt: session.expiresAt }),
        session: {
          token: session.token,
          expiresAt: session.expiresAt,
        },
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.post('/login', rateLimitLogin, (req, res) => {
    const { email, password } = req.body || {};
    const user = authStore.authenticateUser(email, password);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Email ou senha invalidos' });
    }

    const session = authStore.createSession(user.id, {
      ip: getRequestIp(req),
      userAgent: req.headers['user-agent'] || '',
    });

    res.json({
      success: true,
      user: buildPublicUser({ ...user, sessionExpiresAt: session.expiresAt }),
      session: {
        token: session.token,
        expiresAt: session.expiresAt,
      },
    });
  });

  router.post('/logout', rateLimit, requireAuth, (req, res) => {
    if (req.auth.type === 'session' && req.auth.token) {
      authStore.revokeSession(req.auth.token);
    }
    res.json({ success: true });
  });

  router.get('/me', rateLimit, requireAuth, (req, res) => {
    res.json({
      success: true,
      user: buildPublicUser(req.auth.user),
      authType: req.auth.type,
    });
  });

  return router;
}

module.exports = { createAuthRouter };
