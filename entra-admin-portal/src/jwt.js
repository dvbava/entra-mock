function b64urlToJson(part) {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function decodeJwt(token) {
  const [h, p] = token.split('.');
  return { header: b64urlToJson(h), payload: b64urlToJson(p) };
}

/** 30 -> "30s", 90 -> "1m 30s", 3600 -> "1h 0m" */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function resultFromToken(token, extra = {}) {
  return { ok: true, status: 200, token, ...decodeJwt(token), at: Date.now(), ...extra };
}

/** Real client_credentials request against the mock; resolves to a result object for <TokenResult />. */
export async function requestClientCredentials(info, account, secret, scope) {
  try {
    const res = await fetch(info.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: account.clientId, client_secret: secret, scope }),
    });
    const body = await res.json();
    if (res.ok && body.access_token) return resultFromToken(body.access_token, { expiresIn: body.expires_in });
    return { ok: false, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: 'network_error', error_description: e.message } };
  }
}
