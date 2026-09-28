# Infomist — Meta Ads + Finance Approval + Social Agent + Lead Nurture: Full Build Spec

This is the consolidated, structured spec derived from the raw requirements. Use this as the
single source of truth for building/handing off this module. Everything here must ship with QA
before being marked done.

---

## 1. Meta Ads Creation Flow

**Trigger:** Client wants to run a Meta (Facebook/Instagram) ad.

**Steps:**
1. Client's Meta card/payment method is already connected via Zernio (existing OAuth flow,
   see `src/app/api/zernio/*`).
2. Agent asks the client (via chat/form) for ad requirements:
   - Budget (daily or total spend)
   - Ad objective / what to advertise
   - Target audience basics (if not already known from onboarding ICP data)
3. Agent creates the ad (draft) via Zernio's ads API using the given budget.
4. Ad audit runs automatically before it's allowed to spend:
   - Creative check (copy, image/video quality, CTA present, compliance issues)
   - Targeting sanity check (audience size not too narrow/broad, matches ICP)
   - Budget sanity check (matches what client asked for)
5. Audit produces a verdict: **good** / **needs fixing**.
   - If "needs fixing" → agent revises the ad copy/creative/targeting automatically (this is the
     "fix it by piecing the ad together again" step), then re-audits. Loop until it passes or a
     max retry count is hit (flag to a human if it never passes).
6. Once audit passes, ad goes to **Finance Department approval** (see §2) before it actually spends.

## 2. Finance Approval Gate (Ledger Logic)

**Rule:**
- **First ad ever for a client** → Finance auto-approves. No prior spend/analytics exist yet, so
  there's nothing to evaluate — it just gets a ledger entry and goes live.
