import { useState } from 'react';
import { formatDuration } from './jwt.js';

const PRESETS = [
  { label: '10 s', seconds: 10 },
  { label: '30 s', seconds: 30 },
  { label: '1 min', seconds: 60 },
  { label: '5 min', seconds: 300 },
  { label: '1 hour', seconds: 3600 },
  { label: '24 hours', seconds: 86400 },
];

/** Per-app access/ID token lifetime, for exercising expiry and refresh handling. */
export default function LifetimeEditor({ app, info, call }) {
  const { min, max, default: dflt } = info.tokenLifetime;
  const [value, setValue] = useState(String(app.tokenLifetimeSeconds));
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= min && n <= max;
  const dirty = valid && n !== app.tokenLifetimeSeconds;

  return (
    <div className="panel">
      <h3>Token lifetime</h3>
      <p className="muted">
        How long access and ID tokens issued for this app stay valid, including tokens for service accounts that target it.
        Tokens already issued keep their original expiry. Many JWT libraries tolerate a few minutes of clock skew, so very short
        lifetimes may not look expired right away.
      </p>
      <form
        className="form-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) call('PUT', `/apps/${encodeURIComponent(app.clientId)}`, { tokenLifetimeSeconds: n });
        }}
      >
        <label className="field">
          <span>Seconds ({min} to {max})</span>
          <input type="number" min={min} max={max} step="1" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!valid} />
        </label>
        <span className="chips" role="group" aria-label="Presets">
          {PRESETS.map((p) => (
            <button key={p.seconds} type="button" className="chip toggle" aria-pressed={n === p.seconds} onClick={() => setValue(String(p.seconds))}>
              {p.label}
            </button>
          ))}
        </span>
        <button className="btn btn-primary" type="submit" disabled={!dirty}>Save lifetime</button>
      </form>
      <p className="muted small">
        {valid ? `Tokens will last ${formatDuration(n)}.` : `Enter a whole number between ${min} and ${max}.`}
        {app.tokenLifetimeSeconds !== dflt && ` Saved value differs from the default of ${formatDuration(dflt)}.`}
      </p>
    </div>
  );
}
