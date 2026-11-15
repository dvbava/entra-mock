import { useState } from 'react';
import { request } from './api.js';
import { ConfirmButton, Empty, Field } from './ui.jsx';
import { requestClientCredentials, resultFromToken } from './jwt.js';
import TokenResult from './TokenResult.jsx';

/**
 * Per-app role workspace: define the app's roles, then map them to users and service accounts.
 * Every checkbox change is saved immediately and is reflected in the next token issued.
 */
export default function RolesTab({ state, info, call, notify, selectedId, onSelect }) {
  const app = state.apps.find((a) => a.clientId === selectedId) ?? state.apps[0] ?? null;

  if (!app) {
    return <Empty title="Register an app first">Roles belong to an app. Create one in the App registrations tab, then define its roles here.</Empty>;
  }
  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>App roles</h2>
            <p className="muted nomargin">Roles are defined per app. Pick the app to define roles for, then map them below.</p>
          </div>
          <Field label="App">
            <select value={app.clientId} onChange={(e) => onSelect(e.target.value)} aria-label="App">
              {state.apps.map((a) => <option key={a.clientId} value={a.clientId}>{a.name}</option>)}
            </select>
          </Field>
        </div>
        <RoleDefinitions key={app.clientId} app={app} call={call} />
      </div>
      <RoleMapping key={`map-${app.clientId}`} app={app} state={state} info={info} call={call} notify={notify} />
    </div>
  );
}

