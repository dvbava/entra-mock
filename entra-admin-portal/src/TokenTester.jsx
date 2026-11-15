import { useEffect, useState } from 'react';
import { CopyButton, Field } from './ui.jsx';
import { requestClientCredentials } from './jwt.js';
import TokenResult from './TokenResult.jsx';

/** Requests a real client_credentials token from the mock server and decodes it. */
export default function TokenTester({ account, targetApp, info }) {
  const [secretId, setSecretId] = useState('');
  const [scope, setScope] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const defaultScope = targetApp ? `api://${targetApp.clientId}/.default` : '';
  useEffect(() => setScope(defaultScope), [defaultScope]);
  useEffect(() => setResult(null), [account.id]);

  const secret = account.secrets.find((s) => s.id === secretId) ?? account.secrets[0];
  if (!secret) return <p className="muted">Generate a secret first, then you can request a token with it.</p>;

  const curl = [
    `curl -X POST '${info.tokenUrl}' \\`,
    `  -H 'Content-Type: application/x-www-form-urlencoded' \\`,
    `  -d 'grant_type=client_credentials' \\`,
    `  -d 'client_id=${account.clientId}' \\`,
    `  -d 'client_secret=${secret.secret}' \\`,
    `  -d 'scope=${scope}'`,
  ].join('\n');

  const request = async () => {
    setBusy(true);
    setResult(await requestClientCredentials(info, account, secret.secret, scope));
    setBusy(false);
  };

  return (
    <div className="stack tight">
      <div className="form-row">
        <Field label="Secret">
          <select value={secret.id} onChange={(e) => setSecretId(e.target.value)}>
            {account.secrets.map((s) => <option key={s.id} value={s.id}>{s.description}</option>)}
          </select>
        </Field>
        <Field label="Scope" grow>
          <input className="mono" value={scope} onChange={(e) => setScope(e.target.value)} />
        </Field>
        <button className="btn btn-primary" onClick={request} disabled={busy}>{busy ? 'Requesting…' : 'Request token'}</button>
      </div>
      <TokenResult result={result} />
      <details>
        <summary>curl equivalent</summary>
        <pre className="code">{curl}</pre>
        <CopyButton text={curl} label="Copy curl" />
      </details>
    </div>
  );
}
