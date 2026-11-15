import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, DEFAULT_LIFETIME, MIN_LIFETIME, MAX_LIFETIME } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR || __dirname;
const PORTAL_DIR = path.join(__dirname, 'portal');

const CODE_TTL = 600;
const REFRESH_TTL = 24 * 3600;
const OIDC_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);

const store = openStore({ dataDir: DATA_DIR });

// ---------------------------------------------------------------------------
// Signing key + JWT helpers (RS256; the key lives in SQLite so tokens survive restarts)
// ---------------------------------------------------------------------------
function loadSigningKey() {
  const privateKey = crypto.createPrivateKey(store.signingKeyPem());
  const publicKey = crypto.createPublicKey(privateKey);
  const { n, e } = publicKey.export({ format: 'jwk' });
  const kid = crypto.createHash('sha256').update(`${e}.${n}`).digest('base64url').slice(0, 27);
  return { privateKey, publicKey, kid, jwk: { kty: 'RSA', use: 'sig', alg: 'RS256', kid, n, e } };
}

const signing = loadSigningKey();
const b64json = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function signJwt(payload) {
  const input = `${b64json({ typ: 'JWT', alg: 'RS256', kid: signing.kid })}.${b64json(payload)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), signing.privateKey).toString('base64url');
  return `${input}.${sig}`;
}

function verifyJwt(token) {
  try {
    const [h, p, s] = String(token).split('.');
    if (!h || !p || !s) return null;
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), signing.publicKey, Buffer.from(s, 'base64url'))) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf-8'));
    return payload.exp > nowSec() ? payload : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
const nowSec = () => Math.floor(Date.now() / 1000);
const newSecret = (prefix) => `${prefix}_${crypto.randomBytes(18).toString('hex')}`;
const issuerFor = (tid) => `${PUBLIC_URL}/${tid}/v2.0`;
const spObjectId = (sp) => sp.id.replace(/^sp-/, '');
const sameId = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const findApp = (db, clientId) => db.apps.find((a) => sameId(a.clientId, clientId));
const findSp = (db, id) => db.serviceAccounts.find((s) => s.id === id);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const secretMatches = (secrets, candidate) => secrets.some((s) => safeEqual(s.secret, candidate));

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidRedirect(raw) {
  try {
    return Boolean(new URL(raw).protocol);
  } catch {
    return false;
  }
}

function parseList(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[,\n]/);
  return [...new Set(list.map((u) => String(u).trim()).filter(Boolean))];
}

/** Returns the validated lifetime in seconds, or an error message. */
function parseLifetime(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_LIFETIME || n > MAX_LIFETIME) {
    return { error: `Token lifetime must be a whole number of seconds between ${MIN_LIFETIME} and ${MAX_LIFETIME}` };
  }
  return { value: n };
}

/** Pull the resource (app) GUID and permission out of a scope like api://<guid>/.default */
function parseScope(scopeStr) {
  const first = String(scopeStr || '')
    .split(/\s+/)
    .filter(Boolean)
    .find((s) => !OIDC_SCOPES.has(s.toLowerCase()));
  if (!first) return { raw: '' };
  const m = first.match(/^(?:api:\/\/)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/(.*))?$/);
  return { raw: first, resourceId: m?.[1]?.toLowerCase(), permission: m?.[2] };
}

function oauthError(res, status, error, aadsts, message) {
  res.status(status).json({
    error,
    error_description: `AADSTS${aadsts}: ${message}`,
    error_codes: [Number(aadsts)],
    timestamp: new Date().toISOString().replace('T', ' ').replace(/\..+/, 'Z'),
    trace_id: crypto.randomUUID(),
    correlation_id: crypto.randomUUID(),
  });
}

// ---------------------------------------------------------------------------
// Token issuing. Lifetime comes from the app the token is issued for (its audience).
// ---------------------------------------------------------------------------
function baseClaims(db, audienceApp) {
  const iat = nowSec();
  return {
    aud: audienceApp.clientId,
    iss: issuerFor(db.tenantId),
    iat,
    nbf: iat,
    exp: iat + audienceApp.tokenLifetimeSeconds,
    tid: db.tenantId,
    ver: '2.0',
    uti: crypto.randomBytes(12).toString('base64url'),
  };
}

function userTokens(db, { app, user, roles, scope, nonce, usedSecret }) {
  const scopes = String(scope || '').split(/\s+/).filter(Boolean);
  const scp = scopes
    .filter((s) => !OIDC_SCOPES.has(s.toLowerCase()))
    .map((s) => s.split('/').pop())
    .filter((s) => s && s !== '.default')
    .join(' ');
  const identity = {
    oid: user.oid,
    sub: user.oid,
    name: user.name,
    preferred_username: user.preferred_username,
    email: user.preferred_username,
  };
  const out = {
    token_type: 'Bearer',
    scope: scopes.join(' '),
    expires_in: app.tokenLifetimeSeconds,
    ext_expires_in: app.tokenLifetimeSeconds,
    access_token: signJwt({
      ...baseClaims(db, app),
      azp: app.clientId,
      azpacr: usedSecret ? '1' : '0',
      ...identity,
      ...(scp ? { scp } : {}),
      ...(roles.length ? { roles } : {}),
    }),
  };
  if (scopes.some((s) => s.toLowerCase() === 'openid')) {
    out.id_token = signJwt({
      ...baseClaims(db, app),
      ...identity,
      ...(roles.length ? { roles } : {}),
      ...(nonce ? { nonce } : {}),
    });
  }
  return out;
}

function appToken(db, { principalClientId, oid, name, audienceApp, roles }) {
  return signJwt({
    ...baseClaims(db, audienceApp),
    azp: principalClientId,
    azpacr: '1',
    oid,
    sub: oid,
    idtyp: 'app',
    app_displayname: name,
    ...(roles.length ? { roles } : {}),
  });
}

/** Roles in a token are exactly those mapped to the principal that the audience app still defines. */
const effectiveRoles = (app, roles) => roles.filter((r) => app.roles.includes(r));

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function validateTenant(req, res, next) {
  const { tenantId } = req.params;
  const actual = store.snapshot().tenantId;
  if (tenantId !== actual && !['common', 'organizations'].includes(tenantId)) {
    return oauthError(res, 400, 'invalid_tenant', '90002', `Tenant '${tenantId}' not found. Expected '${actual}'.`);
  }
  req.resolvedTenantId = actual;
  next();
}

// ===========================================================================
// ADMIN API (used by the admin portal UI)
// ===========================================================================
const admin = express.Router();
const done = (res) => res.json(store.snapshot());
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

/** Looks the app up and answers 404 itself when it is missing. */
function withApp(handler) {
  return (req, res) => {
    const db = store.snapshot();
    const target = findApp(db, req.params.clientId);
    if (!target) return bad(res, 'App not found', 404);
    return handler(req, res, target, db);
  };
}

function withSp(handler) {
  return (req, res) => {
    const db = store.snapshot();
    const sp = findSp(db, req.params.id);
    if (!sp) return bad(res, 'Service account not found', 404);
    return handler(req, res, sp, db);
  };
}

admin.get('/info', (req, res) => {
  const db = store.snapshot();
  const base = `${PUBLIC_URL}/${db.tenantId}`;
  res.json({
    publicUrl: PUBLIC_URL,
    tenantId: db.tenantId,
    authority: base,
    discoveryUrl: `${base}/v2.0/.well-known/openid-configuration`,
    authorizeUrl: `${base}/oauth2/v2.0/authorize`,
    tokenUrl: `${base}/oauth2/v2.0/token`,
    jwksUrl: `${base}/discovery/v2.0/keys`,
    issuer: issuerFor(db.tenantId),
    databaseFile: store.file,
    tokenLifetime: { default: DEFAULT_LIFETIME, min: MIN_LIFETIME, max: MAX_LIFETIME },
  });
});

admin.get('/state', (req, res) => done(res));

admin.post('/reset', (req, res) => {
  store.reset();
  done(res);
});

// --- Users ---
admin.post('/users', (req, res) => {
  const db = store.snapshot();
  const name = String(req.body.name || '').trim();
  const upn = String(req.body.preferred_username || '').trim();
  if (!name || !upn) return bad(res, 'Display name and email/UPN are required');
  if (db.users.some((u) => u.preferred_username.toLowerCase() === upn.toLowerCase())) {
    return bad(res, `A user with the name ${upn} already exists`);
  }
  store.addUser({ oid: crypto.randomUUID(), name, preferred_username: upn });
  done(res);
});

admin.delete('/users/:oid', (req, res) => {
  store.deleteUser(req.params.oid);
  done(res);
});

// --- App registrations ---
admin.post('/apps', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return bad(res, 'Application name is required');
  const uris = parseList(req.body.redirectUris);
  const invalid = uris.find((u) => !isValidRedirect(u));
  if (invalid) return bad(res, `'${invalid}' is not a valid redirect URI`);
  const roles = parseList(req.body.roles);
  if (roles.some((r) => /\s/.test(r))) return bad(res, 'Role values cannot contain spaces');
  let lifetime = DEFAULT_LIFETIME;
  if (req.body.tokenLifetimeSeconds !== undefined && req.body.tokenLifetimeSeconds !== '') {
    const parsed = parseLifetime(req.body.tokenLifetimeSeconds);
    if (parsed.error) return bad(res, parsed.error);
    lifetime = parsed.value;
  }
  store.addApp({
    clientId: crypto.randomUUID(),
    name,
    tokenLifetimeSeconds: lifetime,
    redirectUris: uris.length ? uris : ['http://localhost:5173/callback'],
    roles,
    secret: { id: crypto.randomUUID(), description: 'Initial App Secret', secret: newSecret('appsec'), createdAt: new Date().toISOString() },
  });
  done(res);
});

admin.put(
  '/apps/:clientId',
  withApp((req, res, target) => {
    const changes = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return bad(res, 'Application name is required');
      changes.name = name;
    }
    if (req.body.tokenLifetimeSeconds !== undefined) {
      const parsed = parseLifetime(req.body.tokenLifetimeSeconds);
      if (parsed.error) return bad(res, parsed.error);
      changes.tokenLifetimeSeconds = parsed.value;
    }
    store.updateApp(target.clientId, changes);
    done(res);
  })
);

admin.delete(
  '/apps/:clientId',
  withApp((req, res, target) => {
    store.deleteApp(target.clientId); // service accounts keep their secrets; their target app is cleared
    done(res);
  })
);

admin.post(
  '/apps/:clientId/redirects',
  withApp((req, res, target) => {
    const uri = String(req.body.redirectUri || '').trim();
    if (!uri) return bad(res, 'Redirect URI is required');
    if (!isValidRedirect(uri)) return bad(res, `'${uri}' is not a valid redirect URI`);
    store.addRedirect(target.clientId, uri);
    done(res);
  })
);

admin.delete(
  '/apps/:clientId/redirects',
  withApp((req, res, target) => {
    store.removeRedirect(target.clientId, String(req.body.redirectUri || ''));
    done(res);
  })
);

admin.post(
  '/apps/:clientId/secrets',
  withApp((req, res, target) => {
    store.addAppSecret(target.clientId, {
      id: crypto.randomUUID(),
      description: String(req.body.description || '').trim() || 'Client Secret',
      secret: newSecret('appsec'),
      createdAt: new Date().toISOString(),
    });
    done(res);
  })
);

admin.delete(
  '/apps/:clientId/secrets/:secretId',
  withApp((req, res, target) => {
    store.removeAppSecret(target.clientId, req.params.secretId);
    done(res);
  })
);

// --- App roles (defined per app, then mapped to users and service accounts) ---
admin.post(
  '/apps/:clientId/roles',
  withApp((req, res, target) => {
    const role = String(req.body.role || '').trim();
    if (!role) return bad(res, 'Role value is required');
    if (/\s/.test(role)) return bad(res, 'Role value cannot contain spaces (use something like Approver or Orders.Read)');
    if (role.length > 120) return bad(res, 'Role value is too long (max 120 characters)');
    store.addRole(target.clientId, role);
    done(res);
  })
);

admin.delete(
  '/apps/:clientId/roles/:role',
  withApp((req, res, target) => {
    store.deleteRole(target.clientId, req.params.role);
    done(res);
  })
);

// --- Mapping roles to users ---
admin.post(
  '/apps/:clientId/assignments',
  withApp((req, res, target, db) => {
    const { userId } = req.body;
    if (!userId) return bad(res, 'userId is required');
    if (!db.users.some((u) => u.oid === userId)) return bad(res, 'User not found', 404);
    const roles = [...new Set(Array.isArray(req.body.roles) ? req.body.roles : [])];
    const unknown = roles.filter((r) => !target.roles.includes(r));
    if (unknown.length) return bad(res, `'${target.name}' has no role named ${unknown.join(', ')}. Define it on the app first.`);
    store.setAssignment(target.clientId, userId, roles);
    done(res);
  })
);

admin.delete(
  '/apps/:clientId/assignments/:userId',
  withApp((req, res, target) => {
    store.removeAssignment(target.clientId, req.params.userId);
    done(res);
  })
);

// Issues a real signed token for an assigned user, so the roles they produce can be inspected without signing in
admin.post(
  '/apps/:clientId/assignments/:userId/token',
  withApp((req, res, target, db) => {
    const asg = target.assignments.find((a) => a.userId === req.params.userId);
    const user = db.users.find((u) => u.oid === req.params.userId);
    if (!asg || !user) return bad(res, 'User is not assigned to this app', 404);
    const tokens = userTokens(db, {
      app: target,
      user,
      roles: effectiveRoles(target, asg.roles),
      scope: `openid profile email api://${target.clientId}/access_as_user`,
      nonce: '',
      usedSecret: false,
    });
    res.json({ access_token: tokens.access_token, id_token: tokens.id_token });
  })
);

