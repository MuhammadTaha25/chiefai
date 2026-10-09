import { resolveAppOrigin } from "@/lib/app-url";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentClient } from "@/lib/get-current-client";
import { getStripe } from "@/lib/stripe";
import { getPortfolioStatus, getPortfolioEntry } from "@/lib/hostinger";
import { getMailboxReadiness } from "@/lib/mailgun";
import { ensureDomainProvisioned } from "@/lib/domain-provisioning";
import { registerDomainAndProvision } from "@/lib/domain-registration";
import { reconcileStuckPurchases } from "@/lib/purchase-reconcile";

/**
 * Closes the loop the manual "Retry"/"Check status" buttons otherwise leave
 * to a human: a domain that was "registering" or DNS-"pending" at the time
 * of purchase should keep getting re-checked on its own until it resolves,
 * not sit there forever unless someone happens to click a button. Meant to
 * run on a schedule (Vercel Cron -> Authorization: Bearer $CRON_SECRET), but
 * also callable by an authenticated client to re-check just their own
 * domains on demand.
 *
 * Never marks anything "registered"/"active" itself — it only re-runs the
 * same verified-confirmation paths (getPortfolioStatus, verifyMailgunDomain)
 * that the initial registration flow uses, so a false "success" here is no
 * more possible than it is there.
 */
