# Going permanent on Vercel — exact steps

The temporary Cloudflare **quick tunnel** (`*.trycloudflare.com`) cannot be made
permanent: the hostname is random, it changes on every restart, and it only
exists while this PC is on and `cloudflared` is running. Moving to a real host
is the only fix — and it also switches ON every cron in `vercel.json`, which
currently never runs (Vercel crons only fire on a Vercel deployment).

## What this fixes

| Problem today | After deploying |
|---|---|
| Webhook URL changes on every restart → Zernio comment/DM events POST into a dead origin | Permanent URL; `/api/cron/sync-endpoints` re-points the Zernio webhooks automatically every 10 min |
| PC must stay on | Runs in the cloud |
| **No cron ever runs** — `vercel.json` has 10 crons (ads sync, social posts/stories, follow-ups, calendly, domain provisioning, bridge repair) and none of them fire locally | All 10 run |
| `ad_performance` is always empty → the finance gate permanently returns `pending_human` | `/api/ads/sync` (`*/30`) actually writes performance |
| Empty Meta stats in the dashboard | Real spend/impressions/clicks/CTR |
| A new user clicking "Connect Facebook" needs the PC on | Works for anyone, anywhere |

## Steps

### 1. Log in (you run this — interactive, do not share a token)
```powershell
cd D:\harness-session\src-infomist\infomist
npx vercel login
```

### 2. First deploy (gets us the permanent URL)
```powershell
npx vercel --prod
```
Accept the defaults; when asked, link to a new project named `infomist`.

### 3. Set the environment variables
Every name below must exist in **Production** (Vercel → Project → Settings →
Environment Variables). Values are the ones already in `.env.local`.

**Required**
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
GEMINI_API_KEY
GEMINI_MODEL
ZERNIO_BASE_URL
ZERNIO_API_KEY_GOOGLE_META
ZERNIO_API_KEY_TIKTOK_INSTAGRAM
ZERNIO_WEBHOOK_SECRET
CRON_SECRET
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
MAILGUN_API_KEY
MAILGUN_API_BASE_URL
MAILGUN_WEBHOOK_SIGNING_KEY
HOSTINGER_API_KEY
HOSTINGER_BASE_URL
HOSTINGER_PAYMENT_METHOD_ID
HOSTINGER_WHOIS_PROFILE_ID
CALENDLY_CLIENT_ID
CALENDLY_CLIENT_SECRET
CALENDLY_WEBHOOK_SIGNING_KEY
PUBLIC_APP_URL                = https://<the production domain from step 2>
CALENDLY_OAUTH_REDIRECT_URI   = https://<same domain>/api/calendly/callback
```

**Must NOT be set in production**
```
DEV_AUTOLOGIN_EMAIL       # local-only auto-login
DEV_AUTOLOGIN_PASSWORD
ALLOW_UNSIGNED_WEBHOOKS
```

> `CALENDLY_OAUTH_REDIRECT_URI` currently points at `http://localhost:3000/...`.
> Left as-is in production it sends every Calendly connect back to localhost.
> `PUBLIC_APP_URL` is what the Zernio connect flow uses, and
> `resolveAppOrigin()` returns it unconditionally when `NODE_ENV=production`.

### 4. Redeploy so `PUBLIC_APP_URL` takes effect
```powershell
npx vercel --prod
```

### 5. Re-point the bridge at the permanent URL
```powershell
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/sync-endpoints
```
Idempotent. It re-registers the Zernio webhook subscriptions (both key groups)
at `https://<domain>/api/webhooks/zernio` and re-points every Twilio number's
VoiceUrl. It also runs on its own every 10 minutes afterwards.

### 6. Update the third-party dashboards
| Provider | What to change |
|---|---|
| **Zernio** | Nothing — `/api/cron/sync-endpoints` does it. Optionally delete the dead `trycloudflare.com` subscription. |
| **Stripe** | Add webhook endpoint `https://<domain>/api/webhooks/stripe` (events: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_failed`), then update `STRIPE_WEBHOOK_SECRET`. |
| **Calendly** | Add `https://<domain>/api/calendly/callback` to the OAuth app's redirect URIs. |
| **Mailgun** | Point the catch-all route at `https://<domain>/api/webhooks/mailgun`. |

### 7. Apply the pending SQL (still required, unrelated to hosting)
Run these in the Supabase SQL editor — without them the finance gate and the
stats pipeline stay broken no matter where the app is hosted:
1. `supabase/fix_decide_ad_finance_prior_ads.sql`
2. `supabase/sync_ad_performance_rpc.sql`
3. `supabase/add_ad_launch_details.sql`

## Caveat: video ads on the Vercel Hobby plan

A Veo clip takes 1–3 minutes to render, and `/api/ads/[platform]` declares
`maxDuration = 300`. **Hobby caps a function at 60 seconds**, so on Hobby a
video ad would time out mid-render (the ad would be marked `error`; nothing is
spent, because the creative is generated long before the ad is created).

Options: use Pro (300s allowed), or move video rendering to a background job
(create the draft immediately, render the clip, attach it before publish).
Image ads are unaffected — the image model returns in a few seconds.

## Automatic outreach (cron)

Two crons send email on their own; both authenticate with `CRON_SECRET` (Vercel sends it as the Bearer token).

| Cron | Path | Schedule | Enabled by |
|---|---|---|---|
| Initial outreach | `/api/campaigns/send-daily-batch` | hourly | always on once deployed (daily cap per client, verified mailbox only) |
| Follow-ups | `/api/cron/follow-ups` | hourly | **`FOLLOW_UP_CRON_ENABLED=true`** in the Vercel project env; without it the run reports `paused` and sends nothing |

Set `FOLLOW_UP_CRON_ENABLED=true` in production when you are ready for follow-ups to go out automatically.
`send-daily-batch` sleeps 15–60 s between sends and declares `maxDuration = 300`, so it needs the Pro plan (Hobby caps at 60 s).

### Which leads are auto-sent

`/api/campaigns/send-daily-batch` only emails leads that (a) came from the lead-gen form (`lead_source = "ai_prospecting"`), (b) are on the client's active monthly campaign, and (c) if `AUTO_SEND_LEADS_SINCE` is set (ISO date, e.g. `2026-09-26T00:00:00Z`), were created at or after it. Leads saved by default elsewhere (the monthly saved-ICP campaign, imports, older generations) are never auto-sent. An unparsable `AUTO_SEND_LEADS_SINCE` sends nothing. Set it to the moment you deploy this.
