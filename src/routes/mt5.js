'use strict';

/**
 * src/routes/mt5.js
 *
 * Roteador Express com as 2 rotas do bridge MT5:
 *   POST /api/internal/mt5/feed      — recebe push do bridge MT5 (autenticado)
 *   GET  /api/mt5/bridge-status      — status remote/file/age + assetCount
 *
 * O endpoint /feed nao usa rateLimit (e chamado por servico interno) e usa
 * express.json com limite proprio de 5mb (payloads MT5 sao maiores que o
 * default).
 *
 * @param {object} deps
 * @param {object}   deps.mt5BridgeState           — estado mutavel compartilhado
 * @param {Function} deps.normalizeEpochMs
 * @param {Function} deps.getPreferredMt5Snapshot
 * @param {Function} deps.readMt5SnapshotFromFile
 * @param {string}   deps.MT5_FEED_FILE
 * @param {number}   deps.MT5_FEED_MAX_AGE_MS
 * @param {Function} deps.rateLimit
 * @param {object}   deps.logger
 * @param {object}   deps.config
 * @param {string}   deps.config.MT5_PUSH_TOKEN
 * @param {boolean}  deps.config.LOCAL_SAFE
 *
 * @returns {import('express').Router}
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');

function createMt5Router(deps) {
  const {
    mt5BridgeState,
    normalizeEpochMs,
    getPreferredMt5Snapshot,
    readMt5SnapshotFromFile,
    MT5_FEED_FILE,
    MT5_FEED_MAX_AGE_MS,
    rateLimit,
    logger,
    config,
  } = deps;

  const { MT5_PUSH_TOKEN, LOCAL_SAFE } = config;

  const router = express.Router();

  // ── POST /internal/mt5/feed ────────────────────────────────────────────
  router.post('/internal/mt5/feed', express.json({ limit: '5mb' }), (req, res) => {
    const providedToken = req.headers['x-mt5-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
    if (MT5_PUSH_TOKEN) {
      if (String(providedToken).trim() !== MT5_PUSH_TOKEN) {
        return res.status(401).json({ success: false, error: 'MT5 push token invalido' });
      }
    } else if (!LOCAL_SAFE) {
      return res.status(503).json({ success: false, error: 'MT5 push token nao configurado no servidor' });
    }

    const payload = req.body;
    if (!payload || typeof payload !== 'object' || !payload.assets || typeof payload.assets !== 'object') {
      return res.status(400).json({ success: false, error: 'Payload MT5 invalido' });
    }

    mt5BridgeState.remoteSnapshot   = payload;
    mt5BridgeState.remoteReceivedAt = Date.now();
    mt5BridgeState.remoteSource     = req.ip || 'bridge_push';

    try {
      fs.mkdirSync(path.dirname(MT5_FEED_FILE), { recursive: true });
      fs.writeFileSync(MT5_FEED_FILE, JSON.stringify(payload, null, 2), 'utf8');
      mt5BridgeState.lastPersistedAt = Date.now();
    } catch (err) {
      logger.warn(`MT5 push persist: ${err.message}`);
    }

    const assetCount = Object.keys(payload.assets || {}).length;
    const errorCount = Object.keys(payload.errors || {}).length;
    res.json({
      success:    true,
      receivedAt: mt5BridgeState.remoteReceivedAt,
      assetCount,
      errorCount,
      mode:       payload.mode || 'FTMO_SYNCED',
    });
  });

  // ── GET /mt5/bridge-status ─────────────────────────────────────────────
  router.get('/mt5/bridge-status', rateLimit, (_req, res) => {
    const remoteGeneratedAt = normalizeEpochMs(mt5BridgeState.remoteSnapshot?.generatedAt);
    const remoteReceivedAt  = mt5BridgeState.remoteReceivedAt || null;
    // Use remoteReceivedAt (server-side timestamp) for freshness to avoid PC clock drift issues.
    // remoteAgeMs still reflects generatedAt for informational purposes.
    const remoteAgeMs       = remoteGeneratedAt ? Date.now() - remoteGeneratedAt : null;
    const receivedAgeMs     = remoteReceivedAt  ? Date.now() - remoteReceivedAt  : null;
    const fileSnapshot      = readMt5SnapshotFromFile();
    const fileGeneratedAt   = normalizeEpochMs(fileSnapshot?.generatedAt);
    const fileAgeMs         = fileGeneratedAt ? Date.now() - fileGeneratedAt : null;
    const preferred         = getPreferredMt5Snapshot();

    res.json({
      success:     true,
      mode:        preferred.source === 'bridge_push' ? 'REMOTE_PUSH' : (fileSnapshot ? 'FILE_CACHE' : 'OFFLINE'),
      freshnessMs: MT5_FEED_MAX_AGE_MS,
      remote: {
        connected:    receivedAgeMs != null && receivedAgeMs <= MT5_FEED_MAX_AGE_MS,
        receivedAt:   remoteReceivedAt,
        receivedAgeMs: receivedAgeMs,
        generatedAt:  remoteGeneratedAt || null,
        ageMs:        remoteAgeMs,
        source:       mt5BridgeState.remoteSource,
        assetCount:   Object.keys(mt5BridgeState.remoteSnapshot?.assets || {}).length,
        errorCount:   Object.keys(mt5BridgeState.remoteSnapshot?.errors || {}).length,
      },
      file: {
        available:   !!fileSnapshot,
        generatedAt: fileGeneratedAt || null,
        ageMs:       fileAgeMs,
        path:        MT5_FEED_FILE,
        assetCount:  Object.keys(fileSnapshot?.assets || {}).length,
        errorCount:  Object.keys(fileSnapshot?.errors || {}).length,
      },
    });
  });

  return router;
}

module.exports = { createMt5Router };
