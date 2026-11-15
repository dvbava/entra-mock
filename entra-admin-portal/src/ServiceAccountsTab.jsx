import { useState } from 'react';
import { ConfirmButton, Empty, Field, IdValue, RoleToggles, SecretValue, shortDate } from './ui.jsx';
import TokenTester from './TokenTester.jsx';

export default function ServiceAccountsTab({ state, info, call, selectedId, onSelect, onNavigate }) {
  const [creating, setCreating] = useState(false);
  const current = creating ? null : state.serviceAccounts.find((s) => s.id === selectedId) ?? state.serviceAccounts[0] ?? null;

  return (
    <div className="split">
      <section className="list-pane" aria-label="Service accounts">
        <button className="btn btn-primary full" onClick={() => setCreating(true)}>Create service account</button>
        <ul className="pick-list">
          {state.serviceAccounts.map((s) => {
            const target = state.apps.find((a) => a.clientId === s.targetAppClientId);
            return (
              <li key={s.id}>
                <button className="pick" aria-current={current?.id === s.id} onClick={() => { setCreating(false); onSelect(s.id); }}>
                  <strong>{s.name}</strong>
                  <span className={target ? 'muted' : 'warn-text'}>{target ? `for ${target.name}` : 'No target app'}</span>
                  <span className="muted">{s.roles.length} {s.roles.length === 1 ? 'role' : 'roles'}, {s.secrets.length} {s.secrets.length === 1 ? 'secret' : 'secrets'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="detail-pane">
        {creating ? (
          <CreateAccount state={state} call={call} previous={state} onCancel={() => setCreating(false)} onCreated={(id) => { setCreating(false); onSelect(id); }} />
        ) : current ? (
          <AccountDetail key={current.id} account={current} state={state} info={info} call={call} onNavigate={onNavigate} />
        ) : (
          <Empty title="No service accounts yet">
            A service account has its own client ID and secrets. Apps and scripts use them with the client_credentials grant to get a token carrying the roles you pick.
          </Empty>
        )}
      </section>
    </div>
  );
}

function CreateAccount({ state, call, previous, onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [roles, setRoles] = useState([]);
  const targetId = state.apps.some((a) => a.clientId === target) ? target : state.apps[0]?.clientId ?? '';
  const targetApp = state.apps.find((a) => a.clientId === targetId);
  const validRoles = roles.filter((r) => targetApp?.roles.includes(r));

  if (state.apps.length === 0) {
    return <Empty title="Register an app first">Service accounts get their roles on a target app. Create one in the App registrations tab.</Empty>;
  }
  return (
    <form
      className="panel"
      onSubmit={async (e) => {
        e.preventDefault();
        const next = await call('POST', '/service-accounts', { name, targetAppClientId: targetId, roles: validRoles });
        if (!next) return;
        onCreated(next.serviceAccounts.find((s) => !previous.serviceAccounts.some((p) => p.id === s.id))?.id);
      }}
    >
      <h2>Create service account</h2>
      <p className="muted">You get a client ID and an initial secret. Tokens it requests are issued for the target app and carry the roles below.</p>
      <div className="form-row">
        <Field label="Name" grow><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly sync job" autoFocus /></Field>
        <Field label="Target app">
          <select value={targetId} onChange={(e) => setTarget(e.target.value)}>
            {state.apps.map((a) => <option key={a.clientId} value={a.clientId}>{a.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="form-row">
        <div className="field"><span>Roles</span><RoleToggles roles={targetApp?.roles ?? []} selected={validRoles} onChange={setRoles} /></div>
      </div>
      <div className="form-row">
        <button className="btn btn-primary" type="submit" disabled={!name.trim()}>Create</button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function AccountDetail({ account, state, info, call, onNavigate }) {
  const base = `/service-accounts/${encodeURIComponent(account.id)}`;
  const [name, setName] = useState(account.name);
  const [secretDesc, setSecretDesc] = useState('');
  const target = state.apps.find((a) => a.clientId === account.targetAppClientId);

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== account.name) call('PUT', base, { name });
            }}
          >
            <input className="title-input" aria-label="Service account name" value={name} onChange={(e) => setName(e.target.value)} />
            {name.trim() !== account.name && name.trim() && <button className="btn btn-sm" type="submit">Save name</button>}
          </form>
          <ConfirmButton onConfirm={() => call('DELETE', base)}>Delete account</ConfirmButton>
        </div>
        <dl className="kv">
          <dt>Client ID</dt>
          <dd><IdValue value={account.clientId} /></dd>
          <dt>Object ID</dt>
          <dd><IdValue value={account.id.replace(/^sp-/, '')} /></dd>
          <dt>Target app</dt>
          <dd>
            <select value={target?.clientId ?? ''} onChange={(e) => call('PUT', base, { targetAppClientId: e.target.value })} aria-label="Target app">
              {!target && <option value="">Choose an app…</option>}
              {state.apps.map((a) => <option key={a.clientId} value={a.clientId}>{a.name}</option>)}
            </select>
            {!target && <span className="warn-text"> This account can't get tokens until it has a target app.</span>}
          </dd>
          <dt>Roles</dt>
          <dd>
            {target ? (
              <>
                <RoleToggles roles={target.roles} selected={account.roles} onChange={(roles) => call('PUT', base, { roles })} />
                {target.roles.length === 0 && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate('roles', target.clientId)}>Define roles on {target.name}</button>
                )}
              </>
            ) : (
              <span className="muted">Pick a target app to choose from its roles.</span>
            )}
          </dd>
        </dl>
      </div>

      <div className="panel">
        <h3>Client secrets</h3>
        <table>
          <thead><tr><th>Description</th><th>Value</th><th>Created</th><th /></tr></thead>
          <tbody>
            {account.secrets.map((s) => (
              <tr key={s.id}>
                <td>{s.description}</td>
                <td><SecretValue secret={s.secret} /></td>
                <td className="muted">{shortDate(s.createdAt)}</td>
                <td className="right"><ConfirmButton confirmLabel="Confirm revoke" onConfirm={() => call('DELETE', `${base}/secrets/${encodeURIComponent(s.id)}`)}>Revoke</ConfirmButton></td>
              </tr>
            ))}
            {account.secrets.length === 0 && <tr><td colSpan="4" className="muted">No secrets. This account can't authenticate until you generate one.</td></tr>}
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
          <button className="btn" type="submit">Generate secret</button>
        </form>
      </div>

      <div className="panel">
        <h3>Get a token</h3>
        <p className="muted">Sends a real <code>client_credentials</code> request to <code>{info.tokenUrl}</code> and decodes the access token.</p>
        <TokenTester account={account} targetApp={target} info={info} />
      </div>
    </div>
  );
}
