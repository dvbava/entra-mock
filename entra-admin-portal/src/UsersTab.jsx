import { useState } from 'react';
import { ConfirmButton, Empty, Field, IdValue } from './ui.jsx';

export default function UsersTab({ state, call }) {
  const [name, setName] = useState('');
  const [upn, setUpn] = useState('');

  const appsFor = (oid) =>
    state.apps.flatMap((a) => {
      const asg = a.assignments.find((x) => x.userId === oid);
      return asg ? [{ app: a, roles: asg.roles }] : [];
    });

  return (
    <div className="stack">
      <form
        className="panel"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await call('POST', '/users', { name, preferred_username: upn })) {
            setName('');
            setUpn('');
          }
        }}
      >
        <h2>Create user</h2>
        <div className="form-row">
          <Field label="Display name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dana Ops" /></Field>
          <Field label="Email / user principal name" grow>
            <input value={upn} onChange={(e) => setUpn(e.target.value)} placeholder="dana@contoso.onmicrosoft.com" />
          </Field>
          <button className="btn btn-primary" type="submit" disabled={!name.trim() || !upn.trim()}>Create user</button>
        </div>
      </form>

      <div className="panel">
        <h2>Users</h2>
        {state.users.length === 0 ? (
          <Empty title="No users">Create a user above, then assign them to an app.</Empty>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Object ID</th><th>App access</th><th /></tr></thead>
            <tbody>
              {state.users.map((u) => {
                const memberships = appsFor(u.oid);
                return (
                  <tr key={u.oid}>
                    <td><strong>{u.name}</strong><div className="muted">{u.preferred_username}</div></td>
                    <td><IdValue value={u.oid} /></td>
                    <td>
                      {memberships.length === 0 && <span className="muted">Not assigned to any app</span>}
                      {memberships.map(({ app, roles }) => (
                        <div key={app.clientId} className="membership">
                          {app.name} <span className="muted">{roles.join(', ') || 'no roles'}</span>
                        </div>
                      ))}
                    </td>
                    <td className="right"><ConfirmButton onConfirm={() => call('DELETE', `/users/${encodeURIComponent(u.oid)}`)}>Delete</ConfirmButton></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
