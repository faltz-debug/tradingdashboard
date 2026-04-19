'use strict';

const Database = require('better-sqlite3');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = process.env.DATABASE_PATH || path.join(DATA_DIR, 'trades.db');
const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'subscriber',
    access_status TEXT NOT NULL DEFAULT 'inactive',
    plan_code     TEXT NOT NULL DEFAULT 'free',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    last_login_at INTEGER,
    data          TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_email         ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_access_status ON users(access_status);
  CREATE INDEX IF NOT EXISTS idx_users_role          ON users(role);

  CREATE TABLE IF NOT EXISTS auth_sessions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    revoked_at    INTEGER,
    user_agent    TEXT,
    ip            TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id    ON auth_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
`);

const SESSION_TTL_MS = Math.max(1, parseInt(process.env.AUTH_SESSION_DAYS || '30', 10)) * 24 * 60 * 60 * 1000;
const ACTIVE_ACCESS_STATUSES = new Set(['active', 'trial']);
const USER_ROLES = new Set(['admin', 'subscriber']);
const ACCESS_STATUSES = new Set(['trial', 'active', 'inactive', 'past_due', 'canceled']);

const stmtInsertUser = db.prepare(`
  INSERT INTO users(id, email, password_hash, role, access_status, plan_code, created_at, updated_at, last_login_at, data)
  VALUES(@id, @email, @password_hash, @role, @access_status, @plan_code, @created_at, @updated_at, @last_login_at, @data)
`);

const stmtUpdateUser = db.prepare(`
  UPDATE users
     SET email = @email,
         password_hash = @password_hash,
         role = @role,
         access_status = @access_status,
         plan_code = @plan_code,
         updated_at = @updated_at,
         last_login_at = @last_login_at,
         data = @data
   WHERE id = @id
`);

const stmtInsertSession = db.prepare(`
  INSERT INTO auth_sessions(id, user_id, token_hash, created_at, updated_at, expires_at, revoked_at, user_agent, ip)
  VALUES(@id, @user_id, @token_hash, @created_at, @updated_at, @expires_at, @revoked_at, @user_agent, @ip)
`);

const stmtTouchSession = db.prepare(`
  UPDATE auth_sessions
     SET updated_at = ?, expires_at = ?
   WHERE id = ?
`);

const stmtRevokeSessionById = db.prepare(`
  UPDATE auth_sessions
     SET revoked_at = ?
   WHERE id = ? AND revoked_at IS NULL
`);

const stmtRevokeSessionsByUser = db.prepare(`
  UPDATE auth_sessions
     SET revoked_at = ?
   WHERE user_id = ? AND revoked_at IS NULL
`);

const stmtDeleteExpiredSessions = db.prepare(`
  DELETE FROM auth_sessions
   WHERE expires_at < ? OR revoked_at IS NOT NULL
