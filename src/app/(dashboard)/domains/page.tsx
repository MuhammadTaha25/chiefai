import { headers } from "next/headers";
import { describeMailboxLimit, startOfSendDay } from "@/lib/mailbox-readiness";
import { resolveAppOrigin } from "@/lib/app-url";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { confirmCheckoutReturn } from "@/lib/purchase-reconcile";
import { createClient } from "@/lib/supabase/server";
import DomainPurchasePanel from "@/components/domain-purchase-panel";
import DomainOnboardingFlow from "@/components/domain-onboarding-flow";
import DomainPurchaseHistory from "@/components/domain-purchase-history";
import DomainLiveStatus from "@/components/domain-live-status";
import DomainMailboxList from "@/components/domain-mailbox-list";
import DomainMailboxAdd from "@/components/domain-mailbox-add";
import { getMailboxReadiness } from "@/lib/mailgun";

interface DomainPurchaseRow {
  id: string;
  domain: string;
  status: string;
  amount_cents: number;
  currency: string;
  hostinger_order_id: string | null;
  last_error: string | null;
  created_at: string;
}

export default async function DomainsPage(props: {
  searchParams: Promise<{ domain_purchase?: string; domain?: string }>;
}) {
  const searchParams = await props.searchParams;
  const supabase = await createClient();

  // The buyer has just been redirected back from Stripe. Confirm the payment
  // against Stripe itself and start registration BEFORE reading any state, so
  // this page reflects what is actually true — rather than waiting on a webhook
  // that may never arrive, and rather than trusting the ?success query string,
  // which on its own proves nothing (it is just a URL we told Stripe to use).
  if (searchParams.domain_purchase === "success" && searchParams.domain) {
    const { client } = await getCurrentClient();
    if (client) {
      const h = await headers();
      const publicOrigin = resolveAppOrigin({
        nextUrl: { origin: `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}` },
      });
      await confirmCheckoutReturn(createAdminClient(), {
        clientId: client.id,
        domain: searchParams.domain,
        publicOrigin,
      }).catch(() => {
        // Best-effort: the Stripe webhook and the provisioning cron still
        // exist, so a failure here must never break the page.
      });
    }
  }

  const { data: purchases } = await supabase
    .from("domain_purchases")
    .select("id, domain, status, amount_cents, currency, hostinger_order_id, last_error, created_at")
    .order("created_at", { ascending: false })
    .returns<DomainPurchaseRow[]>();

  const { data: mailboxRows } = await supabase
    .from("mailboxes")
    .select("id, address, daily_send_limit, warmup_day, created_at")
    .order("created_at", { ascending: false })
    .returns<{ id: string; address: string; daily_send_limit: number; warmup_day: number; created_at: string }[]>();

  // Domains the client actually owns (registered at Hostinger) — the targets
  // the "Add a mailbox" form can provision onto.
  const { data: ownedDomains } = await supabase
    .from("domains")
    .select("domain")
    .order("created_at", { ascending: false })
    .returns<{ domain: string }[]>();

  // "Sent today" uses the client's own midnight, the same boundary sending uses for the mailbox limit and the daily cap.
  const { data: tzRow } = await supabase.from("clients").select("timezone").maybeSingle<{ timezone: string | null }>();
  const startOfToday = new Date(startOfSendDay(tzRow?.timezone));
  const startOfMonth = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 1);

  // Follow-ups never switch mailbox, so one that is overdue for more than an hour is waiting on ITS original
  // mailbox (full for today, paused or not ready). Counted per mailbox so the table can show who is held up.
  const WAITING_AFTER_MS = 60 * 60 * 1000;
  const STUCK_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
  const nowMs = new Date().getTime();
  const { data: overdueLeads } = await supabase
    .from("leads")
    .select("id, next_follow_up_at")
    .gte("follow_up_number", 1)
    .eq("reply_received", false)
    .eq("unsubscribed", false)
    .eq("email_bounced", false)
    .eq("booked", false)
    .eq("complained", false)
    .eq("manually_stopped", false)
    .lte("next_follow_up_at", new Date(nowMs - WAITING_AFTER_MS).toISOString())
    .limit(150)
    .returns<{ id: string; next_follow_up_at: string }[]>();
  const overdueIds = (overdueLeads ?? []).map((l) => l.id);
  const { data: firstSends } = overdueIds.length
    ? await supabase
        .from("outreach_log")
        .select("lead_id, mailbox_id")
        .in("lead_id", overdueIds)
        .not("mailbox_id", "is", null)
        .order("sent_at", { ascending: true })
        .returns<{ lead_id: string; mailbox_id: string }[]>()
    : { data: [] as { lead_id: string; mailbox_id: string }[] };
  const originalMailbox = new Map<string, string>();
  for (const r of firstSends ?? []) if (!originalMailbox.has(r.lead_id)) originalMailbox.set(r.lead_id, r.mailbox_id);
  const waitingByMailbox = new Map<string, { waiting: number; stuck: number }>();
  for (const l of overdueLeads ?? []) {
    const mb = originalMailbox.get(l.id);
    if (!mb) continue;
    const entry = waitingByMailbox.get(mb) ?? { waiting: 0, stuck: 0 };
    entry.waiting += 1;
    if (nowMs - new Date(l.next_follow_up_at).getTime() > STUCK_AFTER_MS) entry.stuck += 1;
    waitingByMailbox.set(mb, entry);
  }

  const mailboxes = await Promise.all(
    (mailboxRows ?? []).map(async (m) => {
      const [{ count: sentToday }, { count: sentThisMonth }] = await Promise.all([
        supabase
          .from("outreach_log")
          .select("id", { count: "exact", head: true })
          .eq("mailbox_id", m.id)
          .gte("touch_number", 1)
          .gte("sent_at", startOfToday.toISOString()),
        supabase
          .from("outreach_log")
          .select("id", { count: "exact", head: true })
          .eq("mailbox_id", m.id)
          .gte("sent_at", startOfMonth.toISOString()),
      ]);

      const limit = describeMailboxLimit(m);
      const waiting = waitingByMailbox.get(m.id);
      return {
        id: m.id,
        address: m.address,
        // The limit sending really uses today (lower of the saved limit and the age-based warm-up ceiling).
        daily_send_limit: limit.effective,
        configured_limit: limit.configured,
        warmup_allows: limit.warmupAllows,
        limited_by: limit.limitedBy,
        // Real warm-up stage from the mailbox's age; the stored warmup_day is only ever set to 1.
        warmup_day: limit.stageDay,
        warmed_up: limit.warmedUp,
        days_until_warmed: limit.daysUntilWarmed,
        waiting_followups: waiting?.waiting ?? 0,
        stuck_followups: waiting?.stuck ?? 0,
        sent_today: sentToday ?? 0,
        sent_this_month: sentThisMonth ?? 0,
        readiness: await getMailboxReadiness(m.address),
      };
    })
  );

  // The mailbox-setup popup should only ever appear once per domain — a
  // stale `?domain_purchase=success` query string (browser back/forward,
  // bookmarked link, or the Stripe redirect being revisited) must not
  // re-trigger it once mailboxes already exist for that domain.
  const domainAlreadyHasMailboxes =
    !!searchParams.domain &&
    (mailboxRows ?? []).some((m) => m.address.endsWith(`@${searchParams.domain}`));

  // `?domain_purchase=success` is set by Stripe's success_url, which only
  // proves the PAYMENT went through — it says nothing about whether Hostinger
  // actually registered the domain. Rendering a "your domain is registered"
  // popup straight off that query string is exactly how the UI came to claim
  // success for domains that were never bought: the client paid, saw
  // "successfully bought / now registered", and had no domain.
  //
  // Drive the popup off the recorded purchase row instead, so what the client
  // reads always matches what is actually true in the DB and at the registrar.
  const domainPurchase = searchParams.domain
    ? (purchases ?? []).find((p) => p.domain === searchParams.domain) ?? null
    : null;

  return (
    <div className="space-y-8">
      {searchParams.domain_purchase === "success" && searchParams.domain && !domainAlreadyHasMailboxes && (
        <DomainOnboardingFlow
          domain={searchParams.domain}
          purchaseStatus={domainPurchase?.status ?? "unknown"}
          lastError={domainPurchase?.last_error ?? null}
        />
      )}
      {searchParams.domain_purchase === "cancelled" && (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Checkout was cancelled — no charge was made.
        </p>
      )}

      <h1 className="text-2xl font-semibold tracking-tight">Domains</h1>
      <p className="text-sm text-zinc-500">
        Search for a domain and buy it — it&apos;s registered automatically through Hostinger once
        payment goes through, and DNS/mailbox setup happens right after.
      </p>

      {/*
        "Use an existing domain" is temporarily disabled: the connected
        Mailgun account's plan only allows 1 custom domain, so a real client
        trying to connect their own domain right now would just fail or steal
        the one domain slot another client needs — see SYSTEM_AUDIT.md.
        Re-enable by restoring: <DomainChoice buyPanel={<DomainPurchasePanel />} existingPanel={<DomainExternalSetup />} />
      */}
      <DomainPurchasePanel />

      <DomainLiveStatus />

      <DomainPurchaseHistory purchases={purchases ?? []} />

      <DomainMailboxAdd domains={(ownedDomains ?? []).map((d) => d.domain)} />

      <DomainMailboxList mailboxes={mailboxes} />
    </div>
  );
}
