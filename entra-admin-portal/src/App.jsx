import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './api.js';
import { ConfirmButton, CopyButton } from './ui.jsx';
import AppsTab from './AppsTab.jsx';
import UsersTab from './UsersTab.jsx';
import RolesTab from './RolesTab.jsx';
import ServiceAccountsTab from './ServiceAccountsTab.jsx';

const TABS = [
  { id: 'apps', label: 'App registrations', count: (s) => s.apps.length },
  { id: 'users', label: 'Users', count: (s) => s.users.length },
  { id: 'roles', label: 'App roles', count: (s) => s.apps.reduce((n, a) => n + a.roles.length, 0) },
  { id: 'sp', label: 'Service accounts', count: (s) => s.serviceAccounts.length },
];

export default function App() {
  const [state, setState] = useState(null);
  const [info, setInfo] = useState(null);
  const [tab, setTab] = useState(() => localStorage.getItem('portal.tab') || 'apps');
  const [selection, setSelection] = useState({ apps: null, roles: null, sp: null });
  const [toast, setToast] = useState(null);
  const [loadError, setLoadError] = useState('');
  const toastTimer = useRef();

  const notify = useCallback((message, kind = 'error') => {
    clearTimeout(toastTimer.current);
    setToast({ message, kind });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  useEffect(() => {
    Promise.all([request('GET', '/api/admin/state'), request('GET', '/api/admin/info')])
      .then(([s, i]) => {
        setState(s);
        setInfo(i);
      })
      .catch((e) => setLoadError(e.message));
  }, []);

  /** Run a mutating admin call. Resolves to the new state, or null if the server refused. */
  const call = useCallback(
    async (method, url, body) => {
      try {
        const next = await request(method, `/api/admin${url}`, body);
        setState(next);
        return next;
      } catch (e) {
        notify(e.message);
        return null;
      }
    },
    [notify]
  );

  const switchTab = (id) => {
    setTab(id);
    localStorage.setItem('portal.tab', id);
  };
  const select = (key) => (id) => setSelection((s) => ({ ...s, [key]: id }));
  const navigate = (id, appId) => {
    if (appId) setSelection((s) => ({ ...s, apps: appId, roles: appId }));
    switchTab(id);
  };

  if (loadError) {
    return (
      <div className="boot">
        <h1>Can't reach the Entra server</h1>
        <p>{loadError}</p>
        <p className="muted">Start it with <code>npm start</code> in <code>mock-entra-server</code> (port 8080), then reload.</p>
      </div>
    );
  }
  if (!state || !info) return <div className="boot muted">Loading directory…</div>;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo" aria-hidden="true"><i /><i /><i /><i /></span>
          <span>
            Mock Entra
            <small>Admin center</small>
          </span>
        </div>
        <nav aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} className="nav-item" aria-current={tab === t.id ? 'page' : undefined} onClick={() => switchTab(t.id)}>
              <span>{t.label}</span>
              <span className="count">{t.count(state)}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <a href={info.discoveryUrl} target="_blank" rel="noreferrer">OIDC discovery document</a>
          <a href={info.jwksUrl} target="_blank" rel="noreferrer">Signing keys (JWKS)</a>
          <span className="muted small" title={info.databaseFile}>SQLite: {info.databaseFile.split(/[\\/]/).pop()}</span>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="tenant">
            <span className="muted">Tenant</span>
            <code>{state.tenantId}</code>
            <CopyButton text={state.tenantId} />
          </div>
          <div className="tenant">
            <span className="muted">Authority</span>
            <code>{info.authority}</code>
            <CopyButton text={info.authority} />
          </div>
          <div className="topbar-actions">
            <ConfirmButton
              small
              confirmLabel="Sign everyone out?"
              onConfirm={() =>
                request('DELETE', '/api/admin/sessions')
                  .then(({ cleared }) => notify(cleared ? `Ended ${cleared} SSO ${cleared === 1 ? 'session' : 'sessions'}. Silent sign-in now returns login_required.` : 'No browser was signed in.', 'ok'))
                  .catch((e) => notify(e.message))
              }
            >
              End SSO sessions
            </ConfirmButton>
            <ConfirmButton small confirmLabel="Reset everything?" onConfirm={() => call('POST', '/reset').then((s) => s && notify('Demo data restored', 'ok'))}>
              Reset demo data
            </ConfirmButton>
          </div>
        </header>

        <main className="content">
          {tab === 'apps' && <AppsTab state={state} info={info} call={call} selectedId={selection.apps} onSelect={select('apps')} onNavigate={navigate} />}
          {tab === 'users' && <UsersTab state={state} call={call} />}
          {tab === 'roles' && <RolesTab state={state} info={info} call={call} notify={notify} selectedId={selection.roles} onSelect={select('roles')} />}
          {tab === 'sp' && <ServiceAccountsTab state={state} info={info} call={call} selectedId={selection.sp} onSelect={select('sp')} onNavigate={navigate} />}
        </main>
      </div>

      {toast && (
        <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
          {toast.message}
        </div>
      )}
    </div>
  );
}
