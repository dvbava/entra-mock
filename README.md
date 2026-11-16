# Mock Entra ID

A lightweight, local stand-in for Microsoft Entra ID. Use it to try app sign-in, roles, and service-to-service tokens
without setting up a cloud tenant.

## Get started

Requires Node.js 22.13 or newer.

If `mock-entra-server/.env` does not exist, copy `mock-entra-server/.env.example` to `.env`.

```bash
cd mock-entra-server
npm install
npm start
```

Open the URL printed in the terminal to use the admin portal. On Windows, the server creates and trusts a local
development certificate automatically.

## What you can do

- Register apps and configure their redirect URLs.
- Create users, assign app roles, and preview the tokens they receive.
- Create service accounts and test `client_credentials` tokens.
- Adjust token lifetimes and try refresh-token and silent sign-in flows.

The portal is available at the mock server URL. Data is stored locally in `mock-entra-server/entra-mock.db`.

## Try the sample app

If needed, copy `react-todo-client/.env.example` to `.env`. Then, in another terminal:

```bash
cd react-todo-client
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The sample uses the seeded demo app; you can manage it in the
admin portal.

To develop the portal itself, run `npm install` and `npm run dev` in `entra-admin-portal/`. Its dev server uses
[http://localhost:5174](http://localhost:5174).

## Useful details

- Demo tenant: `72f988bf-86f1-41af-91ab-2d7cd011db47`
- Authority: `https://localhost:8080/<tenant-id>`
- Mock server settings live in `mock-entra-server/.env`; shell environment variables override them.
- Run the end-to-end checks with `cd mock-entra-server` then `npm test`.
- This project is for local development and demos, not production identity or security.
