#  Infomist

Client-facing web app for Infomist. Next.js (App Router) + Supabase Auth/Postgres.
All automation and AI decision-making lives in n8n — this app only renders live
Supabase data and calls n8n webhooks; it does not reimplement any business logic.

## Env vars

Copy `.env.local` and fill in real values:

| Var | Where it's used | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | `https://timfpxablcdgwrkucrjj.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | publishable/anon key, respects RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | bypasses RLS — never expose to the browser. Used only in `src/lib/supabase/admin.ts` (finance RPC + Zernio callback) |
| `N8N_BASE_URL` | server only | `https://n8n-vmc7.srv1664783.hstgr.cloud` |
| `N8N_WEBHOOK_SECRET` | server only | not yet set — n8n webhooks currently have `authentication: none`. Add a shared secret to the webhooks and set this before production traffic |
| `ZERNIO_BASE_URL` | server only | `https://zernio.com/api/v1` |
| `ZERNIO_OAUTH_REDIRECT_URI` | server only | must match what's registered with Zernio; update for prod domain |

## Structure

- `src/app/(auth)` — login/signup (Supabase Auth, email+password)
- `src/app/onboarding` — 4-step wizard (ICP, marketing plan, connect accounts, domain/mailbox)
- `src/app/(dashboard)` — authenticated app shell: dashboard, leads, content, finance, projects, settings
- `src/app/api/n8n/*` — the ONLY callers of n8n webhooks. Each resolves `client_id` server-side from the Supabase session; never trust one from the request body
- `src/app/api/zernio/*` — Zernio OAuth connect + callback (the one piece of Zernio integration that wasn't already built in n8n)
- `src/app/api/finance/decide` — calls the `decide_budget_request` Postgres RPC via the service-role client
- `src/lib/supabase/{client,server,admin}.ts` — browser, server (RLS-scoped), and admin (service-role) Supabase clients
- `src/middleware.ts` — refreshes the Supabase session and redirects unauthenticated users away from protected routes

## Known gaps (flagged per the build brief)

- **n8n webhook auth**: webhooks are currently open (no auth). Add header/shared-secret auth on the n8n side and set `N8N_WEBHOOK_SECRET` here before production traffic.
- **Zernio OAuth callback contract**: the exact query params Zernio's redirect sends back weren't specified — `src/app/api/zernio/callback/route.ts` guesses common param names (`account_id`/`zernio_account_id`, `profile_id`/`zernio_profile_id`). Confirm the real contract with Zernio and adjust.
- **Content calendar isolation**: `webhook/instagram-content-calendar` is still backed by an n8n Data Table for the calendar itself, not fully per-tenant in Supabase yet.
- **Calendly booking confirmation, Ads Creative Brief backend, dedicated PM/QA/Dev agents**: not built (n8n-side, out of this app's scope per the brief).

## Running locally

```bash
npm install
npm run dev
```
