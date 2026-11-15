// server.js
import express from 'express';
import cors from 'cors';
import { expressjwt as jwt } from 'express-jwt';
import jwksRsa from 'jwks-rsa';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const tenantId = process.env.ENTRA_TENANT_ID || '72f988bf-86f1-41af-91ab-2d7cd011db47';
const clientId = process.env.ENTRA_CLIENT_ID || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const authorityHost = process.env.ENTRA_AUTHORITY_HOST || 'http://localhost:8080';

// Cryptographic token validation via JWKS keys endpoint from the authority
const checkJwt = jwt({
  secret: jwksRsa.expressJwtSecret({
    cache: false,
    rateLimit: false,
    jwksRequestsPerMinute: 5,
    jwksUri: `${authorityHost}/${tenantId}/discovery/v2.0/keys`
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
  if (!roles.includes('RoleWrite') && !roles.includes('RoleAdmin')) {
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
  if (!roles.includes('RoleWrite') && !roles.includes('RoleAdmin')) {
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
  if (!roles.includes('RoleAdmin')) {
    return res.status(403).json({ error: 'Forbidden: Requires RoleAdmin' });
  }

  const { id } = req.params;
  const index = todos.findIndex(t => t.id === id);
  if (index === -1) return res.status(404).json({ error: 'Todo not found' });

  todos.splice(index, 1);
  res.status(204).send();
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});