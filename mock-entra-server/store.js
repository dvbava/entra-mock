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
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES apps(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(oid) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

const DEMO_APP_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
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

  // ----- settings -----
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

  // ----- signing key (kept in the database so tokens stay valid across restarts) -----
  function signingKeyPem() {
    let pem = getSetting('signing_key_pem');
    if (pem) return pem;
    const legacy = path.join(dataDir, 'signing-key.json');
    if (fs.existsSync(legacy)) {
      try {
        pem = JSON.parse(fs.readFileSync(legacy, 'utf-8')).pem;
        crypto.createPrivateKey(pem);
        fs.renameSync(legacy, `${legacy}.migrated`);
      } catch {
        pem = undefined;
      }
    }
    pem ||= crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    setSetting('signing_key_pem', pem);
    return pem;
  }

  // ----- seeding / legacy import -----
  function seedDefaults() {
    const createdAt = new Date().toISOString();
    tx(() => {
      const user = db.prepare('INSERT INTO users (oid, name, preferred_username) VALUES (?, ?, ?)');
      user.run('11111111-1111-1111-1111-111111111111', 'Alice Reader', 'alice.reader@contoso.onmicrosoft.com');
      user.run('22222222-2222-2222-2222-222222222222', 'Bob Writer', 'bob.writer@contoso.onmicrosoft.com');
      user.run('33333333-3333-3333-3333-333333333333', 'Charlie Admin', 'charlie.admin@contoso.onmicrosoft.com');

      db.prepare('INSERT INTO apps (client_id, name, token_lifetime_seconds, created_at) VALUES (?, ?, ?, ?)').run(DEMO_APP_ID, 'React Todo SPA', DEFAULT_LIFETIME, createdAt);
      for (const r of ['RoleRead', 'RoleWrite', 'RoleAdmin']) db.prepare('INSERT INTO app_roles (app_id, role) VALUES (?, ?)').run(DEMO_APP_ID, r);
      for (const u of ['http://localhost:5173/callback', 'http://localhost:5173']) db.prepare('INSERT INTO redirect_uris (app_id, uri) VALUES (?, ?)').run(DEMO_APP_ID, u);
      db.prepare('INSERT INTO app_secrets (id, app_id, description, secret, created_at) VALUES (?, ?, ?, ?, ?)').run('sec-default-1', DEMO_APP_ID, 'Default Dev Secret', 'dev-secret-value-123', createdAt);
      for (const [uid, role] of [
        ['11111111-1111-1111-1111-111111111111', 'RoleRead'],
        ['22222222-2222-2222-2222-222222222222', 'RoleWrite'],
        ['33333333-3333-3333-3333-333333333333', 'RoleAdmin'],
      ]) {
        db.prepare('INSERT INTO assignments (app_id, user_id) VALUES (?, ?)').run(DEMO_APP_ID, uid);
        db.prepare('INSERT INTO assignment_roles (app_id, user_id, role) VALUES (?, ?, ?)').run(DEMO_APP_ID, uid, role);
      }

      const spId = 'sp-11111111-2222-3333-4444-555555555555';
      db.prepare('INSERT INTO service_accounts (id, name, client_id, target_app_id) VALUES (?, ?, ?, ?)').run(spId, 'CI/CD Pipeline Worker', '99999999-8888-7777-6666-555555555555', DEMO_APP_ID);
      db.prepare('INSERT INTO service_account_roles (sp_id, role) VALUES (?, ?)').run(spId, 'RoleAdmin');
      db.prepare('INSERT INTO service_account_secrets (id, sp_id, description, secret, created_at) VALUES (?, ?, ?, ?, ?)').run('sp-sec-1', spId, 'Primary Pipeline Key', 'sp-secret-key-987', createdAt);
    });
  }

  /** One-time import of the previous JSON file store (v1 and v2 layouts). */
  function importLegacyJson() {
    const jsonPath = path.join(dataDir, 'db.json');
    if (!fs.existsSync(jsonPath)) return false;
    let d;
    try {
      d = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    } catch {
      return false;
    }
    try {
      tx(() => {
      if (d.tenantId) setSetting('tenant_id', d.tenantId);
      const userIds = new Set();
      for (const u of d.users ?? []) {
        db.prepare('INSERT OR IGNORE INTO users (oid, name, preferred_username) VALUES (?, ?, ?)').run(u.oid, u.name, u.preferred_username);
        userIds.add(u.oid);
      }
      const appIds = new Map();
      for (const a of d.apps ?? []) {
        db.prepare('INSERT OR IGNORE INTO apps (client_id, name, token_lifetime_seconds, created_at) VALUES (?, ?, ?, ?)').run(a.clientId, a.name, DEFAULT_LIFETIME, new Date().toISOString());
        const roles = new Set(a.roles ?? d.roles ?? []);
        for (const asg of a.assignments ?? []) for (const r of asg.roles ?? []) roles.add(r);
        for (const r of roles) db.prepare('INSERT OR IGNORE INTO app_roles (app_id, role) VALUES (?, ?)').run(a.clientId, r);
        appIds.set(a.clientId, roles);
        for (const uri of a.redirectUris ?? []) db.prepare('INSERT OR IGNORE INTO redirect_uris (app_id, uri) VALUES (?, ?)').run(a.clientId, uri);
        for (const s of a.secrets ?? []) {
          db.prepare('INSERT OR IGNORE INTO app_secrets (id, app_id, description, secret, created_at) VALUES (?, ?, ?, ?, ?)').run(s.id, a.clientId, s.description, s.secret, s.createdAt ?? new Date().toISOString());
        }
        for (const asg of a.assignments ?? []) {
          if (!userIds.has(asg.userId)) continue;
          db.prepare('INSERT OR IGNORE INTO assignments (app_id, user_id) VALUES (?, ?)').run(a.clientId, asg.userId);
          for (const r of asg.roles ?? []) db.prepare('INSERT OR IGNORE INTO assignment_roles (app_id, user_id, role) VALUES (?, ?, ?)').run(a.clientId, asg.userId, r);
        }
      }
      for (const sp of d.serviceAccounts ?? []) {
        const target = appIds.has(sp.targetAppClientId) ? sp.targetAppClientId : null;
        db.prepare('INSERT OR IGNORE INTO service_accounts (id, name, client_id, target_app_id) VALUES (?, ?, ?, ?)').run(sp.id, sp.name, sp.clientId, target);
        for (const r of sp.roles ?? []) {
          if (target && appIds.get(target).has(r)) db.prepare('INSERT OR IGNORE INTO service_account_roles (sp_id, role) VALUES (?, ?)').run(sp.id, r);
        }
        for (const s of sp.secrets ?? []) {
          db.prepare('INSERT OR IGNORE INTO service_account_secrets (id, sp_id, description, secret, created_at) VALUES (?, ?, ?, ?, ?)').run(s.id, sp.id, s.description, s.secret, s.createdAt ?? new Date().toISOString());
        }
      }
      });
    } catch (err) {
      console.error(`Could not import ${jsonPath} (${err.message}); starting from the default data instead.`);
      return false;
    }
    fs.renameSync(jsonPath, `${jsonPath}.migrated`);
    return true;
  }

  if (!getSetting('initialized')) {
    setSetting('tenant_id', TENANT_ID);
    const imported = importLegacyJson();
    if (!imported) seedDefaults();
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
        for (const t of ['auth_codes', 'refresh_tokens', 'service_accounts', 'apps', 'users']) run(`DELETE FROM ${t}`);
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
        'INSERT INTO auth_codes (code, client_id, user_id, redirect_uri, scope, nonce, code_challenge, code_challenge_method, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        code, e.clientId, e.userId, e.redirectUri, e.scope, e.nonce || null, e.codeChallenge || null, e.codeChallengeMethod || null, e.expiresAt
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
        };
      });
    },
    putRefresh: (token, e) => run('INSERT INTO refresh_tokens (token, client_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?)', token, e.clientId, e.userId, e.scope, e.expiresAt),
    takeRefresh(token) {
      return tx(() => {
        const r = db.prepare('SELECT * FROM refresh_tokens WHERE token = ?').get(token);
        if (!r) return null;
        run('DELETE FROM refresh_tokens WHERE token = ?', token);
        if (r.expires_at < nowSec()) return null;
        return { clientId: r.client_id, userId: r.user_id, scope: r.scope };
      });
    },
    purgeExpired() {
      const t = nowSec();
      run('DELETE FROM auth_codes WHERE expires_at < ?', t);
      run('DELETE FROM refresh_tokens WHERE expires_at < ?', t);
    },
  };
}
