# ChiefAI — Complete End-to-End System Audit

**Scope:** Read-only analysis. No code was modified, no files created/deleted, no migrations run.
**Method:** 6 parallel codebase audits (Domain→Mailgun→Mailbox, Lead-gen→Outreach→Follow-up, Calendly, Social, Ads, Security/Webhooks/Cron). Every claim below is backed by file:line citations from the actual codebase.

---

## SECTION A — EXECUTIVE SUMMARY

**Overall completion estimate: ~70% of the intended end-to-end journey is genuinely wired and working. The system is well-engineered in the parts that exist (strong idempotency, tenant isolation, atomic claims almost everywhere) but has real gaps that block a brand-new customer from completing the full journey unattended today.**

### Major WORKING areas
- Domain purchase → Stripe → Hostinger → DNS → Mailgun → Mailbox provisioning chain (self-healing, well-guarded against duplicate charges/races).
- Lead deduplication, mailbox selection/daily limits, duplicate-send prevention (atomic claims on every send path).
- Follow-up cron logic itself (3-day default, stop conditions, atomic claiming) — correct code.
- Mailgun inbound reply handling (signature verification, threading, dedup).
- Calendly OAuth connect, booking-link delivery, and — contrary to initial assumption — a **working booking-confirmation webhook** that cancels follow-ups on booking.
- Social (Instagram/Facebook): business-context-grounded AI content generation, scheduling with real anti-duplication, comments and DMs are genuinely wired end-to-end (webhook → AI → real provider send), not just configuration.
- Ads: AIDA framework is genuinely enforced in the prompt; finance gate correctly blocks spend before any Meta object is created; provider-state reconciliation (sync job) exists.
- Multi-tenant isolation: consistently correct across almost every route and webhook sampled — this is a genuine strength of the codebase.

### Major BROKEN / BLOCKED areas
- **`EXPLORIUM_API_KEY` is empty** in `.env.local` → lead generation is currently **dead** unless Frontage Leads or Vibe Prospecting MCP connections are configured instead. No leads = no outreach = the entire funnel never starts for a new client relying on AI prospecting.
- **`vercel.json` is literally `{}`** — zero cron schedules registered. Follow-ups, daily voice calls, domain-provisioning retries, social-initial validation, and ads performance sync **do not fire automatically on Vercel** today, unless an external scheduler (e.g. n8n) is independently calling these routes with `CRON_SECRET`. This needs explicit confirmation — it's either a silent production outage or a deliberate external-scheduler design.
- **Ad creative validation never blocks launch.** `validateAdCreative` findings (off-brief, unsupported claims, wrong offer) are advisory-only warnings; a factually wrong ad can reach "approved/launched" state. The only hard stop is a missing image/video.
- **Meta ad objective is always forced to "Traffic"** regardless of whether the user chose Leads/Sales/Bookings — silently remapped, only surfaced as a warning.
- Social organic automation (comments/DMs/scheduling) only works for **Instagram and Facebook** — LinkedIn/TikTok/YouTube can be OAuth-connected but have no content/comment/DM automation at all.
- **Calendly link overwrite hazard**: OAuth reconnect and manual-paste both write the same `clients.calendly_url` column with no conflict detection — either can silently clobber the other.
- No anti-repeat guard on sending the same Calendly link to the same lead multiple times across replies.
- Automated initial outreach emails are **templated**, not fully AI-personalized per lead (only the once-per-batch "offer phrase" uses AI) — genuine personalization only exists in manual drafts, follow-ups, and auto-replies.

### Highest-risk issues (see Section M for full ranking)
1. Lead generation blocked by missing API key (P0 — nothing downstream can start).
2. Crons not registered in `vercel.json` (P0/P1 depending on whether n8n actually covers this).
3. Ad content validation doesn't block launch — factually wrong ads can go live (P1).
4. Calendly URL overwrite race between OAuth and manual paths (P2).
5. Ad objective silently forced to Traffic regardless of user's real goal (P2).

---

## SECTION B — MASTER FEATURE MATRIX

