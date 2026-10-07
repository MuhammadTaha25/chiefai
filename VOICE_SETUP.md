# Voice agent setup

How the phone number, the AI agent, and this app fit together — and exactly what
has to be configured for each piece to work.

```
Client buys a number  ──▶  app (state machine)  ──▶  n8n  ──▶  Twilio  (buys the number)
                                                      └──▶  ElevenLabs (imports it, attaches the agent)

Client rings the number ──▶  ElevenLabs agent  ──▶  POST /api/voice/facts  ──▶  Supabase (that tenant only)

Daily 6pm  ──▶  /api/cron/voice-daily-call  ──▶  n8n  ──▶  Twilio (dials the owner)
```

The app **never holds Twilio or ElevenLabs credentials**. n8n does, and the app
calls one authenticated webhook. That is deliberate: the credentials stay in one
place, and the app can be reasoned about without them.

## 1. Environment variables

### This app

| Variable | Required | Purpose |
|---|---|---|
| `ELEVENLABS_AGENT_ID` | yes | the shared voice agent every provisioned number is assigned to |
| `N8N_BASE_URL` | yes | base URL of the n8n instance |
| `N8N_WEBHOOK_SECRET` | yes | sent as `X-Webhook-Secret`; n8n must reject anything else |
| `VOICE_FACTS_SECRET` | yes | shared secret the agent presents on `/api/voice/facts` and `/api/webhooks/voice`. Falls back to `N8N_WEBHOOK_SECRET` |
| `VOICE_PURCHASE_ENABLED` | yes (to spend) | must be exactly `true`. Gates **both** buying a number and placing calls |
| `VOICE_COUNTRY_CODE` | no | default `US` |

### n8n

| Variable | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account |
| `TWILIO_AUTH_TOKEN` | Twilio auth (or an API Key SID/Secret pair) |
| `ELEVENLABS_API_KEY` | importing the number into ElevenLabs |

> Until `N8N_WEBHOOK_SECRET` is set and `VOICE_PURCHASE_ENABLED=true`, the
> buy-number route answers "unavailable" and the daily-call cron reports exactly
> which variable is missing. Nothing half-happens.

## 2. The n8n workflow contract

The app calls **one** webhook and one action per request:

```
POST  {N8N_BASE_URL}/webhook/infomist-voice-provider
header  X-Webhook-Secret: {N8N_WEBHOOK_SECRET}
body    { action, ... }
reply   { ok: true, ... }
```

| `action` | Request fields | Must reply with |
|---|---|---|
| `search` | `country_code` | `phone_number` (voice-capable, available) — reads only |
| `find_owned` | `friendly_name` | `found`, `phone_number`, `sid` — reads only |
| `purchase` | `phone_number`, `friendly_name`, `confirm_purchase: "yes"` | `phone_number`, `sid` — **spends money** |
| `import_elevenlabs` | `phone_number`, `agent_id`, `label` | `phone_number_id` |
| `place_call` | `from`, `to`, `agent_id`, `metadata`, `confirm_purchase: "yes"` | `call_sid` — **spends money** |

`place_call` is the newest action and the one most likely to be missing — the
daily report call cannot work without it. `metadata` should be echoed onto the
call so `/api/webhooks/voice` can attribute the resulting row
(`{ client_id, reason: "daily_report", slot }`).

Every reply must set `ok: false` with an `error` string on failure, and may set
`provider: "twilio" | "elevenlabs"` so the app can classify the failure.
`dry_run: true` in a reply is treated as "did not really happen".

## 3. Endpoints the voice agent calls

Both authenticate with `x-voice-secret: {VOICE_FACTS_SECRET}` and resolve the
tenant from **the number that was dialled** — never from anything the caller
says.

### `POST /api/voice/facts` — the agent's data tool

```jsonc
// summary (the daily report, and "how are things going")
{ "called_number": "+13853363013" }

// or an answer to a specific question
{ "called_number": "+13853363013", "question": "how much did I spend on ads?" }
```

`called_number` is also accepted as `to` / `To` / `phone_number`. Read the
`spoken` field back to the caller — it is written to be spoken.

Returns `spoken`, plus `client_id` (`null` when the number is not linked, in
which case the agent should say so and read nothing).

### `POST /api/webhooks/voice` — call recording

Point the Twilio status callback and the ElevenLabs post-call webhook here.
Accepts JSON or form-encoded, and both providers' field namings
(`CallSid`/`call_sid`, `CallStatus`/`status`, `CallDuration`, `RecordingUrl`,
`Transcript`, `Summary`). One row per call SID, so repeated events update rather
than duplicate.

## 4. Database

Run `supabase/add_voice_agent.sql` in the Supabase SQL editor. It adds:

- `clients.personal_phone_number`, `daily_call_enabled`, `daily_call_time`,
  `daily_call_timezone`, `daily_call_last_slot`, `daily_call_last_at`
- call columns on `client_calls` (status, from/to, transcript, summary, …)
- indexes and RLS so a client sees only their own calls

`client_phone_numbers` already exists and is what the app buys into.

## 5. What the agent may and may not say

`/api/voice/facts` is grounded in read-only aggregates for one tenant
(`src/lib/company-facts.ts`) plus the business profile. Two things matter:

- **Actual ad spend and ROI are `null` until the performance sync has recorded
  something** (`ad_performance` is empty today — no campaign has been confirmed
  by the provider). The agent is told to say it does not have the figure rather
  than invent one.
