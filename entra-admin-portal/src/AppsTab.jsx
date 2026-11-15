import { useState } from 'react';
import { ConfirmButton, Empty, Field, IdValue, RoleToggles, SecretValue, shortDate } from './ui.jsx';
import LifetimeEditor from './LifetimeEditor.jsx';

export default function AppsTab({ state, info, call, selectedId, onSelect, onNavigate }) {
  const [creating, setCreating] = useState(false);
  const current = creating ? null : state.apps.find((a) => a.clientId === selectedId) ?? state.apps[0] ?? null;

  return (
    <div className="split">
      <section className="list-pane" aria-label="App registrations">
        <button className="btn btn-primary full" onClick={() => setCreating(true)}>
          Register an app
        </button>
        <ul className="pick-list">
          {state.apps.map((a) => (
            <li key={a.clientId}>
              <button className="pick" aria-current={current?.clientId === a.clientId} onClick={() => { setCreating(false); onSelect(a.clientId); }}>
                <strong>{a.name}</strong>
                <span className="muted mono">{a.clientId.slice(0, 8)}…</span>
                <span className="muted">{a.assignments.length} {a.assignments.length === 1 ? 'user' : 'users'}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="detail-pane">
        {creating ? (
          <RegisterApp
            info={info}
            call={call}
            onCancel={() => setCreating(false)}
            onCreated={(id) => { setCreating(false); onSelect(id); }}
            previous={state}
          />
        ) : current ? (
          <AppDetail key={current.clientId} app={current} state={state} info={info} call={call} onNavigate={onNavigate} />
        ) : (
          <Empty title="No apps registered yet">Register an app to get a client ID, secrets and a sign-in page for its users.</Empty>
        )}
      </section>
    </div>
  );
}

function RegisterApp({ info, call, previous, onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [uris, setUris] = useState('http://localhost:5173/callback');
  const [roles, setRoles] = useState('');
  const [lifetime, setLifetime] = useState(String(info.tokenLifetime.default));
  const submit = async (e) => {
    e.preventDefault();
    const next = await call('POST', '/apps', { name, redirectUris: uris, roles, tokenLifetimeSeconds: lifetime });
    if (!next) return;
    const created = next.apps.find((a) => !previous.apps.some((p) => p.clientId === a.clientId));
    onCreated(created?.clientId);
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h2>Register an application</h2>
      <p className="muted">You get a client ID and an initial client secret. Users and roles are assigned afterwards.</p>
      <div className="form-row">
        <Field label="Name" grow>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Billing portal" autoFocus required />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Redirect URIs (comma separated)" grow>
          <input value={uris} onChange={(e) => setUris(e.target.value)} placeholder="http://localhost:3000/callback" />
        </Field>
      </div>
      <div className="form-row">
        <Field label="App roles (optional, comma separated)" grow>
          <input value={roles} onChange={(e) => setRoles(e.target.value)} placeholder="Reader, Writer, Approver" />
        </Field>
        <Field label="Token lifetime (seconds)">
          <input type="number" min={info.tokenLifetime.min} max={info.tokenLifetime.max} value={lifetime} onChange={(e) => setLifetime(e.target.value)} />
        </Field>
      </div>
      <div className="form-row">
        <button className="btn btn-primary" type="submit" disabled={!name.trim()}>Register</button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function AppDetail({ app, state, info, call, onNavigate }) {
  const base = `/apps/${encodeURIComponent(app.clientId)}`;
  const [name, setName] = useState(app.name);
  const [uri, setUri] = useState('');
  const [secretDesc, setSecretDesc] = useState('');
  const [newUser, setNewUser] = useState('');
  const [newRoles, setNewRoles] = useState([]);

  const assignedIds = new Set(app.assignments.map((a) => a.userId));
  const unassigned = state.users.filter((u) => !assignedIds.has(u.oid));
  const userToAdd = unassigned.some((u) => u.oid === newUser) ? newUser : unassigned[0]?.oid ?? '';

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== app.name) call('PUT', base, { name });
            }}
          >
            <input className="title-input" aria-label="Application name" value={name} onChange={(e) => setName(e.target.value)} />
            {name.trim() !== app.name && name.trim() && <button className="btn btn-sm" type="submit">Save name</button>}
          </form>
          <ConfirmButton onConfirm={() => call('DELETE', base)}>Delete app</ConfirmButton>
        </div>
        <dl className="kv">
          <dt>Client ID</dt>
          <dd><IdValue value={app.clientId} /></dd>
          <dt>Authority</dt>
          <dd><IdValue value={info.authority} /></dd>
          <dt>Discovery</dt>
          <dd><IdValue value={info.discoveryUrl} /></dd>
        </dl>
      </div>

      <div className="panel">
        <h3>Redirect URIs</h3>
        {app.redirectUris.length === 0 && <p className="muted">None. Sign-in requests for this app will be rejected until you add one.</p>}
        <ul className="uri-list">
          {app.redirectUris.map((u) => (
            <li key={u}>
              <code>{u}</code>
              <button className="btn btn-ghost btn-sm" onClick={() => call('DELETE', `${base}/redirects`, { redirectUri: u })} aria-label={`Remove ${u}`}>Remove</button>
            </li>
          ))}
        </ul>
        <form
          className="form-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await call('POST', `${base}/redirects`, { redirectUri: uri })) setUri('');
          }}
        >
          <input value={uri} onChange={(e) => setUri(e.target.value)} placeholder="http://localhost:3000/callback" aria-label="New redirect URI" />
          <button className="btn" type="submit" disabled={!uri.trim()}>Add URI</button>
        </form>
      </div>

      <div className="panel">
        <h3>Users and roles</h3>
        <p className="muted">Only assigned users appear on this app's sign-in page. Their roles are issued in the <code>roles</code> claim.</p>
        {app.roles.length === 0 && (
          <p className="warn-text">
            This app has no roles yet.{' '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate('roles', app.clientId)}>Define roles</button>
          </p>
        )}
        {app.assignments.length > 0 && (
          <table>
            <thead><tr><th>User</th><th>Roles</th><th /></tr></thead>
            <tbody>
              {app.assignments.map((asg) => {
                const user = state.users.find((u) => u.oid === asg.userId);
                if (!user) return null;
                return (
                  <tr key={asg.userId}>
                    <td><strong>{user.name}</strong><div className="muted">{user.preferred_username}</div></td>
                    <td>
                      <RoleToggles roles={app.roles} selected={asg.roles} onChange={(roles) => call('POST', `${base}/assignments`, { userId: asg.userId, roles })} />
                    </td>
                    <td className="right"><button className="btn btn-sm" onClick={() => call('DELETE', `${base}/assignments/${encodeURIComponent(asg.userId)}`)}>Remove</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {unassigned.length > 0 ? (
          <form
            className="assign-row"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await call('POST', `${base}/assignments`, { userId: userToAdd, roles: newRoles })) setNewRoles([]);
            }}
          >
            <Field label="Add a user">
              <select value={userToAdd} onChange={(e) => setNewUser(e.target.value)}>
                {unassigned.map((u) => <option key={u.oid} value={u.oid}>{u.name} ({u.preferred_username})</option>)}
              </select>
            </Field>
            <div className="field">
              <span>With roles</span>
              <RoleToggles roles={app.roles} selected={newRoles} onChange={setNewRoles} />
            </div>
            <button className="btn btn-primary" type="submit">Assign user</button>
          </form>
        ) : (
          <p className="muted">{state.users.length === 0 ? 'Create users in the Users tab first.' : 'Every user in the directory is assigned to this app.'}</p>
        )}
      </div>

      <LifetimeEditor key={`${app.clientId}-${app.tokenLifetimeSeconds}`} app={app} info={info} call={call} />

      <div className="panel">
        <h3>Client secrets</h3>
        <table>
          <thead><tr><th>Description</th><th>Value</th><th>Created</th><th /></tr></thead>
          <tbody>
            {app.secrets.map((s) => (
              <tr key={s.id}>
                <td>{s.description}</td>
                <td><SecretValue secret={s.secret} /></td>
                <td className="muted">{shortDate(s.createdAt)}</td>
                <td className="right"><ConfirmButton confirmLabel="Confirm revoke" onConfirm={() => call('DELETE', `${base}/secrets/${encodeURIComponent(s.id)}`)}>Revoke</ConfirmButton></td>
              </tr>
            ))}
            {app.secrets.length === 0 && <tr><td colSpan="4" className="muted">No client secrets.</td></tr>}
          </tbody>
        </table>
        <form
          className="form-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await call('POST', `${base}/secrets`, { description: secretDesc })) setSecretDesc('');
          }}
        >
          <input value={secretDesc} onChange={(e) => setSecretDesc(e.target.value)} placeholder="Description (optional)" aria-label="Secret description" />
          <button className="btn" type="submit">New client secret</button>
        </form>
      </div>
    </div>
  );
}
