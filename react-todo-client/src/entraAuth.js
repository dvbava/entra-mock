import { getMsalConfig } from './authConfig.js';

async function getDiscoveryMetadata() {
  const cfg = getMsalConfig();
  const discoveryUrl = `${cfg.auth.authority}/v2.0/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl);
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error_description || `Failed to load OIDC discovery from ${discoveryUrl}`);
  }
  return res.json();
}

function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generatePKCE() {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(randomBytes);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(hash);
  return { verifier, challenge };
}

export async function loginRedirect() {
  const cfg = getMsalConfig();
  const metadata = await getDiscoveryMetadata();
  const { verifier, challenge } = await generatePKCE();
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));

  sessionStorage.setItem('msal.pkce.verifier', verifier);
  sessionStorage.setItem('msal.oauth.state', state);

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set('client_id', cfg.auth.clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', cfg.auth.redirectUri);
  authUrl.searchParams.set('scope', `openid profile email api://${cfg.auth.clientId}/Tasks.Access`);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  window.location.assign(authUrl.toString());
}

export async function handleRedirectPromise(searchParams) {
  const error = searchParams.get('error');
  if (error) throw new Error(searchParams.get('error_description') || error);

  const code = searchParams.get('code');
  const returnedState = searchParams.get('state');
  const savedState = sessionStorage.getItem('msal.oauth.state');
  const verifier = sessionStorage.getItem('msal.pkce.verifier');

  if (!code) throw new Error('Authorization code missing in callback.');
  if (returnedState !== savedState) throw new Error('State validation failed.');

  const cfg = getMsalConfig();
  const metadata = await getDiscoveryMetadata();
  const tokenRes = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.auth.clientId,
      code,
      redirect_uri: cfg.auth.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier || '',
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.json().catch(() => ({}));
    throw new Error(err.error_description || `Token exchange failed (${tokenRes.status})`);
  }

  const tokens = await tokenRes.json();
  sessionStorage.removeItem('msal.pkce.verifier');
  sessionStorage.removeItem('msal.oauth.state');
  return tokens;
}

export async function logoutRedirect() {
  localStorage.removeItem('entra_tokens');
  const cfg = getMsalConfig();
  const metadata = await getDiscoveryMetadata().catch(() => null);
  if (metadata?.end_session_endpoint) {
    const logoutUrl = new URL(metadata.end_session_endpoint);
    logoutUrl.searchParams.set('post_logout_redirect_uri', cfg.auth.postLogoutRedirectUri);
    window.location.assign(logoutUrl.toString());
  } else {
    window.location.assign(cfg.auth.postLogoutRedirectUri);
  }
}

export function parseEntraToken(jwt) {
  if (!jwt) return null;
  try {
    const cfg = getMsalConfig();
    const [, payload] = jwt.split('.');
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(base64));

    if (claims.tid && claims.tid !== cfg.auth.tenantId) return null;
    if (claims.aud && claims.aud !== cfg.auth.clientId) return null;
    return claims;
  } catch {
    return null;
  }
}
