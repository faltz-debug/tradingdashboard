/**
 * logger.js — Logger estruturado leve (sem dependências externas)
 *
 * Níveis (do mais crítico ao mais verbose):
 *   error → warn → info → debug
 *
 * Configuração via variável de ambiente:
 *   LOG_LEVEL=error   → apenas erros críticos
 *   LOG_LEVEL=warn    → erros + avisos (recomendado em produção com muito tráfego)
 *   LOG_LEVEL=info    → operacional normal (padrão)
 *   LOG_LEVEL=debug   → tudo, incluindo ciclos e fetches verbose
 *
 * Formato: [ISO-TIMESTAMP] [LEVEL] mensagem
 * Em produção o Railway captura stdout/stderr e exibe com o timestamp dele.
 */

const LEVEL_MAP = { error: 0, warn: 1, info: 2, debug: 3 };

// Permite mudar o nível sem restart via variável de ambiente
function getMaxLevel() {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVEL_MAP[raw] ?? LEVEL_MAP.info;
}

function ts() {
  return new Date().toISOString();
}

function format(level, args) {
  // Serializa objetos/erros de forma legível
  const parts = args.map(a => {
    if (a instanceof Error) return `${a.message}${a.stack ? '\n' + a.stack : ''}`;
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  });
  return `[${ts()}] [${level.toUpperCase().padEnd(5)}] ${parts.join(' ')}`;
}

function log(level, ...args) {
  if ((LEVEL_MAP[level] ?? 99) > getMaxLevel()) return;
  const msg = format(level, args);
  if (level === 'error') console.error(msg);
  else if (level === 'warn') console.warn(msg);
  else console.log(msg);
}

const logger = {
  error: (...a) => log('error', ...a),
  warn:  (...a) => log('warn',  ...a),
  info:  (...a) => log('info',  ...a),
  debug: (...a) => log('debug', ...a),

  // Atalho para logar erro + stack sem try/catch verboso
  // Uso: logger.catch('contexto', err)
  catch: (context, err) => log('error', `${context}: ${err?.message || err}${err?.stack ? '\n' + err.stack : ''}`),
};

module.exports = logger;