// --- Service accounts (client_credentials principals) ---
/** Resolves the target app and roles for a service account; roles must be defined on that app. */
function validateSpInput(db, body, existing) {
  const targetId = String(body.targetAppClientId ?? existing?.targetAppClientId ?? db.apps[0]?.clientId ?? '').trim();
  if (!targetId) return { error: 'Create an app registration first, then pick it as the target app' };
  const targetApp = findApp(db, targetId);
  if (!targetApp) return { error: 'Target app not found' };

  let roles;
  if (body.roles !== undefined) {
    roles = [...new Set(Array.isArray(body.roles) ? body.roles : [])];
    const unknown = roles.filter((r) => !targetApp.roles.includes(r));
    if (unknown.length) return { error: `'${targetApp.name}' has no role named ${unknown.join(', ')}. Define it on the app first.` };
  } else {
    // Retargeting keeps only the roles the new app also defines
    roles = (existing?.roles ?? []).filter((r) => targetApp.roles.includes(r));
  }
  return { value: { targetAppId: targetApp.clientId, roles } };
}

admin.post('/service-accounts', (req, res) => {
  const db = store.snapshot();
  const name = String(req.body.name || '').trim();
  if (!name) return bad(res, 'Service account name is required');
  const parsed = validateSpInput(db, req.body, null);
  if (parsed.error) return bad(res, parsed.error);
  store.addServiceAccount({
    id: `sp-${crypto.randomUUID()}`,
    name,
    clientId: crypto.randomUUID(),
    ...parsed.value,
    secret: { id: crypto.randomUUID(), description: 'Initial Service Secret', secret: newSecret('spsec'), createdAt: new Date().toISOString() },
  });
  done(res);
});