| Feature | Status | Frontend | Backend | DB | Provider | Automation | End-to-End | Evidence |
|---|---|---|---|---|---|---|---|---|
| Domain search | WORKING | ✅ | ✅ | — | ✅ Hostinger real-time | N/A | ✅ | `src/app/api/domains/search/route.ts` |
| Domain purchase/payment | WORKING | ✅ | ✅ | ✅ | ✅ Stripe | ✅ webhook | ✅ | `src/app/api/domains/checkout`, `webhooks/stripe/route.ts:28-124` |
| Hostinger registration | WORKING | — | ✅ | ✅ | ✅ | ✅ | ✅ (except ICANN email click) | `src/lib/domain-registration.ts:12-208` |
| DNS provisioning | WORKING | — | ✅ | ✅ | ✅ | ✅ cron self-heal | ✅ | `src/lib/provision-core.ts:37-84` |
| Mailgun domain verify | WORKING | — | ✅ | ✅ | ✅ | ✅ cron reconcile | ✅ | `provision-core.ts`, `cron/domain-provisioning/route.ts:188-223` |
| Mailbox creation | PARTIALLY WORKING | ✅ | ✅ | ✅ | ✅ | — | ✅ | `src/app/api/domains/mailboxes/route.ts` — no global per-client cap |
| Lead-gen form | WORKING | ✅ | ✅ | — | — | — | ✅ | `src/lib/form-schema/lead-gen-schema.ts` |
| AI criteria interpretation | PARTIALLY WORKING | — | ✅ | ✅ | ✅ Gemini | — | ⚠️ | `src/lib/gemini.ts:399-425` — company-size/industries can be silently substituted |
| Prospect provider | **BLOCKED BY CONFIG** | — | ✅ | — | ❌ key missing | — | ❌ | `.env.local:34` `EXPLORIUM_API_KEY=` empty |
| Lead deduplication | WORKING | — | ✅ | ✅ unique index | — | — | ✅ | `src/lib/prospect-dedupe.ts`, `supabase/add_leads_unique_email.sql` |
| Lead → first email | PARTIALLY WORKING | — | ✅ | ✅ | ✅ Mailgun | ✅ `after()` | ⚠️ templated | `src/app/api/leads/generate/route.ts:227-236`, `src/lib/outreach-template.ts` |
| Email replies (inbound) | WORKING | — | ✅ | ✅ | ✅ Mailgun | ✅ webhook | ✅ | `src/app/api/webhooks/mailgun/route.ts` |
| Follow-ups (logic) | WORKING | — | ✅ | ✅ | ✅ | ⚠️ cron gated | ⚠️ | `src/lib/follow-ups.ts`, `src/lib/follow-up-config.ts:12` (3-day default correct) |
| Follow-up cron trigger | **BLOCKED BY CONFIG** | — | ✅ | — | — | ❌ not in vercel.json | ❌ | `vercel.json` = `{}`; also needs `FOLLOW_UP_CRON_ENABLED=true` |
| Interested → Calendly link | WORKING | — | ✅ | ✅ | — | ✅ | ✅ | `webhooks/mailgun/route.ts:277-406` |
| Calendly OAuth connect | WORKING | ✅ | ✅ | ✅ | ✅ | — | ✅ | `src/app/api/calendly/{connect,callback}/route.ts` |
| Calendly booking confirmation | WORKING | — | ✅ | ✅ | ✅ webhook+poll fallback | ✅ | ✅ | `src/app/api/webhooks/calendly/route.ts`, `src/lib/calendly-bookings.ts` |
| Social connect (IG/FB) | WORKING | ✅ | ✅ | ✅ | ✅ Zernio | — | ✅ | `src/app/api/zernio/{connect,callback}/route.ts` |
| Social connect (LinkedIn/TikTok/YouTube) | UI ONLY | ✅ | ⚠️ connect only | ✅ | ✅ | ❌ no automation | ❌ | `cron/social-content/[type]/route.ts:29` SUPPORTED=[instagram,facebook] only |
| Social business context | WORKING | ✅ | ✅ | ✅ | — | — | ✅ | `src/lib/business-context.ts:98-310` |
| Social AI content gen | WORKING | — | ✅ | ✅ | ✅ Gemini | ✅ | ✅ | `src/lib/social-ai.ts:31-87` |
| Social scheduling | WORKING | — | ✅ | ✅ dedupe_key | ✅ | ✅ cron 30min | ✅ | `src/lib/social-schedule.ts`, `cron/social-content/[type]/route.ts` |
| Social comments automation | WORKING | ✅ settings | ✅ | ✅ | ✅ Zernio | ✅ webhook | ✅ | `webhooks/zernio/route.ts:195-265` |
| Social DMs automation | WORKING | ✅ settings | ✅ | ✅ | ✅ Zernio | ✅ webhook | ✅ | `webhooks/zernio/route.ts` (no resend bug found) |
| Ads form | WORKING | ✅ | ✅ | ✅ (JSON brief) | — | — | ✅ | `src/components/ads-panel.tsx`, `src/lib/form-schema/ads-schema.ts` |
| Ads AI creative (AIDA) | WORKING | ✅ preview | ✅ | ✅ | ✅ Gemini | — | ✅ | `src/lib/gemini.ts:583-632,704-716` |
| Ads targeting | PARTIALLY WORKING | ✅ | ✅ | ✅ | ✅ Meta/Zernio | — | ⚠️ | interest substitution silent, objective forced to Traffic |
| Ads validation/audit | **BROKEN-BY-DESIGN** | ✅ shows warning | ✅ | ✅ | — | — | ❌ advisory only | `ad-validation.ts`, never blocks `route.ts` progression |
| Ads finance gate | WORKING | — | ✅ | ✅ | — | — | ✅ | `supabase/ad_finance_ledger.sql:75-134` |
| Ads launch (Meta) | WORKING | ✅ separate publish click | ✅ | ✅ | ✅ Zernio | — | ✅ | always created PAUSED, explicit publish step |
| Ads performance sync | WORKING (cron wiring unverified) | — | ✅ | ✅ | ✅ | ⚠️ unverified schedule | ⚠️ | `src/app/api/ads/sync/route.ts` |
| Dashboard/reporting | UNKNOWN (not deeply audited this pass) | ✅ | ✅ | ✅ | — | — | ⚠️ | not in scope of this pass |
| Security/tenant isolation | WORKING | — | ✅ | ✅ RLS + manual filter | — | — | ✅ | see Section I |
| Webhooks (Stripe/Mailgun/Calendly/Zernio) | WORKING | — | ✅ | ✅ | ✅ | — | ✅ | all 4 signature-verified + deduped |
| Cron registration | **BROKEN** | — | ✅ code exists | — | — | ❌ | ❌ | `vercel.json` = `{}` |

