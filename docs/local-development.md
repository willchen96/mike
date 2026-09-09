# Local development

The recommended local setup uses Docker Compose to run the application and its
infrastructure together. No managed Supabase project or object-storage account
is required.

The stack includes:

- the Mike frontend and backend;
- Supabase Postgres, Auth, data API, and gateway;
- RustFS for S3-compatible object storage; and
- Mailpit for local authentication email.

The database schema loads automatically on first boot.

## Start the Docker stack

Copy the local environment templates:

```bash
cp .env.example .env
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

- Set `DOWNLOAD_SIGNING_SECRET` and `USER_API_KEYS_ENCRYPTION_SECRET` to
  separate values generated with `openssl rand -hex 32`.
- Add an Anthropic, Gemini, or OpenAI API key, unless you plan to use Ollama
  exclusively.

Docker Compose supplies the local Supabase and object-storage settings, so
leave those values unchanged. Then start the stack:

```bash
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000) and sign up.

## Local service endpoints

| Service | Address | Notes |
| --- | --- | --- |
| Mike | `http://localhost:3000` | Main application |
| Supabase API | `http://localhost:54321` | Auth and data API gateway |
| Postgres | `localhost:54322` | Host access for database tools |
| RustFS console | `http://localhost:9001` | `rustfsadmin` / `rustfsadmin` |
| Mailpit | `http://localhost:8025` | Captured local auth email |

The Supabase JWT secret and anon/`service_role` keys in `docker-compose.yml`
and `.env.example` are well-known local demo values. They are convenient for
localhost but must be regenerated before exposing an instance anywhere.

## Local registration and email

By default, a local email-and-password registration is automatically confirmed
and the new user is signed in. Supabase Auth sends authentication email; the
Mike backend does not send it directly.

To exercise the confirmation-email flow, set
`GOTRUE_MAILER_AUTOCONFIRM=false` in the root `.env`, then recreate Auth:

```bash
docker compose up -d --force-recreate auth
```

Open [Mailpit](http://localhost:8025) to read the confirmation message. Mailpit
also captures local email-change and password-reset messages, and no email
leaves your machine. These links pass through `/auth/callback` and return to the
relevant app screen. Local signup autoconfirm remains enabled by default; turn
it off only when you specifically want to test the confirmation flow.

## Local Google authentication

Google OAuth works with either local Supabase option. Create a Google **Web
application** OAuth client and keep its secret out of Git.

For Docker Compose, register this Google authorized redirect URI:

```text
http://localhost:54321/auth/v1/callback
```

Google OAuth is enabled by default. Set the client values in the root `.env`,
or set `GOTRUE_EXTERNAL_GOOGLE_ENABLED=false` to opt out. Then recreate Auth:

```env
GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=<client-id>
GOTRUE_EXTERNAL_GOOGLE_SECRET=<client-secret>
```

```bash
docker compose up -d --force-recreate auth
```

For the Supabase CLI stack, register
`http://127.0.0.1:54321/auth/v1/callback`, then set
`SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and
`SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET` in `backend/.env`. Google OAuth
is enabled by default; set `[auth.external.google].enabled` to `false` in
`backend/supabase/config.toml` to opt out locally. Restart the stack after a
configuration change:

```bash
cd backend
supabase stop
supabase start
```

The checked-in configuration already allows the web callback and the local
Word dialog callback at `https://localhost:3200/oauth-dialog.html`. Add your
Google account as an OAuth test user while the Google app remains in testing.

## Local models with Ollama

[Ollama](https://ollama.com) models are discovered dynamically. Anything shown
by `ollama list` appears in Mike's model pickers under **Local**, without an API
key.

The Dockerized backend reaches Ollama on the host at
`http://host.docker.internal:11434/v1`. Override `OLLAMA_BASE_URL` if Ollama is
available elsewhere.

Choose a model that fits the host's available memory, pull it, then refresh
Mike. Replace `MODEL_TAG` with a tag from the Ollama library:

```bash
ollama pull MODEL_TAG
```

Models with tool-calling support can drive the full assistant. If a local model
rejects tools, Mike retries without them so plain chat can continue. Model size
has a significant effect on speed and memory use, especially during tabular
review where the model may run across many cells.

## First run

1. Sign up in the app.
2. If no provider key is configured in `backend/.env`, open
   **Settings > API Keys** and add one.
3. To use live US case-law tools, add a CourtListener token in `backend/.env`
   or under **Settings > API Keys**.
4. Create or open a project and start chatting with documents.

Use synthetic or public documents until you have reviewed the deployment and
data flows. See [Safe local testing](safe-local-testing.md) for guidance.

## Error tracking locally

Sentry is off by default. To watch what the app would report without an
account, run `node scripts/sentry-sink.mjs` and point a DSN at it; see
[observability.md](observability.md).

## Running application code without Docker

To run the frontend and backend processes directly while using separately
configured infrastructure, follow [Manual and production deployment](deployment.md)
through environment setup and dependency installation. Then start each package
in a separate terminal:

```bash
npm run dev --prefix backend
```

```bash
npm run dev --prefix frontend
```

Open [http://localhost:3000](http://localhost:3000).

For common setup problems, see [Troubleshooting](troubleshooting.md).