async function runDomainProvisioning(req: NextRequest) {
  const admin = createAdminClient();
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const isCron = Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`;

  let clientIdFilter: string | null = null;
  if (!isCron) {
    const { user, client } = await getCurrentClient();
    if (!user || !client) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    clientIdFilter = client.id;
  }

  // Fail closed on missing production config before touching any state.
  const publicOrigin = resolveAppOrigin(req);

  const results = { registrationChecked: 0, registrationNowActive: 0, dnsChecked: 0, dnsNowVerified: 0 };

  // Make stale purchase states truthful first (never spends money).
  const reconciled = await reconcileStuckPurchases(admin, clientIdFilter ?? undefined);

  // Stuck at "registering" — re-run the full registration+provisioning path,
  // which itself re-polls Hostinger before touching any status.
  let registeringQuery = admin
    .from("domain_purchases")
    .select("id, domain, tld, client_id, hostinger_order_id")
    .eq("status", "registering");
  if (clientIdFilter) registeringQuery = registeringQuery.eq("client_id", clientIdFilter);
  const { data: registeringPurchases } = await registeringQuery;

  for (const purchase of registeringPurchases ?? []) {
    // The cron only RE-CHECKS an order that already exists (or is in flight).
    // It never places a new paid order: purchasing stays with the verified
    // Stripe webhook or an explicit human Retry.
    if (!purchase.hostinger_order_id || purchase.hostinger_order_id.startsWith("pending:")) continue; // in-flight claims are never taken over by cron
    results.registrationChecked++;
    const { getDomainCatalogItem } = await import("@/lib/hostinger");
    const catalog = await getDomainCatalogItem(purchase.tld).catch(() => null);
    if (!catalog) continue;
    const before = await getPortfolioStatus(purchase.domain);
    await registerDomainAndProvision({
      domainPurchaseId: purchase.id,
      domain: purchase.domain,
      catalogItemId: catalog.itemId,
      clientId: purchase.client_id,
      publicOrigin,
    });
    if (before?.toLowerCase() !== "active") {
      const after = await getPortfolioStatus(purchase.domain);
      if (after?.toLowerCase() === "active") results.registrationNowActive++;
    }
  }

  // A purchase can be genuinely PAID while its registration never started at
  // all. Stripe's webhook is not guaranteed to reach us — confirmed live: a row
  // sat at "paid" with a null hostinger_order_id indefinitely, because the
  // webhook that would have claimed it never arrived, and
  // reconcileStuckPurchases only ever moves pending_payment -> paid without
  // anything then picking "paid" up. Nothing else looks at "paid": the loop
  // above only reads "registering", and the UI shows no Retry for it — so the
  // client was charged and silently got nothing.
  //
  // Registration is already paid for, so finishing it here spends nothing new,
  // but this IS the one cron path that can place a real order (a "paid" row has
  // no hostinger_order_id yet), so every gate below is deliberate:
  //   - Stripe must itself confirm payment_status "paid", and
  //   - the session metadata must match this purchase id.
  // Two states can still need work, and BOTH are gated on Stripe confirming the
  // client actually paid — the cron never spends against an unverified payment:
  //   - "paid":   payment taken, but registration never started (the webhook
  //               that would have claimed it never arrived).
  //   - "registration_failed": an attempt failed. Whether we may place an order
  //               again is decided per-row below from the portfolio, never
  //               guessed, so a domain that already has an order can never get
  //               a second one.
  const RETRYABLE = ["paid", "registration_failed"];
  let stuckQuery = admin
    .from("domain_purchases")
    .select("id, domain, tld, client_id, status, hostinger_order_id, stripe_checkout_session_id, updated_at")
    .in("status", RETRYABLE);
  if (clientIdFilter) stuckQuery = stuckQuery.eq("client_id", clientIdFilter);
  const { data: stuckPurchases } = await stuckQuery;

  for (const purchase of stuckPurchases ?? []) {
    // A purchase whose charge was DECLINED is retried on a cooldown, not on
    // every cron tick. That failure is Hostinger's payment gateway refusing the
    // card ("[Billing:422] Payment failed", earlier "[Billing:9999]"), and
    // retrying every few minutes is both pointless — nothing about the card
    // changes between ticks — and counterproductive, because a burst of rapid
    // charge attempts is precisely what makes a bank block a card. Spacing the
    // retries out lets a temporary block clear instead of renewing it.
    const BILLING_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
    if (purchase.status === "registration_failed") {
      const sinceAttempt = Date.now() - new Date(purchase.updated_at).getTime();
      if (Number.isFinite(sinceAttempt) && sinceAttempt < BILLING_RETRY_COOLDOWN_MS) continue;
    }

    const hasRealOrder = Boolean(purchase.hostinger_order_id) && !purchase.hostinger_order_id!.startsWith("pending:");
    // A "registration_failed" row may or may not actually hold an order id, and
    // placing a SECOND order for a domain that already has one is the one
    // mistake this path must never make. The portfolio LIST endpoint is the
    // authority — it reports a domain that the detail endpoint 404s on (a
    // pending_verification domain, for instance):
    //   - present -> an order exists; stamp its id so registerDomainAndProvision's
    //                idempotency guard can never call purchaseDomain() again.
    //   - absent  -> no order exists at all. This is the "[Billing:9999] Request
    //                failed" case, where Hostinger declines the charge and
    //                creates nothing. Re-attempting is then safe, and is exactly
    //                what lets the flow heal by itself once billing works again
    //                (a declined card currently fails with no order and no money
    //                moved, so retrying costs nothing but a log line).
    let portfolioEntryId: string | null = null;
    if (purchase.status === "registration_failed" && !hasRealOrder) {
      const entry = await getPortfolioEntry(purchase.domain).catch(() => null);
      if (entry) portfolioEntryId = String(entry.id);
    }
    if (!purchase.stripe_checkout_session_id) continue;
    try {
      const session = await getStripe().checkout.sessions.retrieve(purchase.stripe_checkout_session_id);
      if (session.payment_status !== "paid") continue;
      if (session.metadata?.domain_purchase_id && session.metadata.domain_purchase_id !== purchase.id) continue;
    } catch {
      continue; // Stripe unreachable/unverifiable -> never spend on a guess
    }

    const { getDomainCatalogItem } = await import("@/lib/hostinger");
    const catalog = await getDomainCatalogItem(purchase.tld).catch(() => null);
    if (!catalog) continue;

    // Same atomic claim the webhook and Retry action use: exactly one caller
    // proceeds, so a concurrent cron/webhook/retry cannot double-register.
    const { data: claimedStuck } = await admin
      .from("domain_purchases")
      .update({
        status: "registering",
        // Stamp the portfolio id we just read, so registerDomainAndProvision's
        // idempotency guard sees an existing order and therefore can never call
        // purchaseDomain() for this purchase.
        ...(portfolioEntryId ? { hostinger_order_id: portfolioEntryId } : {}),
      })
      .eq("id", purchase.id)
      .in("status", RETRYABLE)
      .select("id");
    if (!claimedStuck?.length) continue;

    results.registrationChecked++;
    const before = await getPortfolioStatus(purchase.domain);
    await registerDomainAndProvision({
      domainPurchaseId: purchase.id,
      domain: purchase.domain,
      catalogItemId: catalog.itemId,
      clientId: purchase.client_id,
      publicOrigin,
    });
    if (before?.toLowerCase() !== "active") {
      const after = await getPortfolioStatus(purchase.domain);
      if (after?.toLowerCase() === "active") results.registrationNowActive++;
    }
  }

  // Registered domains that are not yet send-ready. Three cases, one idempotent repair (ensureDomainProvisioned):
  //   - dns_status "pending":             DNS is written, Mailgun has not verified yet -> re-verify.
  //   - dns_status "provisioning_failed": an earlier attempt failed (DNS not confirmed, Mailgun error) -> retry it.
  //     This used to be retried by nobody, so a single transient failure left the domain broken forever.
  //   - dns_status "active" but Mailgun has no such domain: stored state drifted from the provider -> rebuild it.
  // Only domains Hostinger has confirmed as registered are touched: DNS is never written for an unregistered domain.
  let domainsQuery = admin.from("domains").select("id, client_id, domain, dns_status, dns_managed_externally");
  if (clientIdFilter) domainsQuery = domainsQuery.eq("client_id", clientIdFilter);
  const { data: allDomains } = await domainsQuery;

  for (const d of allDomains ?? []) {
    if (d.dns_managed_externally) {
      // P1 FIX (Existing-Domain Feature Audit, 2026-10-09): this loop used to
      // gate every domain on having a `domain_purchases` row with status
      // "registered" — an externally-managed domain never has one (it was
      // never bought), so the automatic repair/retry cron silently never
      // touched Path B domains at all. Gate those on domain_ownership
      // instead: only retry a domain whose ownership challenge has actually
      // been completed by THIS client (ensureDomainProvisioned enforces the
      // same rule internally, but skipping here avoids a pointless Mailgun
      // call for a domain that has no chance of succeeding yet).
      const { data: owned } = await admin.from("domain_ownership").select("client_id").eq("domain", d.domain).maybeSingle<{ client_id: string }>();
      if (!owned || owned.client_id !== d.client_id) continue;
    } else {
      const { data: purchase } = await admin
        .from("domain_purchases")
        .select("status")
        .eq("client_id", d.client_id)
        .eq("domain", d.domain)
        .eq("status", "registered")
        .limit(1)
        .maybeSingle();
      if (!purchase) continue;
    }

    const needsWork =
      d.dns_status === "pending" ||
      d.dns_status === "provisioning_failed" ||
      (d.dns_status === "active" && (await getMailboxReadiness(`x@${d.domain}`)) === "not_provisioned");
    if (!needsWork) continue;

    results.dnsChecked++;
    const outcome = await ensureDomainProvisioned(admin, {
      clientId: d.client_id,
      domain: d.domain,
      publicOrigin,
      verifyAttempts: 1,
    });
    if (outcome.state === "active" && d.dns_status !== "active") results.dnsNowVerified++;
  }

  return NextResponse.json({ ok: true, ...results, reconciled });
}

export async function GET(req: NextRequest) {
  return runDomainProvisioning(req);
}

export async function POST(req: NextRequest) {
  return runDomainProvisioning(req);
}