---

## SECTION C — END-TO-END FLOW RESULTS

### Flow 1: Domain → Mailgun → Mailbox
**Expected:** purchase → paid → registered → DNS → Mailgun verified → mailbox ready → outbound send eligible.
**Actual:** Confirmed working automatically through the whole chain, including self-healing cron reconciliation for drift. Atomic claims prevent double-charging or double-provisioning on webhook/cron races.
**Result: WORKING** (one unavoidable manual step: ICANN registrant email verification — external to the app, not a bug).
**Exact break point:** None in code. The only human-in-the-loop moment is ICANN's own verification email, which the code detects, surfaces, and auto-resumes from via cron once cleared (`src/lib/domain-registration.ts:100-147`).
**Secondary gap:** no per-client/domain cap on total mailbox count across multiple calls (`src/app/api/domains/mailboxes/route.ts`).

### Flow 2+3: Lead Generation → AI Email → Mailgun Send → Follow-ups
**Expected:** form → AI criteria → prospecting → dedup → leads saved → eligible → emailed → reply tracked → follow-up.
**Actual:** Form and dedup are solid. AI criteria interpretation preserves country/city literally but can silently substitute company-size/industries. **Prospecting is currently non-functional** — `EXPLORIUM_API_KEY` is empty, and even the two alternate paths (Frontage Leads / Vibe Prospecting MCP) need to be confirmed connected. Confirmed: lead generation DOES automatically trigger the first send via `after()` in the same request (`src/app/api/leads/generate/route.ts:227-236`) — not a separate unconnected system as initially suspected. But the initial batch email is a **template with AI-written offer phrasing**, not fully personalized. Follow-up logic itself is correct and safe, but the actual Vercel Cron trigger for it does not exist (see Flow/Section J).
**Result: BLOCKED** at the prospecting step; **PARTIAL** everywhere downstream (logic is correct, but automated cron triggering is unconfirmed/likely disabled).
**Exact break point:** `src/lib/explorium.ts` / `.env.local:34` (empty key) → `src/app/api/leads/generate/route.ts:95` sets status `"blocked_missing_prospecting_key"` and **no leads are ever saved**.

