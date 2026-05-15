'use strict';

/**
 * src/routes/backtest.js
 *
 * Rotas de backtest historico.
 *
 * POST /api/backtest/run
 *   Body: { asset, timeframe?, scoreThreshold?, maxBarsInTrade? }
 *   Retorna relatorio completo com trades + stats + equity curve.
 *
 * GET /api/backtest/assets
 *   Lista ativos disponiveis e quantidade de candles em cache.
 */

const express = require('express');
const { runBacktest } = require('../services/backtest');
const { runStrategyCatalog } = require('../services/backtest-catalog');

function createBacktestRouter({ cache, ASSETS, rateLimit, requireAuth, logger }) {
  const router = express.Router();

  // ── GET /api/backtest/assets ─────────────────────────────────────────────
  router.get('/backtest/assets', rateLimit, requireAuth, (req, res) => {
    const result = {};
    for (const [key, cfg] of Object.entries(ASSETS)) {
      const cached = cache[key];
      const tfs    = cached?.data ? Object.keys(cached.data) : [];
      result[key]  = {
        name:     cfg.name,
        symbol:   cfg.symbol,
        decimals: cfg.decimals,
        timeframes: tfs,
        candles15m: cached?.data?.['15m']?.length ?? 0,
      };
    }
    res.json({ success: true, assets: result });
  });

  // ── POST /api/backtest/run ───────────────────────────────────────────────
  router.post('/backtest/run', rateLimit, requireAuth, (req, res) => {
    try {
      const {
        asset          = 'btc',
        timeframe      = '15m',
        strategy,
        scoreThreshold = 2,
        maxBarsInTrade = 96,
        confluenceEnabled = false,
        newsBlackoutEnabled = false,
        costPct = 0,
      } = req.body || {};

      // Valida ativo
      const cfg = ASSETS[asset];
      if (!cfg) {
        return res.status(400).json({ success: false, error: `Ativo desconhecido: ${asset}` });
      }

      // Valida timeframe
      const TF_MAP = { '15m': '15m', '1h': '1h', '4h': '4h', 'daily': 'daily' };
      const tfKey  = TF_MAP[timeframe];
      if (!tfKey) {
        return res.status(400).json({ success: false, error: `Timeframe invalido: ${timeframe}` });
      }

      // Busca candles do cache
      const cached  = cache[asset];
      const candles = cached?.data?.[tfKey];
      if (!candles || candles.length < 70) {
        return res.status(400).json({
          success: false,
          error: `Candles insuficientes para ${asset}/${timeframe} (${candles?.length ?? 0} disponiveis, minimo 70)`,
        });
      }

      if (strategy === 'all') {
        const tfMap = { '15m': '1h', '1h': '4h', '4h': 'daily', 'daily': 'daily' };
        const biasTfKey = tfMap[tfKey] || '1h';
        const biasCandles = cached?.data?.[biasTfKey] || [];
        const catalog = runStrategyCatalog({
          assetKey: asset === 'xauusd' ? 'xau' : asset === 'eurusd' ? 'eur' : asset === 'usdjpy' ? 'jpy' : asset,
          candles,
          biasCandles,
          options: {
            confluenceEnabled: Boolean(confluenceEnabled),
            newsBlackoutEnabled: Boolean(newsBlackoutEnabled),
            costPct: Number(costPct) || 0,
          },
        });
        return res.json({
          success: true,
          asset,
          timeframe,
          strategy: 'all',
          ...catalog,
        });
      }

      logger.info(`Backtest iniciado: ${cfg.name} ${timeframe} | ${candles.length} candles | score>=${scoreThreshold}`);
      const t0     = Date.now();

      const result = runBacktest(candles, {
        assetName:      cfg.name,
        dec:            cfg.decimals,
        scoreThreshold: Number(scoreThreshold),
        maxBarsInTrade: Number(maxBarsInTrade),
      });

      const elapsed = Date.now() - t0;
      logger.info(`Backtest concluido: ${result.stats.total} trades em ${elapsed}ms`);

      res.json({
        success: true,
        asset,
        timeframe,
        ...result,
        meta: { ...result.meta, elapsedMs: elapsed },
      });
    } catch (err) {
      logger.error(`Backtest erro: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createBacktestRouter };