function RoleDefinitions({ app, call }) {
  const [role, setRole] = useState('');
  const base = `/apps/${encodeURIComponent(app.clientId)}`;
  return (
    <>
      {app.roles.length === 0 ? (
        <p className="muted">No roles yet. Add one, for example <code>Reader</code> or <code>Orders.Approve</code>. The value is what appears in the <code>roles</code> claim.</p>
      ) : (
        <ul className="role-list">
          {app.roles.map((r) => {
            const users = app.assignments.filter((a) => a.roles.includes(r)).length;
            return (
              <li key={r}>
                <code>{r}</code>
                <span className="muted small">{users} {users === 1 ? 'user' : 'users'}</span>
                <ConfirmButton confirmLabel="Remove from everyone?" onConfirm={() => call('DELETE', `${base}/roles/${encodeURIComponent(r)}`)}>Delete</ConfirmButton>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="form-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await call('POST', `${base}/roles`, { role })) setRole('');
        }}
      >
        <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Approver" aria-label="New role value" />
        <button className="btn btn-primary" type="submit" disabled={!role.trim()}>Add role</button>
      </form>
    </>
  );
}

function RoleMapping({ app, state, info, call, notify }) {
  const base = `/apps/${encodeURIComponent(app.clientId)}`;
  const [preview, setPreview] = useState(null); // { label, result }
  const [newUser, setNewUser] = useState('');

  const users = app.assignments.map((a) => ({ ...a, user: state.users.find((u) => u.oid === a.userId) })).filter((a) => a.user);
  const accounts = state.serviceAccounts.filter((s) => s.targetAppClientId === app.clientId);
  const otherAccounts = state.serviceAccounts.filter((s) => s.targetAppClientId !== app.clientId);
  const assigned = new Set(app.assignments.map((a) => a.userId));
  const unassigned = state.users.filter((u) => !assigned.has(u.oid));
  const userToAdd = unassigned.some((u) => u.oid === newUser) ? newUser : unassigned[0]?.oid ?? '';
  const [accountToAttach, setAccountToAttach] = useState('');
  const attachId = otherAccounts.some((s) => s.id === accountToAttach) ? accountToAttach : otherAccounts[0]?.id ?? '';

  const toggle = (current, role) => app.roles.filter((r) => (r === role ? !current.includes(r) : current.includes(r)));

  const previewUser = async ({ userId, user }) => {
    try {
      const { access_token } = await request('POST', `/api/admin${base}/assignments/${encodeURIComponent(userId)}/token`);
      setPreview({ label: `${user.name} signing in to ${app.name}`, result: resultFromToken(access_token) });
    } catch (e) {
      notify(e.message);
    }
  };
  const previewAccount = async (sp) => {
    const secret = sp.secrets[0];
    if (!secret) return notify(`${sp.name} has no secret. Generate one in the Service accounts tab.`);
    setPreview({ label: `${sp.name} using client_credentials`, result: await requestClientCredentials(info, sp, secret.secret, `api://${app.clientId}/.default`) });
  };

  if (app.roles.length === 0) {
    return <Empty title="Add a role to start mapping">Once this app has roles, users and service accounts can be given them here.</Empty>;
  }

  const roleCells = (principalLabel, current, onChange) =>
    app.roles.map((r) => (
      <td key={r} className="check-cell">
        <input type="checkbox" checked={current.includes(r)} onChange={() => onChange(toggle(current, r))} aria-label={`${principalLabel} has ${r}`} />
      </td>
    ));

  return (
    <div className="panel">
      <h2>Role mapping</h2>
      <p className="muted">
        Tick a box to give that role to a user or service account. Tokens issued from now on carry exactly the ticked roles in the <code>roles</code> claim.
        Use <strong>Preview token</strong> to see the signed JWT.
      </p>
      <div className="table-scroll">
        <table className="matrix">
          <thead>
            <tr>
              <th>Principal</th>
              {app.roles.map((r) => <th key={r} className="check-cell"><code>{r}</code></th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            <tr className="group-row"><th colSpan={app.roles.length + 2}>Users</th></tr>
            {users.length === 0 && <tr><td colSpan={app.roles.length + 2} className="muted">No users assigned to this app yet.</td></tr>}
            {users.map((row) => (
              <tr key={row.userId}>
                <td><strong>{row.user.name}</strong><div className="muted small">{row.user.preferred_username}</div></td>
                {roleCells(row.user.name, row.roles, (roles) => call('POST', `${base}/assignments`, { userId: row.userId, roles }))}
                <td className="right nowrap">
                  <button className="btn btn-sm" onClick={() => previewUser(row)}>Preview token</button>{' '}
                  <button className="btn btn-sm" onClick={() => call('DELETE', `${base}/assignments/${encodeURIComponent(row.userId)}`)}>Remove</button>
                </td>
              </tr>
            ))}
            <tr className="group-row"><th colSpan={app.roles.length + 2}>Service accounts</th></tr>
            {accounts.length === 0 && <tr><td colSpan={app.roles.length + 2} className="muted">No service accounts target this app.</td></tr>}
            {accounts.map((sp) => (
              <tr key={sp.id}>
                <td><strong>{sp.name}</strong><div className="muted small mono">{sp.clientId}</div></td>
                {roleCells(sp.name, sp.roles, (roles) => call('PUT', `/service-accounts/${encodeURIComponent(sp.id)}`, { roles }))}
                <td className="right nowrap"><button className="btn btn-sm" onClick={() => previewAccount(sp)}>Preview token</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="assign-row">
        {unassigned.length > 0 && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              call('POST', `${base}/assignments`, { userId: userToAdd, roles: [] });
            }}
          >
            <Field label="Add a user to this app">
              <select value={userToAdd} onChange={(e) => setNewUser(e.target.value)}>
                {unassigned.map((u) => <option key={u.oid} value={u.oid}>{u.name} ({u.preferred_username})</option>)}
              </select>
            </Field>
            <button className="btn" type="submit">Add user</button>
          </form>
        )}
        {otherAccounts.length > 0 && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              call('PUT', `/service-accounts/${encodeURIComponent(attachId)}`, { targetAppClientId: app.clientId });
            }}
          >
            <Field label="Point a service account at this app">
              <select value={attachId} onChange={(e) => setAccountToAttach(e.target.value)}>
                {otherAccounts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <button className="btn" type="submit">Use this app</button>
          </form>
        )}
      </div>
      {otherAccounts.length > 0 && <p className="muted small">Pointing a service account at this app drops any roles it held on its previous app.</p>}

      {preview && (
        <div className="stack tight preview">
          <h3>Token preview: {preview.label}</h3>
          <TokenResult result={preview.result} />
        </div>
      )}
    </div>
  );
}
