// src/App.jsx
import React, { useEffect, useState, useRef } from 'react';
import { getMsalConfig, setAppOverride } from './authConfig.js';
import { handleRedirectPromise, loginRedirect, logoutRedirect, parseEntraToken } from './entraAuth.js';

const API_BASE = 'http://localhost:5000/api';

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
  const [input, setInput] = useState('');
  const codeExchangedRef = useRef(false);

  useEffect(() => {
    if (tokens?.access_token) {
      fetch(`${API_BASE}/todos`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      })
        .then((res) => {
          if (res.status === 401 || res.status === 403) {
            localStorage.removeItem('entra_tokens');
            setTokens(null);
            throw new Error(res.status === 401 ? 'Session expired. Please sign in again.' : '403 Forbidden: Insufficient permissions.');
          }
          if (!res.ok) throw new Error('Failed to fetch todos from API');
          return res.json();
        })
        .then((data) => setTodos(data))
        .catch((err) => setError(err.message));
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

  const addTodo = async (e) => {
    e.preventDefault();
    if (!canWrite) return showNotice('403 Forbidden: Requires RoleWrite or RoleAdmin.');
    const text = input.trim();
    if (!text) return;

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
      const newTodo = await res.json();
      setTodos((prev) => [newTodo, ...prev]);
      setInput('');
    } catch (err) {
      setError(err.message);
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
    return <div className="container"><p>Acquiring Entra ID v2.0 tokens...</p></div>;
  }

  if (!tokens || !claims) {
    return (
      <div className="container">
        <div className="card" style={{ position: 'relative' }}>
          <h1>Todo Application</h1>
          <button className="btn-ms" onClick={() => loginRedirect().catch((e) => setError(e.message))}>
            Sign in with Microsoft Entra ID
          </button>
          <br/><br/>
          {error && <div className="error">{error}</div>}
          <a
            href="http://localhost:8080/"
            target="_blank"
            rel="noreferrer"
            style={{ position: 'absolute', bottom: '8px', right: '12px', fontSize: '10px', color: '#666', textDecoration: 'none' }}
          >
            Open Entra Admin Portal &rarr;
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card">
        <header className="header">
          <div>
            <h1>Entra ID Tasks</h1>
            <div className="user-meta">
              <span>{claims.name} ({claims.preferred_username})</span>
              <span className="role-pill">{roles.join(', ') || 'No Role'}</span>
            </div>
            <div className="tenant-line">
              Tenant: <code>{claims.tid}</code> | App: <code>{claims.aud}</code>
            </div>
          </div>
          <button className="btn-secondary" onClick={logoutRedirect}>Sign Out</button>
        </header>

        {notice && <div className="notice">{notice}</div>}
        {error && <div className="error">{error}</div>}

        <form onSubmit={addTodo} className="todo-form">
          <input
            type="text"
            placeholder={canWrite ? 'Add a task...' : 'Read-only access'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!canWrite}
          />
          <button type="submit" className="btn-ms" disabled={!canWrite}>Add</button>
        </form>

        <ul className="todo-list">
          {todos.map((todo) => (
            <li key={todo.id} className={todo.done ? 'done' : ''}>
              <label>
                <input
                  type="checkbox"
                  checked={todo.done}
                  onChange={() => toggleTodo(todo.id)}
                  disabled={!canWrite}
                />
                <span>{todo.text}</span>
              </label>
              {isAdmin && (
                <button className="btn-delete" onClick={() => deleteTodo(todo.id)}>Delete</button>
              )}
            </li>
          ))}
        </ul>

        <div className="permissions-legend">
          <strong>Evaluated App Roles ({roles.join(', ') || 'None'}):</strong>
          <ul>
            <li>Read: <span className={canRead ? 'yes' : 'no'}>{canRead ? 'Allowed' : 'Denied'}</span></li>
            <li>Write: <span className={canWrite ? 'yes' : 'no'}>{canWrite ? 'Allowed' : 'Denied'}</span></li>
            <li>Admin (Delete): <span className={isAdmin ? 'yes' : 'no'}>{isAdmin ? 'Allowed' : 'Denied'}</span></li>
          </ul>
        </div>

        <details className="token-box">
          <summary>Inspect Entra v2.0 JWT Claims</summary>
          <pre>{JSON.stringify(claims, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}