`);

function now() {
  return Date.now();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  const derived = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function sanitizeProfile(profile) {
  const nowTs = now();
  return {
    name: String(profile?.name || '').trim().slice(0, 120),
    telegramHandle: String(profile?.telegramHandle || '').trim().slice(0, 120),
    notes: String(profile?.notes || '').trim().slice(0, 1000),
    subscriptionEndsAt: profile?.subscriptionEndsAt ? Number(profile.subscriptionEndsAt) : null,
    createdVia: String(profile?.createdVia || 'system').trim().slice(0, 60),
    updatedAt: nowTs,
  };
}

function mergeDefined(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value !== undefined) target[key] = value;
  }
  return target;
}

function materializeUser(row) {
  if (!row) return null;
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    accessStatus: row.access_status,
    planCode: row.plan_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    profile: data,
    hasVipAccess: ACTIVE_ACCESS_STATUSES.has(row.access_status) || row.role === 'admin',
  };
}

function materializeUserWithSecrets(row) {
  if (!row) return null;
  return {
    ...materializeUser(row),
    passwordHash: row.password_hash,
  };
}

function getUserRowByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));
}

function getUserRowById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByEmail(email) {
  return materializeUser(getUserRowByEmail(email));
}

function getUserById(id) {
  return materializeUser(getUserRowById(id));
}

function countUsers() {
  return db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
}

function assertRole(role) {
  if (!USER_ROLES.has(role)) throw new Error(`Role invalido: ${role}`);
}

function assertAccessStatus(accessStatus) {
  if (!ACCESS_STATUSES.has(accessStatus)) throw new Error(`Access status invalido: ${accessStatus}`);
}

function createUser({
  email,
  password,
  role = 'subscriber',
  accessStatus = 'inactive',
  planCode = 'free',
  profile = {},
} = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error('Email obrigatorio');
  if (!password || String(password).length < 8) throw new Error('Senha deve ter pelo menos 8 caracteres');
  assertRole(role);
  assertAccessStatus(accessStatus);
  if (getUserRowByEmail(normalizedEmail)) throw new Error('Email ja cadastrado');

  const ts = now();
  const payload = {
    id: randomId('usr'),
    email: normalizedEmail,
    password_hash: hashPassword(password),
    role,
    access_status: accessStatus,
    plan_code: String(planCode || 'free').trim().slice(0, 60) || 'free',
    created_at: ts,
    updated_at: ts,
    last_login_at: null,
    data: JSON.stringify(sanitizeProfile(profile)),
  };

  stmtInsertUser.run(payload);
  return getUserById(payload.id);
}

function updateUser(id, fields = {}) {
  const existing = getUserRowById(id);
  if (!existing) return null;

  const profile = { ...(JSON.parse(existing.data || '{}')) };
  if (fields.profile && typeof fields.profile === 'object') {
    mergeDefined(profile, fields.profile);
  }

  const nextRole = fields.role != null ? String(fields.role).trim() : existing.role;
  const nextStatus = fields.accessStatus != null ? String(fields.accessStatus).trim() : existing.access_status;
  const nextPlan = fields.planCode != null ? String(fields.planCode).trim() : existing.plan_code;
  assertRole(nextRole);
  assertAccessStatus(nextStatus);

  const payload = {
    id: existing.id,
    email: fields.email != null ? normalizeEmail(fields.email) : existing.email,
    password_hash: existing.password_hash,
    role: nextRole,
    access_status: nextStatus,
    plan_code: nextPlan || 'free',
    created_at: existing.created_at,
    updated_at: now(),
    last_login_at: existing.last_login_at,
    data: JSON.stringify(sanitizeProfile(profile)),
  };

  if (!payload.email) throw new Error('Email obrigatorio');
  const other = getUserRowByEmail(payload.email);
  if (other && other.id !== id) throw new Error('Email ja cadastrado');

  if (fields.password != null) {
    if (String(fields.password).length < 8) throw new Error('Senha deve ter pelo menos 8 caracteres');
    payload.password_hash = hashPassword(fields.password);
  }

  stmtUpdateUser.run(payload);
  return getUserById(id);
}

function authenticateUser(email, password) {
  const user = materializeUserWithSecrets(getUserRowByEmail(email));
  if (!user) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return user;
}

function createSession(userId, meta = {}) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const ts = now();
  const session = {
    id: randomId('sess'),
    user_id: userId,
    token_hash: tokenHash,
    created_at: ts,
    updated_at: ts,
    expires_at: ts + SESSION_TTL_MS,
    revoked_at: null,
    user_agent: meta.userAgent ? String(meta.userAgent).slice(0, 255) : null,
    ip: meta.ip ? String(meta.ip).slice(0, 120) : null,
  };

  stmtInsertSession.run(session);
  db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, userId);

  return {
    token: rawToken,
    sessionId: session.id,
    expiresAt: session.expires_at,
  };
}

function getUserBySessionToken(token, { touch = true } = {}) {
  if (!token) return null;
  stmtDeleteExpiredSessions.run(now());

  const tokenHash = hashSessionToken(token);
  const row = db.prepare(`
    SELECT s.id AS session_id, s.user_id, s.expires_at, u.*
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > ?
     LIMIT 1
  `).get(tokenHash, now());

  if (!row) return null;

  if (touch) {
    const nextExpiry = now() + SESSION_TTL_MS;
    stmtTouchSession.run(now(), nextExpiry, row.session_id);
    row.expires_at = nextExpiry;
  }

  const user = materializeUser(row);
  return {
    ...user,
    sessionId: row.session_id,
    sessionExpiresAt: row.expires_at,
  };
}

function revokeSession(token) {
  if (!token) return false;
  const tokenHash = hashSessionToken(token);
  const row = db.prepare('SELECT id FROM auth_sessions WHERE token_hash = ?').get(tokenHash);
  if (!row) return false;
  return stmtRevokeSessionById.run(now(), row.id).changes > 0;
}

function revokeSessionsForUser(userId) {
  return stmtRevokeSessionsByUser.run(now(), userId).changes;
}

function listUsers({ limit = 100, accessStatus, role } = {}) {
  const where = [];
  const params = [];
  if (accessStatus) {
    where.push('access_status = ?');
    params.push(accessStatus);
  }
  if (role) {
    where.push('role = ?');
    params.push(role);
  }

  const sql = `
    SELECT *
      FROM users
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC
     LIMIT ?
  `;
  params.push(Math.max(1, Math.min(parseInt(limit, 10) || 100, 500)));
  return db.prepare(sql).all(...params).map(materializeUser);
}

function ensureBootstrapAdmin({
  email,
  password,
  name = 'Admin',
  telegramHandle = '',
  planCode = 'vip',
} = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !password) return null;

  const existing = getUserByEmail(normalizedEmail);
  if (!existing) {
    return createUser({
      email: normalizedEmail,
      password,
      role: 'admin',
      accessStatus: 'active',
      planCode,
      profile: {
        name,
        telegramHandle,
        createdVia: 'bootstrap_admin',
      },
    });
  }

  return updateUser(existing.id, {
    password,
    role: 'admin',
    accessStatus: 'active',
    planCode,
    profile: {
      ...existing.profile,
      name: name || existing.profile?.name || 'Admin',
      telegramHandle: telegramHandle || existing.profile?.telegramHandle || '',
      createdVia: existing.profile?.createdVia || 'bootstrap_admin',
    },
  });
}

module.exports = {
  ACTIVE_ACCESS_STATUSES,
  ensureBootstrapAdmin,
  countUsers,
  createSession,
  createUser,
  getUserByEmail,
  getUserById,
  getUserBySessionToken,
  authenticateUser,
  listUsers,
  revokeSession,
  revokeSessionsForUser,
  updateUser,
};
