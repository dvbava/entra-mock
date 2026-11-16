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

let todos = [
  { id: '1', text: 'Register new app & assign users in Entra Admin Portal', done: true },
  { id: '2', text: 'Test service-to-service client_credentials flow', done: false },
];

app.get('/api/todos', checkJwt, (req, res) => {
  res.json(todos);
});

app.post('/api/todos', checkJwt, (req, res) => {
  const roles = req.auth?.roles || [];
  if (!roles.includes('RoleWrite')) {
    return res.status(403).json({ error: 'Forbidden: Requires RoleWrite or RoleAdmin' });
  }

  const { text, done } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Task text is required' });
  }

  const newTodo = { id: crypto.randomUUID(), text: text.trim(), done: !!done };
  todos.unshift(newTodo);
  res.status(201).json(newTodo);
});

app.patch('/api/todos/:id', checkJwt, (req, res) => {
  const roles = req.auth?.roles || [];
  if (!roles.includes('RoleWrite')) {
    return res.status(403).json({ error: 'Forbidden: Requires RoleWrite or RoleAdmin' });
  }

  const { id } = req.params;
  const todo = todos.find(t => t.id === id);
  if (!todo) return res.status(404).json({ error: 'Todo not found' });

  if (typeof req.body.done === 'boolean') {
    todo.done = req.body.done;
  }
  res.json(todo);
});

app.delete('/api/todos/:id', checkJwt, (req, res) => {
  const roles = req.auth?.roles || [];
  if (!roles.includes('RoleWrite')) {
    return res.status(403).json({ error: 'Forbidden: Requires RoleWrite' });
  }

  const { id } = req.params;
  const index = todos.findIndex(t => t.id === id);
  if (index === -1) return res.status(404).json({ error: 'Todo not found' });

  todos.splice(index, 1);
  res.status(204).send();
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});