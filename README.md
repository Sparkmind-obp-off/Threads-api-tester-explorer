# Threads API Test Explorer

Developer console for validating a Meta Threads API integration on Cloudflare Pages with a Hono server-side backend.

## Completed

- `GET /api/health` reports deployed backend health.
- `GET /api/config/status` reports boolean configuration readiness without exposing secrets or tokens.
- Frontend displays `SERVER READY` or `SERVER ERROR` and visible backend diagnostics.
- App Secret and OAuth token remain server-side.
- Existing OAuth and API explorer implementation is preserved; OAuth should not be started until health and configuration checks pass.

## Routes

- `/` — Threads API Test Explorer UI
- `/api/health` — backend health JSON
- `/api/config/status` — safe configuration readiness JSON
- `/api/session` — ephemeral session status
- `/api/presets` — supported request presets
- `/oauth/callback` — existing OAuth callback

## Environment

Configure these only as Cloudflare Pages server-side secrets/environment variables:

- `THREADS_APP_ID`
- `THREADS_APP_SECRET`
- `THREADS_REDIRECT_URI`

Optional: `OAUTH_SESSION_KEY`.

## Local Verification

```bash
npm install
npm run typecheck
npm run build
npm run dev:sandbox
```

Then check `http://localhost:3000/api/health` and `http://localhost:3000/api/config/status`.

## Deployment

- Platform: Cloudflare Pages
- Production: https://threads-api-test-explorer.pages.dev/
- GitHub: https://github.com/Sparkmind-obp-off/Threads-api-tester-explorer
- Storage: no persistent database; OAuth test data uses encrypted, short-lived HttpOnly cookies.

## Not Implemented / Next Step

Do not begin OAuth testing until production health returns `ok: true` and configuration reports `oauthReady: true`. After those checks pass, OAuth can be validated separately.