admin.put(
  '/service-accounts/:id',
  withSp((req, res, sp, db) => {
    const changes = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return bad(res, 'Service account name is required');
      changes.name = name;
    }
    if (req.body.targetAppClientId !== undefined || req.body.roles !== undefined) {
      const parsed = validateSpInput(db, req.body, sp);
      if (parsed.error) return bad(res, parsed.error);
      Object.assign(changes, parsed.value);
    }
    store.updateServiceAccount(sp.id, changes);
    done(res);
  })
);

admin.delete('/service-accounts/:id', (req, res) => {
  store.deleteServiceAccount(req.params.id);
  done(res);
});

admin.post(
  '/service-accounts/:id/secrets',
  withSp((req, res, sp) => {
    store.addSpSecret(sp.id, {
      id: crypto.randomUUID(),
      description: String(req.body.description || '').trim() || 'Service Secret',
      secret: newSecret('spsec'),
      createdAt: new Date().toISOString(),
    });
    done(res);
  })
);

admin.delete(
  '/service-accounts/:id/secrets/:secretId',
  withSp((req, res, sp) => {
    store.removeSpSecret(sp.id, req.params.secretId);
    done(res);
  })
);

app.use('/api/admin', admin);

// ===========================================================================
// Admin portal (built React SPA in ./portal) served at /
// ===========================================================================
if (fs.existsSync(path.join(PORTAL_DIR, 'index.html'))) {
  app.use(express.static(PORTAL_DIR));
}
app.get('/', (req, res) => {
  const index = path.join(PORTAL_DIR, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res
    .status(200)
    .send(
      '<h3>Admin portal not built yet</h3><p>Run <code>npm install &amp;&amp; npm run build</code> in <code>entra-admin-portal/</code>, ' +
        'or run <code>npm run dev</code> there and open <a href="http://localhost:5174">http://localhost:5174</a>.</p>'
    );
});

// ===========================================================================
// OIDC / OAuth 2.0 protocol endpoints (Entra v2.0 shaped)
// ===========================================================================
app.get('/:tenantId/v2.0/.well-known/openid-configuration', validateTenant, (req, res) => {
  const base = `${PUBLIC_URL}/${req.resolvedTenantId}`;
  res.json({
    issuer: issuerFor(req.resolvedTenantId),
    authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
    token_endpoint: `${base}/oauth2/v2.0/token`,
    jwks_uri: `${base}/discovery/v2.0/keys`,
    userinfo_endpoint: `${PUBLIC_URL}/oidc/userinfo`,
    end_session_endpoint: `${base}/oauth2/v2.0/logout`,
    response_types_supported: ['code'],
    response_modes_supported: ['query', 'fragment', 'form_post'],
    grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'],
    subject_types_supported: ['pairwise'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256', 'plain'],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nbf', 'name', 'preferred_username', 'email', 'oid', 'tid', 'roles', 'ver', 'nonce'],
  });
});

app.get('/:tenantId/discovery/v2.0/keys', validateTenant, (req, res) => res.json({ keys: [signing.jwk] }));

app.all('/oidc/userinfo', (req, res) => {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const claims = verifyJwt(bearer);
  if (!claims || claims.idtyp === 'app') {
    res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
    return res.status(401).json({ error: 'invalid_token', error_description: 'A valid, unexpired user access token is required.' });
  }
  res.json({ sub: claims.sub, name: claims.name, preferred_username: claims.preferred_username, email: claims.email });
});

app.get('/:tenantId/oauth2/v2.0/logout', validateTenant, (req, res) => {
  const target = req.query.post_logout_redirect_uri;
  if (target && isValidRedirect(String(target))) return res.redirect(String(target));
  res.send(pageShell('Signed out', '<h1>You signed out</h1><p>You can close this window.</p>'));
});

// --- /authorize: account picker scoped to users assigned to the requesting app ---
function authErrorPage(res, aadsts, message) {
  res.status(400).send(pageShell('Sign-in error', `<h1>Sign-in error</h1><div class="warn"><strong>AADSTS${aadsts}</strong>: ${escapeHtml(message)}</div>`));
}

function deliverAuthResponse(res, redirectUri, mode, params) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  if (mode === 'form_post') {
    const fields = Object.entries(clean)
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`)
      .join('');
    return res.send(
      `<!DOCTYPE html><html><body onload="document.forms[0].submit()"><form method="POST" action="${escapeHtml(redirectUri)}">${fields}<noscript><button>Continue</button></noscript></form></body></html>`
    );
  }
  const url = new URL(redirectUri);
  if (mode === 'fragment') url.hash = new URLSearchParams(clean).toString();
  else for (const [k, v] of Object.entries(clean)) url.searchParams.set(k, v);
  return res.redirect(url.toString());
}

function validateAuthRequest(res, db, p) {
  const targetApp = findApp(db, p.client_id);
  if (!targetApp) {
    authErrorPage(res, '700016', `Application with identifier '${p.client_id}' was not found in the directory '${db.tenantId}'.`);
    return null;
  }
  if (!targetApp.redirectUris.includes(String(p.redirect_uri))) {
    authErrorPage(res, '50011', `The redirect URI '${p.redirect_uri}' does not match the URIs registered for '${targetApp.name}'. Add it in the admin portal.`);
    return null;
  }
  return targetApp;
}

const responseMode = (p) => (['query', 'fragment', 'form_post'].includes(p.response_mode) ? p.response_mode : 'query');

app.get('/:tenantId/oauth2/v2.0/authorize', validateTenant, (req, res) => {
  const db = store.snapshot();
  const p = {
    client_id: '',
    redirect_uri: '',
    response_type: 'code',
    response_mode: 'query',
    state: '',
    scope: 'openid profile',
    code_challenge: '',
    code_challenge_method: '',
    nonce: '',
    prompt: '',
    login_hint: '',
    ...Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)])),
  };

  const targetApp = validateAuthRequest(res, db, p);
  if (!targetApp) return;

  const mode = responseMode(p);
  if (p.response_type !== 'code') {
    return deliverAuthResponse(res, p.redirect_uri, mode, {
      error: 'unsupported_response_type',
      error_description: "AADSTS70011: Only response_type 'code' is supported by this mock.",
      state: p.state,
    });
  }
  if (p.prompt === 'none') {
    return deliverAuthResponse(res, p.redirect_uri, mode, {
      error: 'login_required',
      error_description: 'AADSTS160021: The mock keeps no sign-in session, so silent (prompt=none) requests always require interaction.',
      state: p.state,
    });
  }

  const hint = p.login_hint.toLowerCase();
  const users = targetApp.assignments
    .map((asg) => {
      const user = db.users.find((u) => u.oid === asg.userId);
      return user ? { ...user, roles: asg.roles } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.preferred_username.toLowerCase() === hint) - Number(a.preferred_username.toLowerCase() === hint));

  const rows = users.length
    ? users
        .map(
          (u) => `
      <button type="submit" name="oid" value="${escapeHtml(u.oid)}" class="account-row">
        <div class="avatar">${escapeHtml((u.name[0] || 'U').toUpperCase())}</div>
        <div class="details"><div class="name">${escapeHtml(u.name)}</div><div class="upn">${escapeHtml(u.preferred_username)}</div></div>
        <span class="role-tag">${escapeHtml(u.roles.join(', ') || 'No role')}</span>
      </button>`
        )
        .join('')
    : `<div class="warn">No users are assigned to <strong>${escapeHtml(targetApp.name)}</strong>.<br/>Assign users in the <a href="${escapeHtml(PUBLIC_URL)}/" target="_blank">admin portal</a>, then reload this page.</div>`;

  const hidden = Object.entries(p)
    .filter(([k]) => !['login_hint', 'prompt'].includes(k))
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`)
    .join('');

  res.send(
    pageShell(
      `Sign in - ${targetApp.name}`,
      `<h1>Pick an account</h1>
    <div class="meta">
      <div><strong>Application:</strong> ${escapeHtml(targetApp.name)}</div>
      <div><strong>Client ID:</strong> ${escapeHtml(targetApp.clientId)}</div>
      <div><strong>Tenant ID:</strong> ${escapeHtml(req.resolvedTenantId)}</div>
      <div><strong>Token lifetime:</strong> ${targetApp.tokenLifetimeSeconds}s</div>
    </div>
    <form method="POST" action="${escapeHtml(`${PUBLIC_URL}/${req.resolvedTenantId}/oauth2/v2.0/login-submit`)}">
      ${hidden}
      ${rows}
      <div class="footer"><button type="submit" name="cancel" value="1" class="link">Cancel</button><a href="${escapeHtml(PUBLIC_URL)}/" target="_blank">Manage apps, users &amp; roles</a></div>
    </form>`
    )
  );
});

