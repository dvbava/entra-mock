import { useEffect, useRef, useState } from 'react';

export function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  return Promise.resolve();
}

export function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={async () => {
        await copyText(text);
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

/** Two-step delete: first click arms the button, second click confirms. */
export function ConfirmButton({ children, confirmLabel = 'Confirm delete', onConfirm, small = true }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={`btn btn-danger ${small ? 'btn-sm' : ''} ${armed ? 'armed' : ''}`}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          timer.current = setTimeout(() => setArmed(false), 3500);
          return;
        }
        clearTimeout(timer.current);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}

export function IdValue({ value }) {
  return (
    <span className="id-value">
      <code>{value}</code>
      <CopyButton text={value} />
    </span>
  );
}

export function SecretValue({ secret }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="id-value">
      <code className="secret">{shown ? secret : `${secret.slice(0, 6)}${'•'.repeat(14)}`}</code>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShown((v) => !v)}>
        {shown ? 'Hide' : 'Show'}
      </button>
      <CopyButton text={secret} />
    </span>
  );
}

export function RoleToggles({ roles, selected, onChange, disabled }) {
  if (!roles.length) return <span className="muted">This app has no roles yet.</span>;
  const toggle = (role) => {
    const next = new Set(selected);
    next.has(role) ? next.delete(role) : next.add(role);
    onChange(roles.filter((r) => next.has(r)));
  };
  return (
    <span className="chips">
      {roles.map((r) => (
        <button key={r} type="button" disabled={disabled} className="chip toggle" aria-pressed={selected.includes(r)} onClick={() => toggle(r)}>
          {r}
        </button>
      ))}
    </span>
  );
}

export function Field({ label, children, grow }) {
  return (
    <label className={`field ${grow ? 'grow' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function shortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