- **ROI is company-wide won revenue over ad spend**, not revenue proven to come
  from the ads, and the payload says so in `roi_basis` so the agent can qualify
  it out loud.

## 6. The bridge (keeping the outside pointed at this app)

Everything external has to know this app's public origin: the Mailgun catch-all
route, the Zernio webhook subscriptions, the Stripe and Calendly endpoints, and
**every Twilio number's VoiceUrl**. That set of references is "the bridge".

A quick tunnel (`cloudflared tunnel --url …`, ngrok without a reserved domain)
gets a **new URL every restart**, and the moment it changes the bridge breaks
*silently*: Zernio keeps POSTing comment/DM events to a dead host, and calling a
number you bought reaches nothing.

### It repairs itself

```
POST /api/cron/sync-endpoints        (Authorization: Bearer $CRON_SECRET)
```

reads the current `PUBLIC_APP_URL` and re-points:

- **Zernio** — updates the webhook subscription in each API-key group to
  `$PUBLIC_APP_URL/api/webhooks/zernio` (creating it if none exists).
- **Twilio** — sets `VoiceUrl` on every active number in `client_phone_numbers`.

It is **idempotent** (anything already correct is reported `already-correct` and
left alone) and it reports whether the origin is actually reachable from
outside, so a tunnel that is up but serving an error page is visible rather than
assumed healthy.

Numbers whose `elevenlabs_phone_number_id` is a real `phnum_…` are **skipped** —
those were deliberately imported into ElevenLabs and re-pointing them would take
them away from that agent.

It runs on a schedule (see `CRONS.md` — `vercel.json` declares no crons), and locally:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-tunnel.ps1
```

which starts the tunnel, writes the new URL into `.env.local`, then calls the
sync.

### Making the URL permanent

Self-healing covers drift, but if you want an origin that **never changes**:

| Option | What it needs | Survives the PC being off |
|---|---|---|
| **Cloudflare named tunnel** | a Cloudflare account, a domain on it, and `cloudflared tunnel login` — then `cloudflared tunnel create infomist` + a DNS route. Gives `https://voice.yourdomain.com` forever. | No — the tunnel still forwards to your machine |
| **Deploy the app (Vercel)** | a Vercel account; crons are NOT in `vercel.json`; add them via an external scheduler (see `CRONS.md`). Gives `<project>.vercel.app` (or your domain). | **Yes** |
| **ngrok reserved domain** | an ngrok account and its authtoken (`ngrok config add-authtoken …`) | No |

None of these can be set up without an account of your own — which is why the
self-healing sync is the part that ships.

## 7. Wiring checklist

1. Run `supabase/add_voice_agent.sql`
2. Set `N8N_WEBHOOK_SECRET`, `VOICE_FACTS_SECRET`, `VOICE_PURCHASE_ENABLED=true`
3. Make sure the n8n workflow exists, is **active**, and handles `place_call`
4. In ElevenLabs, attach `/api/voice/facts` as a tool on the agent, sending the
   dialled number
5. Point the Twilio status callback and the ElevenLabs post-call webhook at
   `/api/webhooks/voice`
6. Buy a number from **Phone** in the sidebar, then call it

## 8. Live Gemini voice (current path)

Calls are answered by **Gemini 2.5 native audio** (`gemini-2.5-flash-native-audio-latest`),
multilingual and interruptible, through a WebSocket bridge:

```
Twilio call ─▶ /api/voice/twiml ─▶ <Connect><Stream wss://APP/api/voice/stream>
   ─▶ (Next rewrite) ─▶ src/lib/voice/bridge.ts :8787 ─▶ Gemini Live
                                        └─▶ /api/voice/live  (report, questions, saves transcript)
```

- Starts automatically with `next dev` / `next start` (instrumentation.ts). **Cannot run on
  Vercel serverless** — host the app on a long-lived Node server, or run the bridge elsewhere
  and set `VOICE_STREAM_URL=wss://…/stream`.
- Env (all optional): `VOICE_GEMINI_MODEL`, `VOICE_GEMINI_VOICE` (default Kore), `VOICE_BRIDGE=off`
  (falls back to the old Polly flow), `VOICE_ALLOW_ANY_CALLER=true`.
- **Inbound calls only read data to the owner's saved mobile** (caller-ID match). Anyone else hears "this line is private".
- The daily call fires at the chosen local time (2-hour grace window, once per day). The in-app
  scheduler runs the `voice` job by default.
- Brief content: emails today per mailbox, social posts with times, domains, leads, replies, deals.
- **On Vercel** the bridge cannot run. Calls automatically use the spoken-report (Polly) flow instead of the live
  stream, unless `VOICE_STREAM_URL` points at a bridge hosted elsewhere. Inbound calls in that flow are always
  caller-ID checked (the PIN is only asked inside the live stream).
- **The daily call needs a scheduler.** Vercel does not run it (`vercel.json` has no crons): add
  `GET /api/cron/voice-daily-call` to cron-job.org (hourly, `Authorization: Bearer $CRON_SECRET`). Check it with
  `?dry_run=1&hour=16` first.
- **Twilio prerequisites:** enable Voice Geographic Permissions for Pakistan (+92) in the Twilio
  console, and on a trial account verify the destination mobile.
