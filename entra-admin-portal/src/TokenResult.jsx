import { useEffect, useState } from 'react';
import { CopyButton } from './ui.jsx';
import { formatDuration } from './jwt.js';

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Decoded view of a token (or the error response) with a live expiry countdown. */
export default function TokenResult({ result }) {
  const now = useNow();
  if (!result) return null;

  if (!result.ok) {
    return (
      <div className="token-result">
        <div className="token-summary"><span className="status fail">{result.status || 'Error'}</span><span>{result.body.error}</span></div>
        <pre className="code">{JSON.stringify(result.body, null, 2)}</pre>
      </div>
    );
  }

  const { payload } = result;
  const remaining = payload.exp - now / 1000;
  const expired = remaining <= 0;

  return (
    <div className="token-result">
      <div className="token-summary">
        <span className="status ok">200 OK</span>
        <span>aud <code>{payload.aud}</code></span>
        <span>lifetime <strong>{formatDuration(payload.exp - payload.iat)}</strong></span>
        <span className={expired ? 'expiry expired' : 'expiry'} aria-live="off">
          {expired ? `expired ${formatDuration(-remaining)} ago` : `expires in ${formatDuration(remaining)}`}
        </span>
      </div>
      <div className="token-roles">
        <span className="muted">roles</span>
        {payload.roles?.length ? (
          <span className="chips">{payload.roles.map((r) => <span key={r} className="chip">{r}</span>)}</span>
        ) : (
          <span className="muted">none. The roles claim is omitted when empty, like Entra.</span>
        )}
      </div>
      <pre className="code">{JSON.stringify(payload, null, 2)}</pre>
      <div className="token-raw">
        <code>{result.token.slice(0, 64)}…</code>
        <CopyButton text={result.token} label="Copy access token" />
      </div>
    </div>
  );
}
