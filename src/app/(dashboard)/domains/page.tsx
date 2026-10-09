import { headers } from "next/headers";
import { effectiveDailyLimit } from "@/lib/mailbox-readiness";
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
import DomainExternalSetup from "@/components/domain-external-setup";
import DomainChoice from "@/components/domain-choice";
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

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 1);

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

      return {
        id: m.id,
        address: m.address,
        daily_send_limit: effectiveDailyLimit(m),
        warmup_day: m.warmup_day,
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

      <DomainChoice buyPanel={<DomainPurchasePanel />} existingPanel={<DomainExternalSetup />} />

      <DomainLiveStatus />

      <DomainPurchaseHistory purchases={purchases ?? []} />

      <DomainMailboxAdd domains={(ownedDomains ?? []).map((d) => d.domain)} />

      <DomainMailboxList mailboxes={mailboxes} />
    </div>
  );
}
