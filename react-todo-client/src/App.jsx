// src/App.jsx
import React, { useEffect, useState, useRef } from 'react';
import { getMsalConfig, setAppOverride } from './authConfig.js';
import { handleRedirectPromise, loginRedirect, logoutRedirect, parseEntraToken } from './entraAuth.js';

const API_BASE = 'http://localhost:5010/api';

function BrandMark() {
  return (
    <span className="logo" aria-hidden="true">
      <i /><i /><i /><i />
    </span>
  );
}

export default function App() {
  const [cfg, setCfg] = useState(() => getMsalConfig());
  const [tenantInput, setTenantInput] = useState(cfg.auth.tenantId);
  const [clientInput, setClientInput] = useState(cfg.auth.clientId);

  const [tokens, setTokens] = useState(() => {
    const saved = localStorage.getItem('entra_tokens');
    return saved ? JSON.parse(saved) : null;
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');

  const claims = tokens ? parseEntraToken(tokens.access_token) : null;
  const roles = Array.isArray(claims?.roles) ? claims.roles : [];

  const canRead = roles.includes('RoleRead') || roles.includes('RoleWrite') || roles.includes('RoleAdmin');
  const canWrite = roles.includes('RoleWrite') || roles.includes('RoleAdmin');
  const isAdmin = roles.includes('RoleAdmin');

  const [todos, setTodos] = useState([]);
  const [todosLoading, setTodosLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');
  const codeExchangedRef = useRef(false);

  // The API is the single source of truth for the task list.
  const loadTodos = async (accessToken) => {
    const res = await fetch(`${API_BASE}/todos`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem('entra_tokens');
      setTokens(null);
      throw new Error(res.status === 401 ? 'Session expired. Please sign in again.' : '403 Forbidden: Insufficient permissions.');
    }
    if (!res.ok) throw new Error('Failed to fetch todos from API');
    setTodos(await res.json());
  };

  useEffect(() => {
    if (tokens?.access_token) {
      setTodosLoading(true);
      loadTodos(tokens.access_token)
        .catch((err) => setError(err.message))
        .finally(() => setTodosLoading(false));
    }
  }, [tokens]);

  useEffect(() => {
    if (window.location.pathname === '/callback' && !codeExchangedRef.current) {
      codeExchangedRef.current = true;
      setLoading(true);
      handleRedirectPromise(new URLSearchParams(window.location.search))
        .then((receivedTokens) => {
          localStorage.setItem('entra_tokens', JSON.stringify(receivedTokens));
          setTokens(receivedTokens);
          window.history.replaceState({}, '', '/');
        })
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }
  }, []);

  const applyAppConfig = (e) => {
    e.preventDefault();
    setAppOverride(tenantInput, clientInput);
    setCfg(getMsalConfig());
    setError('');
  };

  const showNotice = (msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 3000);
  };

  // Always goes to the API: the client does not pre-check roles, the API decides (RoleWrite / RoleAdmin).
  const addTodo = async (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;

    setError('');
    setAdding(true);
    try {
      const res = await fetch(`${API_BASE}/todos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.access_token}`
        },
        body: JSON.stringify({ text, done: false })
      });
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem('entra_tokens');
        setTokens(null);
        throw new Error(res.status === 401 ? 'Session expired. Please sign in again.' : '403 Forbidden: Insufficient permissions.');
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to create todo');
      }
      setInput('');
      await loadTodos(tokens.access_token);
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const toggleTodo = async (id) => {
    if (!canWrite) return showNotice('403 Forbidden: Requires RoleWrite or RoleAdmin.');
    const todo = todos.find(t => t.id === id);
    if (!todo) return;

    try {
      const res = await fetch(`${API_BASE}/todos/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.access_token}`
        },
        body: JSON.stringify({ done: !todo.done })
      });
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem('entra_tokens');
        setTokens(null);
        throw new Error(res.status === 401 ? 'Session expired. Please sign in again.' : '403 Forbidden: Insufficient permissions.');
      }
      if (!res.ok) throw new Error('Failed to update todo');
      const updated = await res.json();
      setTodos((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteTodo = async (id) => {
    if (!isAdmin) return showNotice('403 Forbidden: Requires RoleAdmin.');
    try {
      const res = await fetch(`${API_BASE}/todos/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`
        }
      });
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem('entra_tokens');
        setTokens(null);
        throw new Error(res.status === 401 ? 'Session expired. Please sign in again.' : '403 Forbidden: Insufficient permissions.');
      }
      if (!res.ok) throw new Error('Failed to delete todo');
      setTodos((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="spinner" aria-hidden="true" />
          <p className="muted" role="status">Acquiring Entra ID v2.0 tokens...</p>
        </div>
      </div>
    );
  }

  if (!tokens || !claims) {
    return (
      <div className="auth-page">
        <main className="auth-card">
          <div className="brand"><BrandMark /><span>My Tasks</span></div>
          <h1>Sign in to continue</h1>
          <p className="lede">
            Use your organisation account. What you can see and change in the task list depends on the app roles assigned to you.
          </p>
          {error && (
            <div className="alert alert-error" role="alert">
              <span>{error}</span>
              <button type="button" className="alert-close" aria-label="Dismiss" onClick={() => setError('')}>&times;</button>
            </div>
          )}
          <button className="btn btn-primary btn-block" onClick={() => loginRedirect().catch((e) => setError(e.message))}>
            Sign in with Microsoft Entra ID
          </button>
          <a className="portal-link" href="https://localhost:8080/" target="_blank" rel="noreferrer">
            Open Entra Admin Portal &rarr;
          </a>
        </main>
      </div>
    );
  }

  const initials = (claims.name || claims.preferred_username || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const openCount = todos.filter((t) => !t.done).length;
  const doneCount = todos.length - openCount;

  return (
    <div className="app">
      <header className="appbar">
        <div className="appbar-inner">
          <div className="brand"><BrandMark /><span>My Tasks</span></div>
          <div className="appbar-user">
            <span className="avatar" aria-hidden="true">{initials}</span>
            <div className="who">
              <strong>{claims.name}</strong>
              <span>{claims.preferred_username}</span>
            </div>
            <div className="badges" aria-label="Assigned roles">
              {roles.length
                ? roles.map((r) => <span key={r} className="badge">{r}</span>)
                : <span className="badge badge-none">No Role</span>}
            </div>
            <button className="btn btn-ghost" onClick={logoutRedirect}>Sign Out</button>
          </div>
        </div>
      </header>

      <main className="page">
        <div className="alerts">
          {notice && <div className="alert alert-warn" role="status"><span>{notice}</span></div>}
          {error && (
            <div className="alert alert-error" role="alert">
              <span>{error}</span>
              <button type="button" className="alert-close" aria-label="Dismiss" onClick={() => setError('')}>&times;</button>
            </div>
          )}
        </div>

        <div className="layout">
          <section className="panel" aria-labelledby="tasks-title">
            <div className="panel-head">
              <h1 id="tasks-title">Tasks</h1>
              <span className="count">{openCount} open &middot; {doneCount} completed</span>
            </div>

            <form onSubmit={addTodo} className="add-form">
              <label htmlFor="new-task" className="sr-only">New task</label>
              <input
                id="new-task"
                type="text"
                placeholder="Add a task"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={adding}
                autoComplete="off"
              />
              <button type="submit" className="btn btn-primary" disabled={adding || !input.trim()}>
                {adding ? 'Adding…' : 'Add task'}
              </button>
            </form>

            {todosLoading && todos.length === 0 ? (
              <p className="muted state-msg" role="status">Loading tasks…</p>
            ) : todos.length === 0 ? (
              <p className="muted state-msg">No tasks yet. Add your first task above.</p>
            ) : (
              <ul className="tasks">
                {todos.map((todo) => (
                  <li key={todo.id} className={todo.done ? 'task done' : 'task'}>
                    <label className="task-main" title={canWrite ? undefined : 'Requires RoleWrite or RoleAdmin'}>
                      <input
                        type="checkbox"
                        checked={todo.done}
                        onChange={() => toggleTodo(todo.id)}
                        disabled={!canWrite}
                      />
                      <span className="task-text">{todo.text}</span>
                    </label>
                    {isAdmin && (
                      <button className="btn btn-danger btn-sm" onClick={() => deleteTodo(todo.id)}>Delete</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <aside className="side">
            <section className="panel" aria-labelledby="access-title">
              <h2 id="access-title">Your access</h2>
              <p className="muted small">Evaluated from the app roles in your token ({roles.join(', ') || 'None'}).</p>
              <dl className="access">
                <div><dt>Read</dt><dd className={canRead ? 'yes' : 'no'}>{canRead ? 'Allowed' : 'Denied'}</dd></div>
                <div><dt>Write</dt><dd className={canWrite ? 'yes' : 'no'}>{canWrite ? 'Allowed' : 'Denied'}</dd></div>
                <div><dt>Admin (Delete)</dt><dd className={isAdmin ? 'yes' : 'no'}>{isAdmin ? 'Allowed' : 'Denied'}</dd></div>
              </dl>
              <p className="meta">Tenant <code>{claims.tid}</code></p>
              <p className="meta">App <code>{claims.aud}</code></p>
              <details className="token-box">
                <summary>Inspect Entra v2.0 JWT Claims</summary>
                <pre>{JSON.stringify(claims, null, 2)}</pre>
              </details>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}