### Flow 4+5: Email Conversation → Interested/Not/No-Response → Calendly
**Expected:** reply → classify → branch (interested/not/no-response) → Calendly link → booking → stop.
**Actual:** 4-way classification (BOOKING/HAPPY/ANGRY/UNCLEAR) is real and working, with explicit unsubscribe handling that runs independent of AI. Calendly link is sent on 3 of 4 branches (not ANGRY). Booking-confirmation webhook genuinely exists, is signature-verified per-tenant, dedupes by event ID, and correctly clears `next_follow_up_at` to stop future follow-ups. **No "SEO fallback" offer for not-interested leads was found anywhere in the code** — this specific business requirement (if real) is NOT IMPLEMENTED.
**Result: WORKING** for the core loop; **NOT IMPLEMENTED** for the SEO-fallback nurture path; **NOT IMPLEMENTED** for anti-repeat Calendly-link sending.
**Exact break point (minor):** `src/app/api/calendly/callback/route.ts:118` and `src/app/api/settings/calendly/route.ts:22` both unconditionally overwrite the same `calendly_url` column — a later Reconnect click can silently erase a manually-pasted custom link.

### Flow 7-18: Social Media Automation
**Expected:** connect → business context → AI content → schedule → publish → comments → DMs, with dedup throughout.
**Actual:** For Instagram/Facebook, this is genuinely working end-to-end including real provider API calls for comment/DM replies (not configuration-only), with solid anti-duplication (`dedupe_key`, unique constraints, insert-then-claim patterns) and verified tenant isolation. For LinkedIn/TikTok/YouTube, OAuth connection works but there is **zero organic content/comment/DM automation** — those platforms are effectively ads-only in this codebase.
**Result: WORKING (IG/FB only); NOT IMPLEMENTED (LinkedIn/TikTok/YouTube organic automation).**
**Known external (non-code) blocker:** Instagram DM automation requires the account owner to manually enable "message access for connected apps" in Instagram's own settings — cannot be done via API (`src/app/api/zernio/callback/route.ts:117-148`). This mirrors the Meta Ads Advertiser-role issue found earlier — external platform permissions are a recurring, unavoidable class of blocker for this app.

### Flow 19-26: Ads / Marketing
**Expected:** form → exact brief preserved → AI creative (AIDA) → targeting → audit → finance → launch → performance.
**Actual:** Nearly every form field is traceable through to the AI prompt and/or the Meta request. AIDA is explicitly and verifiably enforced. The finance gate correctly prevents any Meta object creation before an approve/reject decision, and ads always launch PAUSED requiring a separate explicit publish click — this is the real safety net. However: (1) the content-validation step is advisory-only and never blocks a factually wrong or off-brief ad from reaching "launched" state, (2) interest targeting can be silently substituted with Meta's "closest match" without requiring re-approval (unlike the age/gender widening, which does require explicit approval), (3) campaign objective is always forced to Meta's "Traffic" type regardless of the user's actual goal (Leads/Sales/Bookings), surfaced only as a warning.
**Result: PARTIALLY WORKING** — the pipeline is real and mostly respects the brief, but has multiple silent-drift points and no hard content-quality gate.

---

## SECTION I — SECURITY / TENANT ISOLATION

No P0 or P1 tenant-isolation bugs were found in the sampled code (domains, mailboxes, leads, ads, settings, public/leads, all 4 non-Stripe/Mailgun/Calendly/Zernio-excluded webhook handlers). Consistent pattern confirmed everywhere: `client_id` resolved server-side from session or from a verified provider identity (receiving mailbox, Calendly signing key, Zernio account ID, Stripe metadata cross-check) — **never trusted directly from request body or payload claims.**

RLS policies exist (`supabase/fix_all_client_rls.sql`, `fix_clients_rls.sql`, `harden_clients_privileges.sql`) scoping SELECT by `auth_user_id`, and column-restricting what clients can self-update. Service-role (admin) queries manually filter by `client_id` everywhere sampled — no missing-filter instance found.

**Not independently verified in this pass:** `leads/[id]/*`, `social/*` (beyond Zernio webhook), `voice/*`, `vibe-prospecting/*` subtrees, and `webhooks/voice`/`webhooks/mailgun/events`. These should get a follow-up pass before calling tenant isolation fully verified.

**P3 note:** `clients.calendly_url` write race between OAuth and manual-paste paths (Section C, Flow 4+5) is a data-integrity issue, not a cross-tenant leak — each path still correctly scopes to the acting client's own row.

---

## SECTION J — AUTOMATION / CRON AUDIT

