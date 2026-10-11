# Per-tenant personal mailbox + calendar (design, not yet built)

Goal: when a client connects their own Google account, mail goes out from THEIR address and meetings land on
THEIR calendar, set up automatically — alongside (not instead of) the Mailgun "simulated mailbox" product.

## Why separate phase
Needs Google OAuth with Gmail + Calendar scopes. Gmail send/read scopes are "restricted": Google requires app
verification and, for restricted scopes, a security assessment before real customers can connect. Plan for weeks,
not days. Until verified, only test users (up to 100) listed in the OAuth consent screen can connect.

## Design
1. **Table `connected_mailboxes`**: client_id, provider (`google`), address, refresh_token (encrypted), scopes,
   status (`active`/`reauth_needed`), daily_send_limit, created_at. Mailgun mailboxes stay in `mailboxes`.
2. **Unify selection**: `reserveMailboxSlot` / `pickReadyMailbox` already pick by readiness + load + health.
   Give both kinds one interface (`send(msg)`), so rotation and the new health failover cover Gmail too.
   Gmail sends via `gmail.users.messages.send` (RFC 822, with In-Reply-To/References for threading).
3. **Replies**: Gmail push (`users.watch` → Pub/Sub) or polling `history.list` feeds the SAME inbound handler
   used by the Mailgun webhook (classification, STOP, auto-reply cap).
4. **Calendar**: with Calendar scope, create the event directly (`events.insert` + `conferenceData` for Meet) on
   the tenant's calendar and put the Meet link in the email — no Calendly needed for tenants who connect Google.
5. **Limits**: personal Gmail/Workspace accounts have their own sending caps (~500/day Gmail, ~2000 Workspace);
   keep daily_send_limit conservative (<=50 cold/day) and never send cold mail from a tenant's primary identity
   without explicit consent — a spam flag there hurts their real inbox.
6. **UI**: Settings → "Connect Google" (mailbox + calendar), shows address, status, today's sends, health.
7. **Health/spam**: reuse `mailbox-health.ts`; add a Google Postmaster / seed-inbox check later for real
   inbox-vs-spam placement (Mailgun does not expose it).

## Done in this branch instead (works today)
- Server-guaranteed booking link in replies (`booking-link.ts`).
- Per-lead Calendly one-off event named after the tenant + topic, with Meet/Zoom location (`calendly.ts`).
- Mailbox health failover on bounce/complaint rate (`mailbox-health.ts`).