app.post('/:tenantId/oauth2/v2.0/login-submit', validateTenant, (req, res) => {
  const db = store.snapshot();
  const p = Object.fromEntries(Object.entries(req.body).map(([k, v]) => [k, String(v)]));
  const targetApp = validateAuthRequest(res, db, p);
  if (!targetApp) return;
  const mode = responseMode(p);

  if (p.cancel) {
    return deliverAuthResponse(res, p.redirect_uri, mode, {
      error: 'access_denied',
      error_description: 'AADSTS65004: The user declined to consent to access the app.',
      state: p.state,
    });
  }

  const assignment = targetApp.assignments.find((a) => a.userId === p.oid);
  const user = db.users.find((u) => u.oid === p.oid);
  if (!user || !assignment) {
    return deliverAuthResponse(res, p.redirect_uri, mode, {
      error: 'access_denied',
      error_description: 'AADSTS50105: The signed in user is not assigned to a role for the application.',
      state: p.state,
    });
  }

  store.purgeExpired();
  const code = crypto.randomBytes(32).toString('base64url');
  store.putCode(code, {
    clientId: targetApp.clientId,
    userId: user.oid,
    redirectUri: p.redirect_uri,
    scope: p.scope || 'openid profile',
    nonce: p.nonce,
    codeChallenge: p.code_challenge,
    codeChallengeMethod: p.code_challenge_method || 'plain',
    expiresAt: nowSec() + CODE_TTL,
  });
  return deliverAuthResponse(res, p.redirect_uri, mode, { code, state: p.state });
});

