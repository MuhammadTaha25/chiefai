import { reserveMailboxSlot, finalizeReservation, releaseReservation } from "@/lib/mailbox-readiness";
import { getClientBusinessContext, formatBusinessContext } from "@/lib/business-context";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { draftAidaEmail } from "@/lib/gemini";
import { sendMail, mailgunDomainForAddress } from "@/lib/mailgun";
import { withUnsubscribeFooter, unsubscribeHeaders } from "@/lib/compliance";
import { logEvent } from "@/lib/log-event";
import { assertDomainUsableByClient, getExternalDomainsForClient, isDomainDisconnected } from "@/lib/domain-ownership";

const FOLLOW_UP_INTERVAL_DAYS = 3;

/**
 * Public, unauthenticated endpoint — the ads landing page form posts here.
 * Resolves client_id server-side from the slug; never trusts a client_id
 * from the request body, so one client's page can never write another's leads.
 *
 * These are "inbound" leads (the person clicked an ad and filled the form
 * themselves), as opposed to "outbound" leads we sourced and emailed first
 * (see lead_source: "manual" / "ai_prospecting" / "vibe_prospecting"). The
 * first outreach email fires immediately, same AIDA flow as outbound leads.
 */
// Best-effort per-instance limiter (serverless instances don't share memory);
// the durable per-tenant cap below is what actually holds across instances.
const ipHits = new Map<string, number[]>();
const IP_LIMIT = 5;
const IP_WINDOW_MS = 10 * 60 * 1000;
const TENANT_HOURLY_CAP = 100;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) ipHits.clear();
  return hits.length > IP_LIMIT;
}

const clip = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export async function POST(req: NextRequest) {
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (rateLimited(ip)) return NextResponse.json({ error: "Too many submissions, try again later" }, { status: 429 });

  let raw: Record<string, unknown>;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  // Honeypot: real users never fill this hidden field; bots do. Pretend success.
  if (raw.hp_website) return NextResponse.json({ ok: true });

  const slug = clip(raw.slug, 100);
  const email = clip(raw.email, 320)?.toLowerCase() ?? null;
  const name = clip(raw.name, 200);
  const phone = clip(raw.phone, 50);
  const country = clip(raw.country, 100);
  const city = clip(raw.city, 100);
  const company = clip(raw.company, 200);

  if (!slug) {
    return NextResponse.json({ error: "Missing page" }, { status: 400 });
  }
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: client } = await admin
    .from("clients")
    .select("id, company_name")
    .eq("landing_slug", slug)
    .maybeSingle();

  if (!client) {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }

  // Durable per-tenant flood cap, and dedupe: the same address submitted
  // again (or an address that already unsubscribed) must never trigger another
  // email — otherwise this public form is a free mail-bomb relay.
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count: recent } = await admin
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("client_id", client.id)
    .eq("lead_source", "landing_page")
    .gte("created_at", since);
  if ((recent ?? 0) >= TENANT_HOURLY_CAP) {
    return NextResponse.json({ error: "Too many submissions, try again later" }, { status: 429 });
  }
  const { data: dupe } = await admin
    .from("leads")
    .select("id")
    .eq("client_id", client.id)
    .eq("email", email)
    .limit(1)
    .maybeSingle();
  if (dupe) return NextResponse.json({ ok: true });

  const { data: lead, error } = await admin
    .from("leads")
    .insert({
      client_id: client.id,
      name,
      email,
      phone,
      country,
      city,
      company,
      status: "new",
      lead_source: "landing_page",
      lead_type: "inbound",
    })
    .select()
    .single();

  if (error?.code === "23505") return NextResponse.json({ ok: true }); // raced a duplicate; already captured
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`public lead insert failed for client ${client.id}: ${error.message}`);
    return NextResponse.json({ error: "Could not save your details" }, { status: 500 });
  }

  // Best-effort immediate first-touch email — a failure here shouldn't fail
  // the lead capture itself; the lead still lands in the dashboard either
  // way and can be emailed manually from the Leads page.
  try {
    const [{ data: job }] = await Promise.all([
      admin
        .from("lead_gen_jobs")
        .select("criteria")
        .eq("client_id", client.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ criteria: Record<string, unknown> }>(),
    ]);

    const sellingDescription = (job?.criteria?.what_you_sell as string | undefined)?.trim();

    // Mailbox daily limit applies here too; at capacity the lead is still stored and can be emailed later.
    const reservation = sellingDescription ? await reserveMailboxSlot(admin, client.id, lead.id, { touch_number: 1 }) : null;
    if (reservation?.ok && sellingDescription) {
      const mailbox = reservation.mailbox;
      // REGRESSION FIX (Final Regression Audit, 2026-10-09): this public,
      // unauthenticated landing-page auto-send path was missed by the
      // original P0 fix's sweep. Best-effort send, so a blocked domain
      // silently skips the email rather than failing lead capture.
      const mailboxDomain = mailgunDomainForAddress(mailbox.address);
      const externalDomains = await getExternalDomainsForClient(admin, client.id);
      const usable = await assertDomainUsableByClient(admin, client.id, mailboxDomain, { requireExplicitOwnership: externalDomains.has(mailboxDomain) });
      if (!usable.usable || (await isDomainDisconnected(admin, client.id, mailboxDomain))) {
        await releaseReservation(admin, reservation.reservationId);
        logEvent("lead.captured", { client_id: client.id, lead_id: lead.id, source: "landing_page", result: "stored_send_blocked_domain_not_usable" });
        return NextResponse.json({ ok: true });
      }
      try {
      const draft = await draftAidaEmail({
        businessContext: formatBusinessContext(await getClientBusinessContext(admin, client.id)),
        sellingDescription,
        senderCompany: client.company_name ?? "us",
        leadName: lead.name || "there",
        leadCompany: lead.company || "your company",
        leadTitle: null,
      });

      const sentMsg = await sendMail({
        domain: mailgunDomainForAddress(mailbox.address),
        from: mailbox.address,
        to: lead.email,
        subject: draft.subject,
        text: withUnsubscribeFooter(draft.body, { company: client.company_name }),
        headers: unsubscribeHeaders(mailbox.address),
      });

      await Promise.all([
        finalizeReservation(admin, reservation.reservationId, { messageId: sentMsg.id, subject: draft.subject, body: draft.body }),
        admin
          .from("leads")
          .update({
            status: "email_sent",
            follow_up_number: 1,
            last_contact_at: new Date().toISOString(),
            next_follow_up_at: new Date(Date.now() + FOLLOW_UP_INTERVAL_DAYS * 86400000).toISOString(),
          })
          .eq("id", lead.id),
      ]);
      } catch (sendErr) {
        await releaseReservation(admin, reservation.reservationId);
        throw sendErr;
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Auto-send failed for inbound lead ${lead.id}:`, (err as Error).message);
  }

  logEvent("lead.captured", { client_id: client.id, lead_id: lead.id, source: "landing_page", result: "stored" });
  return NextResponse.json({ ok: true });
}
