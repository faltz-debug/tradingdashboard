'use strict';

/**
 * src/routes/market.js
 *
 * Roteador Express com as rotas publicas de mercado:
 *   GET /api/btc            — snapshot BTC (+ sinais via attachSignals)
 *   GET /api/xauusd         — snapshot XAU/USD
 *   GET /api/eurusd         — snapshot EUR/USD
 *   GET /api/usdjpy         — snapshot USD/JPY
 *   GET /api/analysis/:asset — suporte/resistencia + divergencia
 *   GET /api/backtest-data  — candles consolidados de todos ativos/TFs
 *
 * Padrao de injecao identico aos outros routers.
 *
 * @param {object} deps
 * @param {Function} deps.getAsset
 * @param {Function} deps.attachSignals
 * @param {Function} deps.calcSupportResistance
 * @param {Function} deps.detectDivergence
 * @param {object}   deps.ASSETS
 * @param {object}   deps.cache               — referencia ao cache compartilhado
 * @param {Function} deps.isCacheValid
 * @param {Function} deps.rateLimit
 * @param {object}   deps.logger
 *
 * @returns {import('express').Router}
 */

const express = require('express');

// Mapeamento entre chaves internas e nomes curtos esperados pelo backtester.html
const BACKTEST_ASSET_MAP = {
  xauusd: 'xau',
  btc:    'btc',
  eurusd: 'eur',
  usdjpy: 'jpy',
};

function createMarketRouter(deps) {
  const {
    getAsset,
    attachSignals,
    calcSupportResistance,
    detectDivergence,
    ASSETS,
    cache,
    isCacheValid,
    rateLimit,
    logger,
  } = deps;

  const router = express.Router();

  async function safeGetAsset(key, res) {
    try {
      res.json(attachSignals(await getAsset(key), key));
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── Snapshots de ativos ─────────────────────────────────────────────────
  router.get('/btc',    rateLimit, (_req, res) => safeGetAsset('btc',    res));
  router.get('/xauusd', rateLimit, (_req, res) => safeGetAsset('xauusd', res));
  router.get('/eurusd', rateLimit, (_req, res) => safeGetAsset('eurusd', res));
  router.get('/usdjpy', rateLimit, (_req, res) => safeGetAsset('usdjpy', res));

  // ── Suporte/resistencia + divergencia (analise tecnica leve) ─────────────
  router.get('/analysis/:asset', rateLimit, async (req, res) => {
    const key = req.params.asset;
    if (!ASSETS[key]) return res.status(404).json({ error: 'Ativo não encontrado' });
    try {
      const data    = await getAsset(key);
      const candles = data['15m'];
      if (!candles || candles.length < 50) return res.json({ sr: null, div: null });
      const sr  = calcSupportResistance(candles);
      const div = detectDivergence(candles);
      res.json({ success: true, asset: key, sr, div });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Backtest data consolidado (candlesticks de todos ativos/TFs) ─────────
  router.get('/backtest-data', rateLimit, (_req, res) => {
    try {
      const result = {};

      for (const [key, assetName] of Object.entries(BACKTEST_ASSET_MAP)) {
        const cached = cache[key];
        if (cached && cached.data && cached.data['15m']) {
          result[assetName] = {
            '15m':   cached.data['15m'],
            '1h':    cached.data['1h']    || [],
            '4h':    cached.data['4h']    || [],
            'daily': cached.data['daily'] || [],
          };
        }
      }

      res.json(result);

      // Refresh assincrono (sem bloquear resposta) se cache estiver velho
      for (const key of Object.keys(BACKTEST_ASSET_MAP)) {
        if (!isCacheValid(key)) {
          getAsset(key).catch(e => logger.warn(`Auto-refresh ${key} falhou: ${e.message}`));
        }
      }
    } catch (err) {
      logger.error('Erro ao buscar dados para backtester:', err.message);
      res.status(500).json({ error: 'Erro ao carregar dados para backtester', detail: err.message });
    }
  });

  return router;
}

module.exports = { createMarketRouter };