// --- /token ---
function readClientAuth(req) {
  let clientId = req.body.client_id;
  let clientSecret = req.body.client_secret;
  const header = req.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    if (idx !== -1) {
      clientId = clientId || decodeURIComponent(decoded.slice(0, idx));
      clientSecret = clientSecret || decodeURIComponent(decoded.slice(idx + 1));
    }
  }
  return { clientId: clientId && String(clientId), clientSecret: clientSecret && String(clientSecret) };
}

function pkceOk(entry, verifier) {
  if (!entry.codeChallenge) return true;
  if (!verifier) return false;
  const computed = entry.codeChallengeMethod === 'S256' ? crypto.createHash('sha256').update(verifier).digest('base64url') : verifier;
  return safeEqual(computed, entry.codeChallenge);
}

function handleClientCredentials(db, req, res, { clientId, clientSecret }) {
  if (!clientId || !clientSecret) {
    return oauthError(res, 401, 'invalid_client', '7000216', "'client_secret' is required for the client_credentials grant.");
  }
  const sp = db.serviceAccounts.find((s) => sameId(s.clientId, clientId));
  const registered = sp ? null : findApp(db, clientId);
  const principal = sp || registered;
  if (!principal) {
    return oauthError(res, 401, 'invalid_client', '700016', `Application with identifier '${clientId}' was not found in the directory '${db.tenantId}'.`);
  }
  if (!secretMatches(principal.secrets, clientSecret)) {
    return oauthError(res, 401, 'invalid_client', '7000215', 'Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID.');
  }

  const scope = parseScope(req.body.scope);
  if (scope.raw && !scope.raw.endsWith('/.default')) {
    return oauthError(res, 400, 'invalid_scope', '1002012', `The provided value for scope '${scope.raw}' is not valid. Client credential flows must have a scope value with /.default suffixed to the resource identifier (application ID URI).`);
  }
  const requested = scope.resourceId ? findApp(db, scope.resourceId) : null;
  if (scope.resourceId && !requested) {
    return oauthError(res, 400, 'invalid_resource', '500011', `The resource principal named '${scope.raw.replace(/\/\.default$/, '')}' was not found in the tenant. Register it as an app first.`);
  }

  if (sp) {
    const target = findApp(db, sp.targetAppClientId);
    if (!target) {
      return oauthError(res, 400, 'invalid_resource', '500011', `Service account '${sp.name}' has no target app. Pick one in the admin portal.`);
    }
    if (requested && requested.clientId !== target.clientId) {
      return oauthError(res, 400, 'invalid_resource', '500011', `Service account '${sp.name}' is granted roles on '${target.name}' (${target.clientId}), not on '${requested.name}'. Request scope api://${target.clientId}/.default.`);
    }
    return res.json({
      token_type: 'Bearer',
      expires_in: target.tokenLifetimeSeconds,
      ext_expires_in: target.tokenLifetimeSeconds,
      access_token: appToken(db, { principalClientId: sp.clientId, oid: spObjectId(sp), name: sp.name, audienceApp: target, roles: effectiveRoles(target, sp.roles) }),
    });
  }

  // An app registration using its own secret: it holds no app-role grants, so the token carries no roles.
  const audienceApp = requested || registered;
  return res.json({
    token_type: 'Bearer',
    expires_in: audienceApp.tokenLifetimeSeconds,
    ext_expires_in: audienceApp.tokenLifetimeSeconds,
    access_token: appToken(db, { principalClientId: registered.clientId, oid: registered.clientId, name: registered.name, audienceApp, roles: [] }),
  });
}

