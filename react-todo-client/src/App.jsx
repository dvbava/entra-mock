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
  const [tokens, setTokens] = useState(() => {
    const saved = localStorage.getItem('entra_tokens');
    return saved ? JSON.parse(saved) : null;
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');

  const claims = tokens ? parseEntraToken(tokens.access_token) : null;
  const roles = Array.isArray(claims?.roles) ? claims.roles : [];

  const canRead = roles.includes('RoleRead') || roles.includes('RoleWrite');
  const canWrite = roles.includes('RoleWrite');

  const [todos, setTodos] = useState([]);
  const [todosLoading, setTodosLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');
  const [priority, setPriority] = useState('medium');
  const [category, setCategory] = useState('General');
  const [dueDate, setDueDate] = useState('');
  const [filter, setFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const codeExchangedRef = useRef(false);

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

  const showNotice = (msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 3000);
  };

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
        body: JSON.stringify({ text, priority, category, dueDate })
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
      setDueDate('');
      await loadTodos(tokens.access_token);
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const toggleTodo = async (id) => {
    if (!canWrite) return showNotice('403 Forbidden: Requires write permissions.');
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
    if (!canWrite) return showNotice('403 Forbidden: Requires write permissions.');
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
            Use your organizational account. Access levels are determined by your assigned app roles.
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
        </main>
      </div>
    );
  }

  const initials = (claims.name || claims.preferred_username || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  
  const filteredTodos = todos.filter(t => {
    const matchesFilter = filter === 'all' ? true : filter === 'open' ? !t.done : t.done;
    const matchesSearch = t.text.toLowerCase().includes(searchTerm.toLowerCase()) || t.category.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesFilter && matchesSearch;
  });

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
              <h1 id="tasks-title">Task Management</h1>
              <span className="count">{openCount} open &middot; {doneCount} completed</span>
            </div>

            {canWrite && (
              <form onSubmit={addTodo} className="add-form-advanced">
                <div className="form-row">
                  <input
                    type="text"
                    placeholder="Task description"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    disabled={adding}
                    autoComplete="off"
                  />
                  <select value={priority} onChange={(e) => setPriority(e.target.value)} disabled={adding}>
                    <option value="low">Low Priority</option>
                    <option value="medium">Medium Priority</option>
                    <option value="high">High Priority</option>
                  </select>
                </div>
                <div className="form-row">
                  <input
                    type="text"
                    placeholder="Category (e.g. Security, Backend)"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    disabled={adding}
                  />
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    disabled={adding}
                  />
                  <button type="submit" className="btn btn-primary" disabled={adding || !input.trim()}>
                    {adding ? 'Adding...' : 'Add Task'}
                  </button>
                </div>
              </form>
            )}

            <div className="toolbar">
              <input
                type="text"
                placeholder="Search tasks..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="search-input"
              />
              <div className="filter-tabs">
                <button className={`btn-filter ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>All</button>
                <button className={`btn-filter ${filter === 'open' ? 'active' : ''}`} onClick={() => setFilter('open')}>Open</button>
                <button className={`btn-filter ${filter === 'completed' ? 'active' : ''}`} onClick={() => setFilter('completed')}>Completed</button>
              </div>
            </div>

            {todosLoading && todos.length === 0 ? (
              <p className="muted state-msg" role="status">Loading tasks...</p>
            ) : filteredTodos.length === 0 ? (
              <p className="muted state-msg">No tasks found.</p>
            ) : (
              <ul className="tasks">
                {filteredTodos.map((todo) => (
                  <li key={todo.id} className={`task ${todo.done ? 'done' : ''} priority-${todo.priority}`}>
                    <label className="task-main" title={canWrite ? undefined : 'Requires write permissions'}>
                      <input
                        type="checkbox"
                        checked={todo.done}
                        onChange={() => toggleTodo(todo.id)}
                        disabled={!canWrite}
                      />
                      <div className="task-info">
                        <span className="task-text">{todo.text}</span>
                        <div className="task-meta">
                          <span className="badge-cat">{todo.category}</span>
                          <span className={`badge-prio prio-${todo.priority}`}>{todo.priority}</span>
                          {todo.dueDate && <span className="due-date">Due: {todo.dueDate}</span>}
                        </div>
                      </div>
                    </label>
                    {canWrite && (
                      <button className="btn btn-danger btn-sm" onClick={() => deleteTodo(todo.id)}>Delete</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <aside className="side">
            <section className="panel" aria-labelledby="access-title">
              <h2 id="access-title">Authorization Status</h2>
              <p className="muted small">Model: Binary Roles ({roles.join(', ') || 'None'})</p>
              <dl className="access">
                <div><dt>Read Access</dt><dd className={canRead ? 'yes' : 'no'}>{canRead ? 'Allowed' : 'Denied'}</dd></div>
                <div><dt>Write Access</dt><dd className={canWrite ? 'yes' : 'no'}>{canWrite ? 'Allowed' : 'Denied'}</dd></div>
              </dl>
              <p className="meta">Tenant <code>{claims.tid}</code></p>
              <p className="meta">App <code>{claims.aud}</code></p>
              <details className="token-box">
                <summary>Inspect JWT Claims</summary>
                <pre>{JSON.stringify(claims, null, 2)}</pre>
              </details>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}