// server.js
import express from 'express';
import cors from 'cors';
import { expressjwt as jwt } from 'express-jwt';
import jwksRsa from 'jwks-rsa';
import crypto from 'crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const app = express();
app.use(cors());
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');
const envFile = path.join(projectDir, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const requiredConfig = [
  'VITE_ENTRA_TENANT_ID',
  'VITE_ENTRA_CLIENT_ID',
  'VITE_ENTRA_AUTHORITY_HOST',
  'API_PORT',
];
const missingConfig = requiredConfig.filter((name) => !process.env[name]);
if (missingConfig.length) {
  throw new Error(`Missing ${missingConfig.join(', ')} in ${envFile}`);
}

const tenantId = process.env.VITE_ENTRA_TENANT_ID;
const clientId = process.env.VITE_ENTRA_CLIENT_ID;
const authorityHost = process.env.VITE_ENTRA_AUTHORITY_HOST.replace(/\/$/, '');
const authorityUrl = new URL(authorityHost);
const authorityCertFile = process.env.ENTRA_AUTHORITY_CERT_FILE ||
  (authorityUrl.hostname === 'localhost'
    ? path.resolve(__dirname, '../../mock-entra-server/cert.pem')
    : '');
const resolvedAuthorityCertFile = authorityCertFile
  ? path.resolve(projectDir, authorityCertFile)
  : '';
const requestAgent = authorityUrl.protocol === 'https:' && resolvedAuthorityCertFile && fs.existsSync(resolvedAuthorityCertFile)
  ? new https.Agent({ ca: fs.readFileSync(resolvedAuthorityCertFile) })
  : undefined;
const PORT = Number(process.env.API_PORT);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`API_PORT must be an integer between 1 and 65535 in ${envFile}`);
}

// Cryptographic token validation via JWKS keys endpoint from the authority
const checkJwt = jwt({
  secret: jwksRsa.expressJwtSecret({
    cache: false,
    rateLimit: false,
    jwksRequestsPerMinute: 5,
    jwksUri: `${authorityHost}/${tenantId}/discovery/v2.0/keys`,
    ...(requestAgent ? { requestAgent } : {}),
  }),
  audience: clientId,
  issuer: `${authorityHost}/${tenantId}/v2.0`,
  algorithms: ['RS256']
});

const dbFile = path.join(projectDir, 'todos.db');
const db = new DatabaseSync(dbFile);
db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'medium',
    dueDate TEXT,
    category TEXT NOT NULL DEFAULT 'General',
    created_at TEXT NOT NULL
  )
`);

const countRow = db.prepare('SELECT COUNT(*) as cnt FROM todos').get();
if (countRow.cnt === 0) {
  const insert = db.prepare('INSERT INTO todos (id, text, done, priority, dueDate, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('1', 'Register new app & assign users in Entra Admin Portal', 1, 'high', '2026-06-01', 'Security', new Date().toISOString());
  insert.run('2', 'Test service-to-service client_credentials flow', 0, 'medium', '2026-06-15', 'Backend', new Date().toISOString());
}

app.get('/api/todos', checkJwt, (req, res) => {
  const rows = db.prepare('SELECT id, text, done, priority, dueDate, category, created_at FROM todos ORDER BY created_at DESC').all();
  const todos = rows.map(r => ({
    id: r.id,
    text: r.text,
    done: !!r.done,
    priority: r.priority,
    dueDate: r.dueDate || '',
    category: r.category,
    createdAt: r.created_at
  }));
  res.json(todos);
});

app.post('/api/todos', checkJwt, (req, res) => {
  const roles = req.auth?.roles || [];
  if (!roles.includes('OrpTsrWrite') && !roles.includes('RoleWrite') && !roles.includes('RoleAdmin')) {
    return res.status(403).json({ error: 'Forbidden: Requires write permissions' });
  }

  const { text, priority, dueDate, category } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Task text is required' });
  }

  const newTodo = {
    id: crypto.randomUUID(),
    text: text.trim(),
    done: 0,
    priority: ['low', 'medium', 'high'].includes(priority) ? priority : 'medium',
    dueDate: dueDate || null,
    category: category ? category.trim() : 'General',
    createdAt: new Date().toISOString()
  };

  db.prepare('INSERT INTO todos (id, text, done, priority, dueDate, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(newTodo.id, newTodo.text, newTodo.done, newTodo.priority, newTodo.dueDate, newTodo.category, newTodo.createdAt);

  res.status(201).json({
    ...newTodo,
    done: false
  });
});

app.patch('/api/todos/:id', checkJwt, (req, res) => {
  const roles = req.auth?.roles || [];
  if (!roles.includes('OrpTsrWrite') && !roles.includes('RoleWrite') && !roles.includes('RoleAdmin')) {
    return res.status(403).json({ error: 'Forbidden: Requires write permissions' });
  }

  const { id } = req.params;
  const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Todo not found' });

  const done = typeof req.body.done === 'boolean' ? (req.body.done ? 1 : 0) : row.done;
  const text = req.body.text !== undefined ? req.body.text.trim() : row.text;
  const priority = req.body.priority !== undefined ? req.body.priority : row.priority;
  const dueDate = req.body.dueDate !== undefined ? req.body.dueDate : row.dueDate;
  const category = req.body.category !== undefined ? req.body.category : row.category;

  db.prepare('UPDATE todos SET text = ?, done = ?, priority = ?, dueDate = ?, category = ? WHERE id = ?')
    .run(text, done, priority, dueDate, category, id);

  const updated = db.prepare('SELECT * FROM todos WHERE id = ?').get(id);
  res.json({
    id: updated.id,
    text: updated.text,
    done: !!updated.done,
    priority: updated.priority,
    dueDate: updated.dueDate || '',
    category: updated.category,
    createdAt: updated.created_at
  });
});

app.delete('/api/todos/:id', checkJwt, (req, res) => {
  const roles = req.auth?.roles || [];
  if (!roles.includes('OrpTsrWrite') && !roles.includes('RoleWrite') && !roles.includes('RoleAdmin')) {
    return res.status(403).json({ error: 'Forbidden: Requires write permissions' });
  }

  const { id } = req.params;
  const result = db.prepare('DELETE FROM todos WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Todo not found' });

  res.status(204).send();
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});