function handleAuthorizationCode(db, req, res, { clientId, clientSecret }) {
  const targetApp = findApp(db, clientId);
  if (!targetApp) return oauthError(res, 400, 'unauthorized_client', '700016', `Application with identifier '${clientId}' was not found in the directory '${db.tenantId}'.`);
  if (clientSecret && !secretMatches(targetApp.secrets, clientSecret)) {
    return oauthError(res, 401, 'invalid_client', '7000215', 'Invalid client secret provided.');
  }

  store.purgeExpired();
  const entry = store.takeCode(req.body.code); // single use, even when validation below fails
  if (!entry) return oauthError(res, 400, 'invalid_grant', '54003', 'The authorization code is invalid, expired, or has already been redeemed.');
  if (!sameId(entry.clientId, targetApp.clientId)) return oauthError(res, 400, 'invalid_grant', '54000', 'The authorization code was issued to a different application.');
  if (req.body.redirect_uri && req.body.redirect_uri !== entry.redirectUri) {
    return oauthError(res, 400, 'invalid_grant', '50011', 'The redirect_uri does not match the one used to obtain the authorization code.');
  }
  if (!pkceOk(entry, req.body.code_verifier)) {
    return oauthError(res, 400, 'invalid_grant', '501481', 'The Code_Verifier does not match the code_challenge supplied in the authorization request.');
  }

  const user = db.users.find((u) => u.oid === entry.userId);
  const assignment = targetApp.assignments.find((a) => a.userId === entry.userId);
  if (!user || !assignment) return oauthError(res, 400, 'invalid_grant', '50105', 'The signed in user is no longer assigned to this application.');

  const tokens = userTokens(db, {
    app: targetApp,
    user,
    roles: effectiveRoles(targetApp, assignment.roles),
    scope: entry.scope,
    nonce: entry.nonce,
    usedSecret: Boolean(clientSecret),
  });
  if (entry.scope.split(/\s+/).includes('offline_access')) {
    const refresh = crypto.randomBytes(32).toString('base64url');
    store.putRefresh(refresh, { clientId: targetApp.clientId, userId: user.oid, scope: entry.scope, expiresAt: nowSec() + REFRESH_TTL });
    tokens.refresh_token = refresh;
  }
  return res.json(tokens);
}