| Automation | Trigger | Registered in `vercel.json`? | Idempotent? | Status |
|---|---|---|---|---|
| `cron/calendly-sync` | poll fallback for non-webhook clients | **No** | ✅ (shares recorder dedup) | Code correct, **not auto-triggered** |
| `cron/domain-provisioning` | retry stuck registrations | **No** | ✅ | Code correct, **not auto-triggered** |
| `cron/follow-ups` | send due follow-ups | **No** | ✅ atomic claim | Also gated by `FOLLOW_UP_CRON_ENABLED` (unset in `.env.local`) — **double-blocked** |
| `cron/social-content/[type]` | scheduled posting | **No** | ✅ dedupe_key | Code correct, **not auto-triggered** |
| `cron/social-initial` | first-connection validation cycle | **No** | ✅ resumable | Code correct, **not auto-triggered** |
| `cron/sync-endpoints` | re-point webhook URLs after tunnel restart | **No** | ✅ | Code correct, **not auto-triggered** |
| `cron/voice-daily-call` | daily report call | **No** | ✅ per-client-per-day key | Code correct, **not auto-triggered** |
| `ads/sync` | reconcile Meta state + performance | not found in this pass | ✅ | **Unverified** whether cron-wired at all |

**`vercel.json` contains only `{}`.** Every cron route defensively implements its own `CRON_SECRET` check as if expecting external triggering — consistent with this project's documented n8n-based automation history. **This needs direct confirmation from the user/team: is n8n (or something else) actually calling these routes on schedule? If not, follow-ups, daily voice calls, and domain-provisioning retries are silently dead in production.**

---

## SECTION L — DUPLICATION / RACE-CONDITION AUDIT

No unmitigated duplicate-send or race condition was found in any of the 6 audits. Every send/claim surface examined uses either an atomic conditional `UPDATE ... WHERE` claim or a unique-constraint insert-as-claim pattern:

- Stripe webhook redelivery → atomic status claim (`webhooks/stripe/route.ts:115-124`).
- Concurrent domain registration (webhook+cron+manual retry) → claim marker with staleness timeout.
- Lead initial send → conditional UPDATE on `status="new"` before send (`send-batch.ts:176-188`).
- Follow-up send → conditional UPDATE matching exact `next_follow_up_at` (`follow-ups.ts:103-120`).
- Mailgun inbound dedup → unique `Message-Id` insert-as-claim (`webhooks/mailgun/route.ts:123-148`).
- Zernio social events → unique `(platform, event_type, external_id)` insert-as-claim (`webhooks/zernio/route.ts:145-158`).
- Calendly booking dedup → unique `calendly_event_id` constraint (`calendly-bookings.ts:154-176`).
- Social post scheduling → unique `dedupe_key` per slot, reserve-then-publish (`cron/social-content/[type]/route.ts:146-166`).

**The one soft gap found:** no global cap on total mailboxes a client can create (repeated calls to the per-request-capped endpoint could accumulate unlimited mailboxes over time).

---

## SECTION M — CRITICAL ISSUES

### P0 — Business-breaking
| ID | Problem | Evidence | Impact |
|---|---|---|---|
| P0-1 | `EXPLORIUM_API_KEY` empty → lead generation produces zero leads | `.env.local:34`, `src/lib/explorium.ts`, `generate/route.ts:95` | No leads = no outreach = funnel never starts for AI-prospecting clients |
| P0-2 | No cron schedules registered in `vercel.json` | `vercel.json` = `{}` | Follow-ups, daily calls, domain-provisioning retries, social scheduling may never fire automatically — needs confirmation of external scheduler |

### P1 — Critical
| ID | Problem | Evidence | Impact |
|---|---|---|---|
| P1-1 | Ad content validation never blocks launch | `ad-validation.ts` warnings only, no gate in `route.ts` | Off-brief, factually wrong, or unsupported-claim ads can go live |
| P1-2 | Follow-up cron double-gated (missing env var) | `cron/follow-ups/route.ts:26-28`, `FOLLOW_UP_CRON_ENABLED` not in `.env.local` | Follow-up emails may never send even if cron is wired |
| P1-3 | Explorium's person/contact-fetch step is unconfirmed even with a key | `src/lib/explorium.ts:1-13,83-101` own code comments admit this | Adding a key may not actually fix lead generation |

