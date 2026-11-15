# Mock Entra ID: multi-app server, service accounts and admin portal

A local stand-in for Microsoft Entra ID (v2.0 endpoints) for developing apps that use OIDC sign-in, app roles and
service-to-service tokens, with a web UI to manage everything. All data and configuration live in a SQLite database.

| Piece | Folder | URL |
|---|---|---|
| Mock Entra server + built admin portal | `mock-entra-server/` | http://localhost:8080 |
| Admin portal source (React 18 + Vite) | `entra-admin-portal/` | dev server: http://localhost:5174 |
| Sample SPA that signs in against the mock | `react-todo-client/` | http://localhost:5173 |

Tenant ID: `72f988bf-86f1-41af-91ab-2d7cd011db47`
Authority: `http://localhost:8080/72f988bf-86f1-41af-91ab-2d7cd011db47`

## Run

```bash
cd mock-entra-server && npm install && npm start        # server + portal at http://localhost:8080
cd react-todo-client  && npm install && npm run dev     # optional sample SPA at http://localhost:5173
```

Requires Node 22.13 or newer (tested on 22 and 24). SQLite is Node's built-in `node:sqlite`, so there is no native
module to compile and `npm install` needs no C++ toolchain. `npm start` hides Node's "SQLite is an experimental feature" notice.

The portal is already built into `mock-entra-server/portal/`. To work on it:

```bash
cd entra-admin-portal && npm install
npm run dev      # http://localhost:5174, proxies /api to :8080
npm run build    # rebuilds into ../mock-entra-server/portal
```

## What you can do in the portal

- **App registrations**: register any number of apps; edit redirect URIs; create and revoke client secrets;
  add and remove users per app and toggle their roles; set the **token lifetime** for the app.
- **Users**: create and delete directory users; see which apps each one can access.
- **App roles**: pick an app, define its roles, then use the **role mapping** matrix to tick which users and service
  accounts hold which roles. **Preview token** shows the signed JWT those roles produce.
- **Service accounts**: create a service principal for a target app, pick its roles, manage secrets, and press
  **Request token** to run a real `client_credentials` call and see the decoded JWT (plus a copy-ready curl).

Token previews show a live "expires in" countdown, so you can watch a short-lived token expire.

## Roles and tokens

Roles belong to an app. A user is assigned to an app with a subset of that app's roles; a service account targets one
app and holds a subset of that app's roles. The `roles` claim in every token is exactly that mapping, read at the moment
the token is issued (refresh tokens re-read it too). Deleting a role removes it from every user and service account.
Retargeting a service account keeps only the roles the new app also defines.

## Token lifetime (per app)

Set it on the app registration page, 1 to 86400 seconds (default 3600). It applies to access tokens and ID tokens issued
for that app, including `client_credentials` tokens from service accounts that target it; `exp - iat` and `expires_in`
both follow it. Changes affect tokens issued afterwards. Many JWT libraries tolerate a few minutes of clock skew, so
sub-minute lifetimes may need that tolerance set to zero in the app under test.

## Service account (client secret) flow

```bash
curl -X POST http://localhost:8080/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/token \
  -d grant_type=client_credentials \
  -d client_id=99999999-8888-7777-6666-555555555555 \
  -d client_secret=sp-secret-key-987 \
  -d scope=api://a1b2c3d4-e5f6-7890-abcd-ef1234567890/.default
```

The access token has `aud` = target app, `roles` = the account's roles, `idtyp: "app"`, `azp` = the service account's
client ID. HTTP Basic auth (`client_secret_basic`) also works. Scope must end in `/.default` and name the account's
target app (or be omitted). A revoked secret stops working immediately.

## Sign-in flow for apps

Point your OIDC/MSAL config at the authority above with the app's client ID. `/authorize` shows an account picker
containing only users assigned to that app. Supported: authorization code + PKCE, `nonce`, `response_mode`
`query` / `fragment` / `form_post`, `offline_access` refresh tokens, `/oidc/userinfo`, JWKS at
`/{tenant}/discovery/v2.0/keys`. Authorization codes, refresh tokens and the signing key are stored in SQLite, so
sessions and issued tokens survive a restart.

## Database

`mock-entra-server/entra-mock.db` (SQLite, WAL mode). Tables: `settings` (tenant ID, signing key), `users`, `apps`,
`app_roles`, `redirect_uris`, `app_secrets`, `assignments`, `assignment_roles`, `service_accounts`,
`service_account_roles`, `service_account_secrets`, `auth_codes`, `refresh_tokens`, with foreign keys cascading deletes.
Open it with any SQLite tool to inspect or edit; **Reset demo data** in the portal restores the seed data. Back it up by
copying the file (stop the server first, or copy the `-wal` and `-shm` files too).

If a `db.json` and `signing-key.json` from the earlier version are next to `server.js`, they are imported on the first
start (the old tenant-wide role list is copied onto each app) and renamed to `*.migrated`.

## Behaviour notes

- The `roles` claim is omitted when empty, as in Entra. Consumer code should handle a missing claim.
- An app registration using its own secret with `client_credentials` gets a token with no roles. Use a service account when you need roles.
- Deleting an app keeps its service accounts but clears their target app; they get a clear error until you pick a new one.
- `prompt=none` always returns `login_required` (the mock keeps no SSO session).

## Config (env vars)

`PORT` (8080) · `PUBLIC_URL` (`http://localhost:PORT`; set it if clients reach the server by another host name, since it is the token `iss`) · `DATA_DIR` (where `entra-mock.db` lives; defaults to the server folder).

