import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TENANT_ID = '72f988bf-86f1-41af-91ab-2d7cd011db47';
export const DEFAULT_LIFETIME = 3600;
export const MIN_LIFETIME = 1;
export const MAX_LIFETIME = 86400;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  oid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  preferred_username TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS apps (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_lifetime_seconds INTEGER NOT NULL DEFAULT ${DEFAULT_LIFETIME}
    CHECK (token_lifetime_seconds BETWEEN ${MIN_LIFETIME} AND ${MAX_LIFETIME}),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_roles (
  app_id TEXT NOT NULL REFERENCES apps(client_id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (app_id, role)
);

CREATE TABLE IF NOT EXISTS redirect_uris (
  app_id TEXT NOT NULL REFERENCES apps(client_id) ON DELETE CASCADE,
  uri TEXT NOT NULL,
  PRIMARY KEY (app_id, uri)
);

CREATE TABLE IF NOT EXISTS app_secrets (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(client_id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  secret TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
  app_id TEXT NOT NULL REFERENCES apps(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(oid) ON DELETE CASCADE,
  PRIMARY KEY (app_id, user_id)
);

CREATE TABLE IF NOT EXISTS assignment_roles (
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (app_id, user_id, role),
  FOREIGN KEY (app_id, user_id) REFERENCES assignments(app_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (app_id, role) REFERENCES app_roles(app_id, role) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS service_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  target_app_id TEXT REFERENCES apps(client_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS service_account_roles (
  sp_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (sp_id, role)
);

CREATE TABLE IF NOT EXISTS service_account_secrets (
  id TEXT PRIMARY KEY,
  sp_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  secret TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES apps(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(oid) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  nonce TEXT,
  code_challenge TEXT,
  code_challenge_method TEXT,
  sid TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES apps(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(oid) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  sid TEXT,
  expires_at INTEGER NOT NULL
);

-- Browser SSO sessions: one row per (browser session cookie, signed-in user). Powers prompt=none silent sign-in.
CREATE TABLE IF NOT EXISTS sso_sessions (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(oid) ON DELETE CASCADE,
  sid TEXT NOT NULL UNIQUE,
  signed_in_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id)
);
`;

const nowSec = () => Math.floor(Date.now() / 1000);

function groupBy(rows, key) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r[key])) map.set(r[key], []);
    map.get(r[key]).push(r);
  }
  return map;
}

export function openStore({ dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'entra-mock.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Databases created before SSO sessions existed lack the sid columns
  for (const table of ['auth_codes', 'refresh_tokens']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === 'sid')) db.exec(`ALTER TABLE ${table} ADD COLUMN sid TEXT`);
  }

  // node:sqlite has no transaction helper; this one commits on success, rolls back on error, and nests safely
  let txDepth = 0;
  const tx = (fn) => {
    if (txDepth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    txDepth++;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      txDepth--;
    }
  };

  // ----- reads -----
  const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  const setSetting = (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

  // ----- reads -----
  function snapshot() {
    const q = (sql) => db.prepare(sql).all();
    const roles = groupBy(q('SELECT app_id, role FROM app_roles ORDER BY rowid'), 'app_id');
    const uris = groupBy(q('SELECT app_id, uri FROM redirect_uris ORDER BY rowid'), 'app_id');
    const secrets = groupBy(q('SELECT id, app_id, description, secret, created_at FROM app_secrets ORDER BY rowid'), 'app_id');
    const assignments = q('SELECT app_id, user_id FROM assignments ORDER BY rowid');
    const asgRoles = groupBy(
      q(`SELECT ar.app_id, ar.user_id, ar.role FROM assignment_roles ar
         JOIN app_roles r ON r.app_id = ar.app_id AND r.role = ar.role ORDER BY r.rowid`).map((r) => ({ ...r, k: `${r.app_id}|${r.user_id}` })),
      'k'
    );
    const asgByApp = groupBy(assignments, 'app_id');

    const apps = q('SELECT client_id, name, token_lifetime_seconds, created_at FROM apps ORDER BY rowid').map((a) => ({
      clientId: a.client_id,
      name: a.name,
      tokenLifetimeSeconds: a.token_lifetime_seconds,
      roles: (roles.get(a.client_id) ?? []).map((r) => r.role),
      redirectUris: (uris.get(a.client_id) ?? []).map((u) => u.uri),
      secrets: (secrets.get(a.client_id) ?? []).map((s) => ({ id: s.id, description: s.description, secret: s.secret, createdAt: s.created_at })),
      assignments: (asgByApp.get(a.client_id) ?? []).map((x) => ({
        userId: x.user_id,
        roles: (asgRoles.get(`${a.client_id}|${x.user_id}`) ?? []).map((r) => r.role),
      })),
    }));

    const spRoles = groupBy(q('SELECT sp_id, role FROM service_account_roles ORDER BY rowid'), 'sp_id');
    const spSecrets = groupBy(q('SELECT id, sp_id, description, secret, created_at FROM service_account_secrets ORDER BY rowid'), 'sp_id');
    const serviceAccounts = q('SELECT id, name, client_id, target_app_id FROM service_accounts ORDER BY rowid').map((s) => ({
      id: s.id,
      name: s.name,
      clientId: s.client_id,
      targetAppClientId: s.target_app_id ?? '',
      roles: (spRoles.get(s.id) ?? []).map((r) => r.role),
      secrets: (spSecrets.get(s.id) ?? []).map((x) => ({ id: x.id, description: x.description, secret: x.secret, createdAt: x.created_at })),
    }));

    return {
      tenantId: getSetting('tenant_id') ?? TENANT_ID,
      users: q('SELECT oid, name, preferred_username FROM users ORDER BY rowid'),
      apps,
      serviceAccounts,
    };
  }

  function signingKeyPem() {
    let pem = getSetting('signing_key_pem');
    if (pem) return pem;
    pem ||= crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    setSetting('signing_key_pem', pem);
    return pem;
  }

  function seedDefaults() {
    const createdAt = new Date().toISOString();
    const appOid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const trader1Oid = '11111111-1111-1111-1111-111111111111';
    const trader2Oid = '22222222-2222-2222-2222-222222222222';

    tx(() => {
      const user = db.prepare('INSERT INTO users (oid, name, preferred_username) VALUES (?, ?, ?)');
      user.run(trader1Oid, 'User-1', 'user-1@contoso.onmicrosoft.com');
      user.run(trader2Oid, 'User-2', 'user-2@contoso.onmicrosoft.com');

      db.prepare('INSERT INTO apps (client_id, name, token_lifetime_seconds, created_at) VALUES (?, ?, ?, ?)').run(appOid, 'ToDo Application', DEFAULT_LIFETIME, createdAt);
      
      for (const r of ['RoleRead', 'RoleWrite']) {
        db.prepare('INSERT INTO app_roles (app_id, role) VALUES (?, ?)').run(appOid, r);
      }

      for (const u of ['http://localhost:5173/callback', 'http://localhost:5173']) {
        db.prepare('INSERT INTO redirect_uris (app_id, uri) VALUES (?, ?)').run(appOid, u);
      }

      db.prepare('INSERT INTO app_secrets (id, app_id, description, secret, created_at) VALUES (?, ?, ?, ?, ?)').run('sec-default-1', appOid, 'Default Dev Secret', 'dev-secret-value-123', createdAt);

      for (const [uid, role] of [
        [trader1Oid, 'RoleRead'],
        [trader2Oid, 'RoleRead'],
        [trader2Oid, 'RoleWrite'],
      ]) {
        db.prepare('INSERT OR IGNORE INTO assignments (app_id, user_id) VALUES (?, ?)').run(appOid, uid);
        db.prepare('INSERT INTO assignment_roles (app_id, user_id, role) VALUES (?, ?, ?)').run(appOid, uid, role);
      }

      const spId = 'sp-11111111-2222-3333-4444-555555555555';
      db.prepare('INSERT INTO service_accounts (id, name, client_id, target_app_id) VALUES (?, ?, ?, ?)').run(spId, 'SchedulerWorker', '99999999-8888-7777-6666-555555555555', appOid);
      db.prepare('INSERT INTO service_account_roles (sp_id, role) VALUES (?, ?)').run(spId, 'RoleWrite');
      db.prepare('INSERT INTO service_account_secrets (id, sp_id, description, secret, created_at) VALUES (?, ?, ?, ?, ?)').run('sp-sec-1', spId, 'Primary Pipeline Key', 'sp-secret-key-987', createdAt);
    });
  }

  if (!getSetting('initialized')) {
    setSetting('tenant_id', TENANT_ID);
    seedDefaults();
    setSetting('initialized', '1');
  }

  // ----- writes -----
  const run = (sql, ...params) => db.prepare(sql).run(...params);

  return {
    file,
    snapshot,
    getSetting,
    setSetting,
    signingKeyPem,
    close: () => db.close(),

    reset() {
      tx(() => {
        for (const t of ['auth_codes', 'refresh_tokens', 'sso_sessions', 'service_accounts', 'apps', 'users']) run(`DELETE FROM ${t}`);
      });
      seedDefaults();
    },

    addUser: (u) => run('INSERT INTO users (oid, name, preferred_username) VALUES (?, ?, ?)', u.oid, u.name, u.preferred_username),
    deleteUser: (oid) => run('DELETE FROM users WHERE oid = ?', oid),

    addApp({ clientId, name, tokenLifetimeSeconds, redirectUris, roles, secret }) {
      tx(() => {
        run('INSERT INTO apps (client_id, name, token_lifetime_seconds, created_at) VALUES (?, ?, ?, ?)', clientId, name, tokenLifetimeSeconds, new Date().toISOString());
        for (const r of roles) run('INSERT OR IGNORE INTO app_roles (app_id, role) VALUES (?, ?)', clientId, r);
        for (const u of redirectUris) run('INSERT OR IGNORE INTO redirect_uris (app_id, uri) VALUES (?, ?)', clientId, u);
        run('INSERT INTO app_secrets (id, app_id, description, secret, created_at) VALUES (?, ?, ?, ?, ?)', secret.id, clientId, secret.description, secret.secret, secret.createdAt);
      });
    },
    updateApp(clientId, { name, tokenLifetimeSeconds }) {
      if (name !== undefined) run('UPDATE apps SET name = ? WHERE client_id = ?', name, clientId);
      if (tokenLifetimeSeconds !== undefined) run('UPDATE apps SET token_lifetime_seconds = ? WHERE client_id = ?', tokenLifetimeSeconds, clientId);
    },
    deleteApp: (clientId) => run('DELETE FROM apps WHERE client_id = ?', clientId),

    addRole: (appId, role) => run('INSERT OR IGNORE INTO app_roles (app_id, role) VALUES (?, ?)', appId, role),
    deleteRole(appId, role) {
      tx(() => {
        // cascades to assignment_roles; service account grants are keyed by SP, so clear them explicitly
        run('DELETE FROM service_account_roles WHERE role = ? AND sp_id IN (SELECT id FROM service_accounts WHERE target_app_id = ?)', role, appId);
        run('DELETE FROM app_roles WHERE app_id = ? AND role = ?', appId, role);
      });
    },

    addRedirect: (appId, uri) => run('INSERT OR IGNORE INTO redirect_uris (app_id, uri) VALUES (?, ?)', appId, uri),
    removeRedirect: (appId, uri) => run('DELETE FROM redirect_uris WHERE app_id = ? AND uri = ?', appId, uri),

    addAppSecret: (appId, s) => run('INSERT INTO app_secrets (id, app_id, description, secret, created_at) VALUES (?, ?, ?, ?, ?)', s.id, appId, s.description, s.secret, s.createdAt),
    removeAppSecret: (appId, id) => run('DELETE FROM app_secrets WHERE app_id = ? AND id = ?', appId, id),

    setAssignment(appId, userId, roles) {
      tx(() => {
        run('INSERT OR IGNORE INTO assignments (app_id, user_id) VALUES (?, ?)', appId, userId);
        run('DELETE FROM assignment_roles WHERE app_id = ? AND user_id = ?', appId, userId);
        for (const r of roles) run('INSERT INTO assignment_roles (app_id, user_id, role) VALUES (?, ?, ?)', appId, userId, r);
      });
    },
    removeAssignment: (appId, userId) => run('DELETE FROM assignments WHERE app_id = ? AND user_id = ?', appId, userId),

    addServiceAccount({ id, name, clientId, targetAppId, roles, secret }) {
      tx(() => {
        run('INSERT INTO service_accounts (id, name, client_id, target_app_id) VALUES (?, ?, ?, ?)', id, name, clientId, targetAppId);
        for (const r of roles) run('INSERT INTO service_account_roles (sp_id, role) VALUES (?, ?)', id, r);
        run('INSERT INTO service_account_secrets (id, sp_id, description, secret, created_at) VALUES (?, ?, ?, ?, ?)', secret.id, id, secret.description, secret.secret, secret.createdAt);
      });
    },
    updateServiceAccount(id, { name, targetAppId, roles }) {
      tx(() => {
        if (name !== undefined) run('UPDATE service_accounts SET name = ? WHERE id = ?', name, id);
        if (targetAppId !== undefined) run('UPDATE service_accounts SET target_app_id = ? WHERE id = ?', targetAppId, id);
        if (roles !== undefined) {
          run('DELETE FROM service_account_roles WHERE sp_id = ?', id);
          for (const r of roles) run('INSERT INTO service_account_roles (sp_id, role) VALUES (?, ?)', id, r);
        }
      });
    },
    deleteServiceAccount: (id) => run('DELETE FROM service_accounts WHERE id = ?', id),
    addSpSecret: (spId, s) => run('INSERT INTO service_account_secrets (id, sp_id, description, secret, created_at) VALUES (?, ?, ?, ?, ?)', s.id, spId, s.description, s.secret, s.createdAt),
    removeSpSecret: (spId, id) => run('DELETE FROM service_account_secrets WHERE sp_id = ? AND id = ?', spId, id),

    // ----- protocol state (persisted so sessions survive a restart) -----
    putCode(code, e) {
      run(
        'INSERT INTO auth_codes (code, client_id, user_id, redirect_uri, scope, nonce, code_challenge, code_challenge_method, sid, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        code, e.clientId, e.userId, e.redirectUri, e.scope, e.nonce || null, e.codeChallenge || null, e.codeChallengeMethod || null, e.sid || null, e.expiresAt
      );
    },
    /** Returns the code's entry and deletes it (authorization codes are single use). */
    takeCode(code) {
      return tx(() => {
        const r = db.prepare('SELECT * FROM auth_codes WHERE code = ?').get(code);
        if (!r) return null;
        run('DELETE FROM auth_codes WHERE code = ?', code);
        if (r.expires_at < nowSec()) return null;
        return {
          clientId: r.client_id,
          userId: r.user_id,
          redirectUri: r.redirect_uri,
          scope: r.scope,
          nonce: r.nonce ?? '',
          codeChallenge: r.code_challenge ?? '',
          codeChallengeMethod: r.code_challenge_method ?? 'plain',
          sid: r.sid ?? '',
        };
      });
    },
    putRefresh: (token, e) => run('INSERT INTO refresh_tokens (token, client_id, user_id, scope, sid, expires_at) VALUES (?, ?, ?, ?, ?, ?)', token, e.clientId, e.userId, e.scope, e.sid || null, e.expiresAt),
    takeRefresh(token) {
      return tx(() => {
        const r = db.prepare('SELECT * FROM refresh_tokens WHERE token = ?').get(token);
        if (!r) return null;
        run('DELETE FROM refresh_tokens WHERE token = ?', token);
        if (r.expires_at < nowSec()) return null;
        return { clientId: r.client_id, userId: r.user_id, scope: r.scope, sid: r.sid ?? '' };
      });
    },
    purgeExpired() {
      const t = nowSec();
      run('DELETE FROM auth_codes WHERE expires_at < ?', t);
      run('DELETE FROM refresh_tokens WHERE expires_at < ?', t);
      run('DELETE FROM sso_sessions WHERE expires_at < ?', t);
    },

    // ----- SSO sessions (the browser cookie maps to the accounts signed in on that browser) -----
    /** Records that userId signed in on this browser session; returns that account's stable sid. */   
    signInSession(sessionId, userId, ttlSeconds) {
      return tx(() => {
        const existing = db.prepare('SELECT sid FROM sso_sessions WHERE session_id = ? AND user_id = ?').get(sessionId, userId);
        const sid = existing?.sid ?? crypto.randomUUID();
        run(
          `INSERT INTO sso_sessions (session_id, user_id, sid, signed_in_at, expires_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id, user_id) DO UPDATE SET signed_in_at = excluded.signed_in_at, expires_at = excluded.expires_at`,
          sessionId, userId, sid, nowSec(), nowSec() + ttlSeconds
        );
        return sid;
      });
    },
    sessionAccounts: (sessionId) =>
      db.prepare('SELECT user_id AS userId, sid FROM sso_sessions WHERE session_id = ? AND expires_at >= ? ORDER BY signed_in_at DESC, rowid DESC').all(sessionId, nowSec()),
    endSession: (sessionId) => run('DELETE FROM sso_sessions WHERE session_id = ?', sessionId).changes,
    endAllSessions: () => run('DELETE FROM sso_sessions').changes,
  };
}