### P2 — Important
| ID | Problem | Evidence | Impact |
|---|---|---|---|
| P2-1 | Meta ad objective always forced to "Traffic" | `src/lib/meta-ads.ts:168-174` | Leads/Sales/Bookings campaigns never get true conversion optimization |
| P2-2 | Interest targeting silently substituted, no re-approval required | `meta-ads.ts:707-723` | Audience can drift from brief without the user noticing before publish |
| P2-3 | Calendly URL overwrite race (OAuth vs manual paste) | `calendly/callback/route.ts:118`, `settings/calendly/route.ts:22` | A client's custom booking link can be silently erased |
| P2-4 | No global per-client mailbox count cap | `domains/mailboxes/route.ts` | Unbounded mailbox creation possible over repeated calls |
| P2-5 | `ad_campaigns` status CHECK constraint appears stale vs. actual status strings used in code | `fix_ad_campaigns_status_check.sql` vs `route.ts`/`ads-panel.tsx` | Possible insert failures on valid app-written statuses — needs live-DB verification |
| P2-6 | LinkedIn/TikTok/YouTube social automation not implemented beyond OAuth connect | `cron/social-content/[type]/route.ts:29` | Those platforms are effectively decorative for organic social |

### P3 — Minor
| ID | Problem | Evidence | Impact |
|---|---|---|---|
| P3-1 | No anti-repeat guard for sending the same Calendly link to a lead multiple times | `webhooks/mailgun/route.ts:396-406` | Minor UX annoyance, not a correctness bug |
| P3-2 | Uploaded-creative validator text is stale ("not supported yet") vs. actual working upload path | `ad-validation.ts:213-215` vs `route.ts:751-759` | Confusing warning shown to users, not an actual limitation |
| P3-3 | Dead/unused shuffle() randomization left in `send-batch.ts` | `send-batch.ts:30-38` | Code cleanliness only |
| P3-4 | No "SEO fallback" nurture path for not-interested leads | searched, not found anywhere | Only relevant if this was an actual product requirement |

---

## SECTION N — WHAT IS ACTUALLY READY FOR PRODUCTION?

### SAFE / WORKING
- Domain purchase → mailbox provisioning chain
- Lead deduplication, mailbox selection, daily send limits
- Mailgun inbound reply handling, threading, dedup
- Follow-up business logic (code is correct; see gating issues below)
- Calendly OAuth connect + booking confirmation + follow-up cancellation
- Instagram/Facebook social content, comments, DMs
- Ads AIDA creative generation, finance gate, paused-by-default launch safety net
- Multi-tenant isolation across all sampled routes and webhooks

### WORKING WITH CONFIGURATION
- Lead generation (needs `EXPLORIUM_API_KEY` or a confirmed Frontage Leads/Vibe Prospecting connection)
- Follow-up cron (needs `FOLLOW_UP_CRON_ENABLED=true` AND cron scheduling confirmed)
- All other cron-dependent automation (needs confirmation that an external scheduler is wired, since `vercel.json` has none)
- Ads performance sync cadence (code exists, scheduling unverified)

### NEEDS FIX BEFORE PRODUCTION
- Ad content validation should gate launch, not just warn, for high-severity findings (unsupported claims, wrong offer)
- Calendly URL overwrite race between OAuth and manual paths
- Confirm/fix `ad_campaigns` status CHECK constraint vs actual app-written values
- Decide and implement a global mailbox count cap