function handleRefresh(db, req, res, { clientId, clientSecret }) {
  const targetApp = findApp(db, clientId);
  if (!targetApp) return oauthError(res, 400, 'unauthorized_client', '700016', `Application with identifier '${clientId}' was not found in the directory '${db.tenantId}'.`);
  if (clientSecret && !secretMatches(targetApp.secrets, clientSecret)) {
    return oauthError(res, 401, 'invalid_client', '7000215', 'Invalid client secret provided.');
  }
  store.purgeExpired();
  const entry = store.takeRefresh(req.body.refresh_token); // rotated: the old token is consumed
  if (!entry || !sameId(entry.clientId, targetApp.clientId)) {
    return oauthError(res, 400, 'invalid_grant', '70008', 'The provided refresh token is invalid, expired, or was issued to a different application.');
  }
  const user = db.users.find((u) => u.oid === entry.userId);
  const assignment = targetApp.assignments.find((a) => a.userId === entry.userId);
  if (!user || !assignment) return oauthError(res, 400, 'invalid_grant', '50105', 'The user is no longer assigned to this application.');

  // Roles and lifetime are read fresh, so edits in the portal show up on the next refresh
  const tokens = userTokens(db, { app: targetApp, user, roles: effectiveRoles(targetApp, assignment.roles), scope: entry.scope, usedSecret: Boolean(clientSecret) });
  const next = crypto.randomBytes(32).toString('base64url');
  store.putRefresh(next, { clientId: targetApp.clientId, userId: user.oid, scope: entry.scope, expiresAt: nowSec() + REFRESH_TTL });
  tokens.refresh_token = next;
  return res.json(tokens);
}

