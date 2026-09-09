# Troubleshooting

## A local account says “Email not confirmed”

Docker autoconfirms newly created accounts by default. Accounts created before
autoconfirm was enabled remain unconfirmed. Confirm the existing message in
[Mailpit](http://localhost:8025), or create a new local account.

To test confirmation deliberately, set `GOTRUE_MAILER_AUTOCONFIRM=false` in the
root `.env` and recreate the Auth service:

```bash
docker compose up -d --force-recreate auth
```

## Production authentication email does not arrive

Authentication email is sent by Supabase Auth. Check its email-provider
settings, delivery logs, and rate limits, and configure production SMTP in the
Supabase dashboard. Mike intentionally shows the same password-reset response
for registered and unregistered addresses, so that screen cannot confirm
whether an account exists.

## A confirmation or password-reset link is rejected

Confirm that the deployed frontend's exact `/auth/callback` URL is present in
the Supabase Auth redirect allow list and that the Site URL uses the correct
scheme and hostname. Request a new message after correcting either value;
authentication links expire and may only be usable once.

For a secure email change, Supabase sends messages to both the current and new
addresses. The change remains pending until both messages are confirmed. If an
email change succeeds in Auth but the profile still shows the old address,
verify that the latest database migration has been applied.

## Port 54322 is already allocated

Another local Postgres or Supabase stack is using Mike's default host port.
Stop that stack or choose another mapping, for example:

```bash
DB_PORT=54323 docker compose up --build
```

## The model picker reports a missing key

Add a key under **Settings > API Keys**, or configure it in
`backend/.env` and restart the backend.

For local Ollama models, confirm `ollama list` shows an installed model and the
backend can reach the URL configured by `OLLAMA_BASE_URL`. Refresh Mike after
installing a model.

## CourtListener tools are unavailable

See [CourtListener integration](courtlistener.md#troubleshooting) for API-token
and optional bulk-data checks.

## DOC or DOCX conversion fails

Install LibreOffice and restart the backend so its conversion command is
available on the process path.

## Sentry receives no events

- The backend logs `[sentry] enabled for api` at boot when `SENTRY_DSN` is
  set and `[sentry] disabled` otherwise. If it says disabled inside Docker,
  the variable is not reaching the container: put it in `backend/.env` or the
  compose-root `.env`, never in the compose `environment:` block.
- The browser bundle only reports if `NEXT_PUBLIC_SENTRY_DSN` was set when
  `next build` ran (`FRONTEND_SENTRY_DSN` for the compose image). Rebuild after
  changing it.
- Prove the pipeline with `SENTRY_ENABLE_TEST_ROUTE=true` and
  `curl -i http://localhost:3001/observability/sentry-test`, or run the local
  sink in `scripts/sentry-sink.mjs`. Details in [observability.md](observability.md).

## Useful checks

```bash
npm run build --prefix backend
npm run build --prefix frontend
npm run lint --prefix frontend
```

For test commands and contribution expectations, see
[Contributing](../CONTRIBUTING.md#testing).