- **Second ad onward** → Finance looks at the **performance analytics of the previous ad(s)**
  before approving:
  - If previous ad performance is good (define thresholds: e.g. CTR, CPL, conversion rate vs.
    client's stated goal) → approve, ad goes live.
  - If previous ad performance is bad → **block** the new ad spend. Do not let it go live.
- This is a ledger-based gate: every ad has a row/state (`pending_finance`, `approved`, `rejected`)
  and every approval decision is logged with the reason (which prior ad's analytics drove it).
- Finance approval must happen **at ad-set time**, before the ad is turned on to actually spend
  money on Meta.

## 3. Supabase Schema (Ads + Finance Ledger)

Design tables to support the above. At minimum:

- `ad_campaigns`
  - `id`, `client_id`, `platform` (meta/google_ads/etc.), `objective`, `requested_budget`,
    `status` (`draft`, `pending_audit`, `audit_failed`, `pending_finance`, `approved`,
    `rejected`, `live`, `paused`), `zernio_ad_id`, `created_at`
- `ad_audits`
  - `id`, `ad_campaign_id`, `verdict` (`good`/`needs_fix`), `issues` (jsonb: creative/targeting/budget
    problems found), `revision_number`, `created_at`
- `ad_finance_decisions`
  - `id`, `ad_campaign_id`, `decision` (`approved`/`rejected`), `reason`,
    `based_on_prior_ad_id` (nullable — null for first-ever ad), `decided_at`
- `ad_performance` (pulled from Zernio analytics periodically)
  - `id`, `ad_campaign_id`, `impressions`, `clicks`, `spend`, `leads`, `ctr`, `cpl`,
    `is_good` (derived flag used by the next ad's finance decision), `synced_at`

Logic: "first ad → allow" and "2nd+ ad → check prior `ad_performance.is_good` → allow/block" lives
as a Postgres RPC (mirrors the existing `decide_budget_request` RPC pattern already in this repo)
so it's auditable and can't be bypassed from the client.

## 4. Social Media Connect → Business Info Capture

When a client connects a social account (existing flow: `src/app/api/zernio/connect`), immediately
after connecting, collect business info needed for the agent to act on their behalf:
- What the business does / niche
- Brand tone/voice
- What kind of content to post
- How the agent should respond to comments and DMs (tone, escalation rules) — this is the
  RAG-style behavior config Zernio already supports by default; we just need to collect the
  inputs from the user and save them so Zernio's agent uses them.

Store this against the client + platform in Supabase (new table, e.g. `social_agent_config`)
so it can be passed to Zernio's response-agent config.

## 5. Posting Schedule Enforcement

- Agent must post **exactly** the number of posts/week the client agreed to — not more, not less,
  not "whenever it feels like it."
- Stories: fixed daily schedule — **10:00 AM** and **9:00 PM**, every day.
- Build a scheduler/cron check that:
  - Tracks posts made this week vs. target and stops/starts the agent accordingly.
  - Enforces the two fixed story times daily.
- This needs a monitoring job so if the agent under/over-posts, it's caught and corrected.

## 6. Domain Purchase Flow (Stripe Sandbox + Hostinger)

1. User clicks "Buy Domain" on the frontend.
2. Backend searches real-time domain availability via **Hostinger API**.
3. User picks one, clicks buy → Stripe (sandbox mode) charges **$15** to our account.
4. Since Stripe is sandbox, use a fixed sender for now: `sales@raisingbeing.com`.
5. On successful purchase, actually register the domain via Hostinger API.

## 7. Mailgun Mailbox + Lead Nurture Sequence

1. After domain purchase, create a mailbox on that custom domain via **Mailgun**.
2. That mailbox is used to run outreach: a lead-capture form (linked from ads → landing page)
   feeds leads in.
3. **Daily**, email **5 leads** from the pool.
4. Each lead gets **at least 3 follow-up emails** if they don't respond.
5. When a lead **does** respond, the agent classifies the reply:
   - **Happy** → move them toward booking (send Calendly link).
   - **Angry** → shift tone (de-escalate, adjust messaging) and continue nurturing.
   - **Booking-intent** → send Calendly link directly.

## 8. Calendly Integration

- Frontend: each client gets a "Connect Calendly" button (same pattern as the existing social
  "Connect" buttons) in settings.
- Once connected, interested leads who reach booking-intent get sent that client's Calendly link
  to schedule.

## 9. Ads → Landing Page → Lead Capture

- Every ad points to a landing page.
- Landing page has a lead form; submissions become rows in the leads table (already exists per
  the dashboard structure — `src/app/(dashboard)/leads`).
- Captured leads automatically enter the email nurture sequence from §7.

## 10. Owner/Client Dashboard (Reporting) — Mandatory

Frontend dashboard must show, per client, live from Supabase:
- Ad spend (total + per campaign), audit verdicts, finance approve/reject history
- Social posts published vs. scheduled (weekly target compliance), story posting compliance
- Emails sent today / follow-ups sent / responses received
- Lead sentiment breakdown (happy / angry / booking-interested)
- Bookings made via Calendly
- Daily summary: emails sent, follow-ups sent, responses received (owner-facing daily report)

## 11. Known Bugs to Fix Before/During This Build

- **DM agent repeats itself**: agent is re-sending the same rebuilt message on every DM instead of
  progressing the conversation — fix the dedup/state-tracking so it doesn't resend.
- **Auto-commenting not working**: agent is not automatically replying to comments at all — debug
  why the comment-response path isn't firing (check Zernio webhook wiring for comment events).

## 12. QA Requirement (Non-Negotiable)

After every part of this is built, run through and verify end-to-end:
- [ ] Ad creation → audit → fix loop → finance gate (both first-ad-auto-approve and
      second-ad-analytics-gate paths) → ad goes live only when approved
- [ ] Finance correctly blocks spend when prior ad performance is bad
- [ ] Social connect flow captures and saves business info + agent behavior config
- [ ] Weekly post count enforced; story posts fire at 10am and 9pm daily
- [ ] Domain search (Hostinger) + Stripe sandbox purchase completes and mailbox is provisioned
      via Mailgun
- [ ] 5 leads/day emailed, 3 follow-ups per non-responder enforced
- [ ] Sentiment classification correctly routes happy/angry/booking replies
- [ ] Calendly connect button works and booking link is sent at the right moment
- [ ] Landing page lead capture → lead appears in dashboard → enters nurture sequence
- [ ] Dashboard shows real, live numbers for all of the above (spend, posts, emails, follow-ups,
      responses, sentiment, bookings)
- [ ] DM duplicate-message bug confirmed fixed
- [ ] Auto-commenting confirmed working
