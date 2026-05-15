'use strict';

/**
 * STATE — Configuração e estado compartilhado entre módulos.
 *
 * Centraliza:
 *   1. Configuração dos ativos (ASSETS, ASSET_MAX_SCORE)
 *   2. Cache genérico de dados de mercado
 *   3. Configuração de sessões + listas negras (forbidden_*) e BLOCKED_HOURS_UTC
 */

// ─── ATIVOS ───────────────────────────────────────────────────────────────────

const ASSETS = {
  btc:    { symbol: 'BTC/USD',  name: 'BTCUSD',  fallbackPrice: 67000,  vol: 500,   decimals: 0, alwaysOpen: true  },
  xauusd: { symbol: 'XAU/USD',  name: 'XAUUSD',  fallbackPrice: 3300,   vol: 40,    decimals: 2, alwaysOpen: false },
  eurusd: { symbol: 'EUR/USD',  name: 'EURUSD',  fallbackPrice: 1.095,  vol: 0.004, decimals: 5, alwaysOpen: false },
  usdjpy: { symbol: 'USD/JPY',  name: 'USDJPY',  fallbackPrice: 160.0,  vol: 0.6,   decimals: 3, alwaysOpen: false },
};

const ASSET_MAX_SCORE = { eurusd: 14, usdjpy: 15, xauusd: 16, btc: 17 };

// ─── CACHE DE DADOS DE MERCADO ────────────────────────────────────────────────

const CACHE_TTL_MS = 15 * 60 * 1000;

const cache = {};
Object.keys(ASSETS).forEach(k => { cache[k] = { data: null, updatedAt: null }; });

function isCacheValid(key) {
  const e = cache[key];
  return !!(e && e.data && e.updatedAt && (Date.now() - e.updatedAt) < CACHE_TTL_MS);
}

// ─── SESSÕES DE MERCADO ───────────────────────────────────────────────────────

const SESSION_HOURS = {
  tokyo:   { open: 0,  close: 9  },
  london:  { open: 7,  close: 16 },
  ny:      { open: 12, close: 21 },
  overlap: { open: 13, close: 16 },
};

/**
 * Sessões ideais (BÔNUS +1 de score quando ativas).
 * Ajustado 2026-05-08 com base nos 123 trades MT5 confirmados.
 */
const ASSET_BEST_SESSIONS = {
  btc:    ['tokyo+london', 'london', 'overlap', 'london+ny'],
  xauusd: ['tokyo', 'tokyo+london', 'overlap'],
  eurusd: ['tokyo+london', 'london', 'overlap', 'london+ny'],
  usdjpy: ['tokyo', 'overlap'],
};

/**
 * COMBOS PROIBIDOS — HARD BLOCK no motor VIP (sinal nem sai).
 * Labels coincidem com os retornados por filters.simplifySession().
 * Resultado da analise dos 123 trades:
 *   xauusd em "NY":     7 trades, 0% WR, -7R
 *   xauusd em "London": 5 trades, 0% WR, -5R  → AMOSTRA FRACA, aguardando 30+ trades
 *   btc em "NY":        9 trades, 22% WR, -4.8R → AMOSTRA FRACA, aguardando 30+ trades
 *   eurusd em "Tokyo":  7 trades, 28.6% WR, -2.83R → AMOSTRA FRACA, aguardando 30+ trades
 *   usdjpy em "London": 5 trades, 20% WR, -2.77R → AMOSTRA FRACA, aguardando 30+ trades
 *
 * REVISAO 2026-05-09: bloqueios com < 15 trades removidos temporariamente.
 * Motivo: bloco impede acumulo de amostra — loop fechado impossibilita validacao.
 * Apenas NY (solido: 22 trades gerais, -11.95R) e NoSession (estrutural) mantidos.
 * Rever quando cada combo atingir 30+ trades.
 */
const ASSET_FORBIDDEN_SESSIONS = {
  btc:    ['NoSession'],
  xauusd: ['NY', 'NoSession'],
  eurusd: ['NoSession'],
  usdjpy: ['NoSession'],
};

/**
 * DIRECOES PROIBIDAS por ativo.
 *   BTC SELL: 11 trades, 27% WR, -4.33R, PF 0.47
 */
const ASSET_FORBIDDEN_DIRECTIONS = {
  btc: ['SELL'],
};

/**
 * HORAS UTC bloqueadas para abertura de trade (qualquer ativo).
 * Default: 17,18,19,21,22 — janela last-NY+after-hours (-17R em 24 trades).
 * Configurable via env BLOCKED_HOURS_UTC (CSV).
 */
const DEFAULT_BLOCKED_HOURS_UTC = [17, 18, 19, 21, 22];
const BLOCKED_HOURS_UTC = (() => {
  const raw = process.env.BLOCKED_HOURS_UTC;
  if (raw == null) return DEFAULT_BLOCKED_HOURS_UTC;
  if (String(raw).trim() === '') return [];   // setting vazio desliga
  return String(raw).split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n >= 0 && n <= 23);
})();

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  ASSETS,
  ASSET_MAX_SCORE,
  CACHE_TTL_MS,
  cache,
  isCacheValid,
  SESSION_HOURS,
  ASSET_BEST_SESSIONS,
  ASSET_FORBIDDEN_SESSIONS,
  ASSET_FORBIDDEN_DIRECTIONS,
  BLOCKED_HOURS_UTC,
};