app.post('/:tenantId/oauth2/v2.0/token', validateTenant, (req, res) => {
  const db = store.snapshot();
  const auth = readClientAuth(req);
  switch (req.body.grant_type) {
    case 'client_credentials':
      return handleClientCredentials(db, req, res, auth);
    case 'authorization_code':
      return handleAuthorizationCode(db, req, res, auth);
    case 'refresh_token':
      return handleRefresh(db, req, res, auth);
    default:
      return oauthError(res, 400, 'unsupported_grant_type', '70003', `The app requested an unsupported grant type '${req.body.grant_type ?? ''}'. Supported: authorization_code, client_credentials, refresh_token.`);
  }
});

// ---------------------------------------------------------------------------
// HTML shell for the mock sign-in pages
// ---------------------------------------------------------------------------
function pageShell(title, body) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #f2f2f2; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; margin: 0; padding: 48px 16px; box-sizing: border-box; color: #1b1b1b; }
  .box { background: #fff; width: 440px; max-width: 100%; padding: 36px; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 600; color: #5e5e5e; margin-bottom: 18px; font-size: 14px; }
  .squares { display: grid; grid-template-columns: 9px 9px; gap: 2px; }
  .squares span { height: 9px; }
  .squares span:nth-child(1) { background: #f25022; } .squares span:nth-child(2) { background: #7fba00; }
  .squares span:nth-child(3) { background: #00a4ef; } .squares span:nth-child(4) { background: #ffb900; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 10px; }
  .meta { font-size: 12px; color: #616161; margin-bottom: 18px; line-height: 1.5; background: #f8f8f8; padding: 8px 10px; border-left: 3px solid #0067b8; word-break: break-all; }
  .account-row { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px; background: #fff; border: none; border-bottom: 1px solid #e5e5e5; cursor: pointer; text-align: left; font: inherit; }
  .account-row:hover, .account-row:focus-visible { background: #f3f2f1; outline: none; }
  .avatar { width: 36px; height: 36px; border-radius: 50%; background: #0067b8; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 600; flex-shrink: 0; }
  .details { flex: 1; min-width: 0; } .name { font-size: 14px; font-weight: 600; }
  .upn { font-size: 12px; color: #616161; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .role-tag { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 3px; background: #e1dfdd; color: #323130; }
  .warn { background: #fff4ce; color: #795e00; padding: 14px; font-size: 13px; line-height: 1.5; }
  .footer { margin-top: 16px; font-size: 12px; display: flex; justify-content: space-between; align-items: center; }
  .footer a, .footer .link { color: #0067b8; text-decoration: none; background: none; border: none; padding: 0; font: inherit; cursor: pointer; }
</style></head>
<body><div class="box">
  <div class="brand"><div class="squares"><span></span><span></span><span></span><span></span></div><span>Microsoft Entra ID (Mock)</span></div>
  ${body}
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Errors + startup
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  console.error(err);
  res.status(500).json({ error: err?.message || 'Internal error' });
});

const server = app.listen(PORT, () => {
  const db = store.snapshot();
  console.log('==========================================================');
  console.log(`Mock Entra ID Admin Portal : ${PUBLIC_URL}/`);
  console.log(`Database                   : ${store.file}`);
  console.log(`Tenant ID                  : ${db.tenantId}`);
  console.log(`Authority                  : ${PUBLIC_URL}/${db.tenantId}`);
  console.log(`Discovery                  : ${PUBLIC_URL}/${db.tenantId}/v2.0/.well-known/openid-configuration`);
  console.log(`Token endpoint             : ${PUBLIC_URL}/${db.tenantId}/oauth2/v2.0/token`);
  console.log('==========================================================');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