### NOT IMPLEMENTED
- LinkedIn/TikTok/YouTube organic social automation (content/comments/DMs)
- Meta Pixel / Instant Form wiring (blocks true Leads/Sales objective optimization)
- SEO-fallback nurture path for not-interested leads (if this was ever an actual requirement)
- Calendly link anti-repeat guard
- Calendly event-type selection (booking link is always the account's default scheduling page)

---

## SECTION O — FINAL BUSINESS FLOW SCORE (0–100)

| Flow | Score | Why |
|---|---|---|
| Domain provisioning | 90 | Fully automated, self-healing, one unavoidable external (ICANN) step |
| Mailbox provisioning | 85 | Solid, minor gap: no global count cap |
| Lead generation | 20 | Currently non-functional — missing API key |
| Lead outreach (first send) | 60 | Triggers automatically but is templated, not personalized |
| Reply tracking | 90 | Signature-verified, deduped, well-threaded |
| AI conversation/classification | 85 | Real 4-way classification with correct branch actions |
| Follow-ups | 55 | Correct logic, but cron not confirmed to actually run |
| Calendly connect | 85 | Solid OAuth + manual fallback |
| Booking confirmation | 90 | Genuinely working webhook + poll fallback, correctly cancels follow-ups |
| Social connection | 70 | Full for IG/FB, connect-only for other platforms |
| Social content | 85 | Genuinely grounded in business context |
| Social scheduling | 85 | Real anti-duplication, correct cadence control |
| Social comments | 85 | End-to-end, real provider send |
| Social DMs | 80 | End-to-end; correctness depends on an unverified Zernio message-ID stability assumption |
| Ads creation | 80 | Form → AI → Meta pipeline is real and mostly faithful |
| Ads relevance | 55 | Validation is advisory-only; factually wrong ads can launch |
| Ads targeting | 65 | Mostly respected; interest substitution and forced-Traffic objective are silent drift points |
| Ads finance | 85 | Correctly gates spend; first-ad-free-pass and a possible schema drift are the only dings |
| Ads launch | 85 | Safe (always paused, explicit publish step) |
| Reporting | — | Not deeply audited this pass (UNKNOWN) |
| Security | 85 | Consistently correct tenant isolation everywhere sampled; some subtrees unverified |

**Overall score: ~70/100** — a well-engineered system held back primarily by one missing credential (lead generation) and unconfirmed cron scheduling (follow-ups and several other automations), plus a few real but secondary logic gaps in ad content validation and targeting fidelity.

---

## SECTION P — TOP 20 ACTION ITEMS (by business impact)

1. **Set `EXPLORIUM_API_KEY`** (or confirm Frontage Leads/Vibe Prospecting is the intended primary path) — without this, lead generation produces zero leads. [P0]
2. **Confirm whether an external scheduler (n8n?) actually calls the 7 cron routes.** If not, register them in `vercel.json` — follow-ups, daily voice calls, and domain-provisioning retries may be silently dead. [P0]
3. **Set `FOLLOW_UP_CRON_ENABLED=true`** in the real deployment environment if follow-ups are meant to run automatically. [P1]
4. **Verify Explorium's person/contact-fetch endpoint** against a live account — the code's own comments admit this was never confirmed even with a key. [P1]
5. **Make ad content validation a hard gate** (at least for high-severity findings like unsupported claims or wrong offer) instead of advisory-only. [P1]
6. **Require explicit re-approval when an interest gets substituted**, matching the existing pattern already used for age/gender widening. [P2]
7. **Surface (not silently force) the Meta objective remap** — tell the user clearly that "Leads/Sales" will run as a Traffic campaign without a Pixel/Instant Form. [P2]
8. **Add a precedence/conflict rule for `clients.calendly_url`** between OAuth connect and manual paste (e.g. don't silently overwrite a manually-set value on reconnect). [P2]
9. **Verify the `ad_campaigns` status CHECK constraint** against every status string the app actually writes — possible insert failures in production. [P2]
10. **Add a global per-client mailbox count cap** — currently only a per-request cap exists. [P2]
11. **Decide the scope for LinkedIn/TikTok/YouTube** — either build organic automation or make it explicit in the UI that only ads are supported there. [P2]
12. **Wire Meta Pixel / Instant Form** if true Leads/Sales conversion optimization is a business requirement — currently architecturally absent. [P2]
13. **Confirm `ads/sync`'s actual cron cadence** — the in-app copy claims "hourly" but this wasn't found wired to any scheduler in this pass. [P2]
14. **Add an anti-repeat guard for the Calendly link** sent to the same lead across multiple replies. [P3]
15. **Fix the stale "uploaded creative not supported" warning text** — the upload path actually works; the validator's copy is wrong. [P3]
16. **Decide if an "SEO fallback" nurture message for not-interested leads is a real requirement** — currently not implemented anywhere. [P3]
17. **Remove dead shuffle() code** in `send-batch.ts` for clarity (no functional impact). [P3]
18. **Independently verify tenant isolation** on the not-yet-sampled subtrees: `leads/[id]/*`, `social/*` beyond Zernio webhook, `voice/*`, `vibe-prospecting/*`. [P2 — diligence]
19. **Confirm Zernio's inbound message-ID stability** for DMs — the no-resend-bug conclusion depends on this external assumption holding. [P3 — diligence]
20. **Add Calendly event-type selection** if a single generic scheduling-page link isn't sufficient for the product's needs. [P3]

---

## MOST IMPORTANT QUESTION

> If a completely new customer signs up today and follows the intended journey from domain purchase → mailbox creation → lead generation → AI outreach → reply → conversation → Calendly → appointment, while also connecting social media and running AI social/ads automation, can this entire system actually operate end-to-end without manual intervention?

### Answer: **NO** (as currently configured), but the underlying engineering is largely **PARTIALLY → close to YES** once two specific gaps are closed.

**Where it succeeds:** Domain purchase through mailbox readiness is fully automatic and self-healing. Once a lead exists, the reply-tracking → classification → Calendly-link → booking-confirmation → follow-up-cancellation loop is genuinely solid and automatic. Social content/comments/DMs for Instagram/Facebook work end-to-end. Ads creation respects the user's brief in almost every field, and spend is safely gated behind finance approval and an explicit publish click.

**Exactly where it breaks for a brand-new customer today:**
1. **Lead generation itself never produces a lead**, because `EXPLORIUM_API_KEY` is empty (`.env.local:34`) — this is the first and most fatal break point; everything downstream of it (outreach, replies, bookings) simply never starts for a client relying on AI prospecting.
2. **Even if leads existed, the scheduled follow-up cron is not confirmed to run** — `vercel.json` has no registered crons, and `FOLLOW_UP_CRON_ENABLED` isn't set locally, so the "no response → follow-up" branch of the journey likely requires manual triggering today.
3. A secondary, lower-severity gap: automated initial outreach is templated rather than fully AI-personalized, and ads can launch even when the AI's own validation step flags them as off-brief.

Close items 1 and 2, and this system's architecture is sound enough to genuinely operate end-to-end with only the ICANN-email and platform-permission steps (Meta Advertiser role, Instagram DM access) remaining as unavoidable, well-handled human-in-the-loop moments.

---

## SECTION Q — UPDATE (2026-10-09): Existing-Domain Ownership Fix, Staging Verification

Follow-up session. Fixed the P0 cross-tenant domain-ownership gap this audit implied (two clients could each claim the same real external domain), added disconnect/reconnect for external domains, and ran live verification against the staging Supabase project rather than relying on unit tests alone.

### What shipped
- `domain_ownership` / `domain_ownership_challenges` tables (`supabase/add_domain_ownership.sql`) — DB-level unique-domain enforcement via primary key, not an application-level race-able check.
- `src/lib/domain-ownership-core.ts` / `domain-ownership.ts` — DNS TXT-challenge ownership proof for "use an existing domain," gating mailbox creation and sending (`assertDomainUsableByClient`).
- `src/app/api/domains/disconnect/` — lets a client disconnect an external domain; gated by the same ownership/usability check.
- `src/lib/domain-provisioning-core.ts`, `src/lib/mailbox-match.ts` — pure, unit-testable extractions from `domain-provisioning.ts` and the mailbox-matching logic (121 tests total, including 3 new focused test files).

### Two real bugs found only by testing against the live database (not caught by `npm test` or `npm run build`)
1. **My own migration's backfill used `count(distinct ...)` as a window function** — not valid in this Postgres version, so the first apply attempt rolled back entirely. Fixed with a correlated subquery; corrected in `supabase/add_domain_ownership.sql`.
2. **Pre-existing, independent of this session's work:** `domains.dns_status`'s live CHECK constraint only ever allowed `('pending', 'active')`. The codebase has written `'provisioning_failed'` throughout `domain-provisioning.ts` and the retry cron since before this audit — those writes have likely always been silently rejected in this environment. Fixed via a new migration, `supabase/add_dns_status_values.sql`, widening the constraint to also allow `'provisioning_failed'` and the new `'disconnected'` value. **Action item: re-check whether the retry-cron's failure-state tracking has actually been working in whatever environment this constraint also exists in (e.g. production, if it shares this gap).**

### Live staging verification performed (real DB, real DNS, no Mailgun/email side effects)
Using two temporary test clients (created and fully deleted afterward; real customer rows — 14 domains, 7 ownership rows — were confirmed unchanged before and after):
- Real DNS TXT lookup genuinely failed before any record existed (`dns_not_found`), via the actual `checkOwnershipChallenge` code path.
- A second client claiming an already-owned domain was rejected (`owned_by_other`) with no identity leak.
- A duplicate `domain_ownership` insert for the same domain hit a real Postgres primary-key violation (`23505`) — confirms the cross-tenant guarantee is an enforced DB constraint, not just application logic.
- Disconnect correctly affected 0 rows when attempted by a non-owning client (real tenant-scoped `UPDATE`).
- Zero new Supabase security-advisor findings attributable to the new tables.

### Still blocked / not live-tested this pass
- Real Mailgun domain creation/verification and actual outbound/inbound email — would need a real domain under the tester's DNS control and a real recipient; not attempted to avoid real external side effects.
- RLS enforcement from an actual signed-in client session (the live tests above used the service-role client, which bypasses RLS by design — the policies themselves were confirmed present via `pg_policies`, not exercised as an authenticated user).

**Recommendation at the time: remain in staging** until a real test domain + recipient are available to close the Mailgun/DNS leg end-to-end.
