# ChiefAI changelog

Plain-language record of what changed in the app, newest first. Source of truth for exact code is `git log`; this file explains it. PR numbers are GitHub pull requests. "Live-tested" means checked on the real test client (Infomist QA), not only by automated tests.

**How to keep this file current:** after every merge, add a line under today's date (what changed, PR number, whether it was live-tested, anything still open).

---

## 27 Oct 2026 - Social media: weekly plan

The social pipeline now plans the whole week once, then makes each day's post from that plan. Problem it fixes: generic posts, repeated ideas, videos not matching the title.

- **#45** Weekly plan: titles, hooks and one visual idea per post, made once per week (planned Sunday 20:00 local). Code decides pillar, format, product, audience, customer problem and call to action; the AI writes title, hook and visual. A checker rejects weak plans; on failure the system falls back to deciding on the day.
- **#46** A missing plan is created as soon as it is noticed, not only when a slot is due.
- **#47** Quality rules: one customer problem per post, no stock-photo scenes, no company-introduction or jargon hooks.
- **#48** Every post gets an angle (no repeats in a week). Trust posts use methods that need no testimonial. Hooks with claimed hours, percentages or money are rejected. Feature-announcement hooks rejected. Problem/trust visuals may not show the solved state.
- **#49 (open at time of writing)** Visual variety across the week, offer hooks must give a next step, "done-for-you" wording banned in hooks.
- Live-tested: plans generated for Infomist QA and read by hand. Not yet tested: captions, images, video, carousel and stories made from the new plans (first real check: the 00:00 post).
- Note: the test client publishes automatically to a real Facebook page.
- Design and research notes: `claude/social-weekly-plan-and-text-design-2026-10-27.md` in the Claude project.

## 26-27 Oct 2026 - Email: replies, follow-ups, sending health

- **#44** Follow-ups: one stuck lead (e.g. its mailbox is at the daily limit) no longer blocks the rest of the client's queue.
- **#43** Angry-reply mail never asks a question; ends with a plain "will not write again unless you reply" line. Not yet seen live.
- **#42** "Later" acknowledgements never ask a question (question sentences are stripped after drafting). Live-tested.
- **#41** Replies and STOP confirmations show the business name next to the mailbox address; the retention mail for "not interested" asks one question only. Live-tested.
- **#40** "Not now, maybe later" gets one short "we'll be in touch" note. Live-tested.
- **#39** New reply cases: "later" and "not interested"; an angry reply gets a changed approach.
- **#38** Up to 5 follow-ups (was 3); default 5 when the client gave no answer. First follow-ups live-tested (touches 2-4 sent; 5-6 waiting on the mailbox daily limit).
- **#37, #36** "Sending health" card on the dashboard and Overview page, in plain language.
- **#35, #34, #33** First emails: 50-75 words, pain-first with an easy out, varied subjects (no "quick question" everywhere); follow-ups tell a story (problem, consequence, help).
- **#32** A reply from a different address than we wrote to is matched by its thread, so STOP is no longer ignored.
- **#31, #30, #29** Daily health check emails an alert when something needs attention; DNS check also covers the Mailgun inbound route and duplicate mailbox addresses; lead-gen review note corrected.
- **#28** Repeat lead search continues where it stopped.

## 19-21 Oct 2026 - Email deliverability and safety

- **#27** Template opener reads "real estate" not "real_estate"; pitch ignores failed lead-gen jobs.
- **#26** An invalid send window keeps sending closed.
- **#25** Inbound webhook applies STOP before any AI call.
- **#24, #23** Simulated verification suite; random send gaps (follow-ups 3-10 min, first emails 60-100% of plan).
- **#22** A friendly "stop by" is not an opt-out.
- **#21, #20** Bounce wording does not claim an address is invalid when the reason is unknown; the receiver's failure message is recorded.
- **#19** Domain-wide health, age-based domain cap, slow-down at early bounce warning.
- **#18** Follow-ups: one per client per run with a minimum gap.
- **#17** Pre-send address check, tracking off for cold mail, per-domain daily cap.
- **#16, #15** DNS health check (SPF, DKIM, MX, CNAME, DMARC), daily, with send pause when flagged.
- **#14, #13** Ads: store ad account currency; voice report counts only launched campaigns.

## 17 Oct 2026 - Voice and lead industry

- **#12, #11, #10** Voice calls: recorded hello at pickup, faster first audio, goodbye handling, no double greeting.
- **#8** Per-lead industry; emails and follow-ups follow an industry-guarded AIDA structure. No duplicate sends; follow-ups respect the send window.
- Greeting and sign-off are made by the system per lead and per client.

## 11-16 Oct 2026 - Foundations

- 16 Oct: email quality (short single call to action, subject must match body); n8n workflow URLs point to the QA domain (#7).
- 15 Oct: weighted spam scoring for outreach drafts; follow-up sequence fixes (cap, pinned mailbox, threading); mailbox health pauses at 4% bounces / 0.1% complaints; simulated pipeline tests.
- 14 Oct: exponential warm-up ramp with jitter; per-campaign sending window and template; n8n workflows for hourly sending and follow-ups; post-meeting feedback loop; bounce types and soft-bounce retry; social: scheduled posts shown in the UI, brand visuals injected, 30-minute slot dropdowns.
- 13 Oct: sending-schedule settings UI; AIDA email personalisation; edit and publish buttons for draft posts; business-specific social and ad prompts.
- 12 Oct: per-day weekly plan for social automation (day/format/story schedule).
- 11 Oct: booking link guarantee, per-lead Calendly event, mailbox health failover.

## 28 Sep - 10 Oct 2026 - Platform setup

- 10 Oct: Find Leads fixes (exact city match, no repeated prospects, excluded locations enforced); stopped auto-creating a sales@ mailbox.
- 9 Oct: domain ownership rules and disconnect; email-verification signup; rebrand to ChiefAI; domain purchase markup removed.
- 8 Oct: Calendly fixes (lead matching, retries, timezone); voice call drop and call-log timezone fixes; Terms/Privacy gate; ads creative upload.
- 7 Oct: SEO metadata, robots, sitemap.
- 3 Oct: executive workspace UI (`/workspace`).
- 28 Sep: initial commit; production fix moving middleware to `proxy.ts` (Next.js 16).

---

## Still open

- Mailbox daily limit (3 on warm-up day 1) pauses the 5-follow-up live test after three sends in one day.
- Spam-folder placement for Gmail is the main deliverability item; a placement test with fresh Gmail accounts is planned.
- Social: image, video (must match the title), carousel and stories are next, in that order. Video tests cost money and are agreed first.
- Optional: platform alert sender/recipient environment variables on Vercel.
