import { createAdminClient } from "@/lib/supabase/admin";
import { purchaseDomain, completeDomainSetup, getPortfolioStatus, getPortfolioEntry } from "@/lib/hostinger";
import { ensureDomainProvisioned } from "@/lib/domain-provisioning";

/**
 * The actual Hostinger-registration + domains-mirror + mailbox/DNS
 * provisioning sequence, shared by the Stripe webhook (fires right after
 * payment) and the manual "Retry registration" action (for a purchase stuck
 * at registration_failed — no new Stripe charge involved, this only retries
 * the Hostinger side of an already-paid-for domain).
 */
export async function registerDomainAndProvision(params: {
  domainPurchaseId: string;
  domain: string;
  catalogItemId: string;
  clientId: string;
  publicOrigin: string;
}) {
  const admin = createAdminClient();
  const { domainPurchaseId, domain, catalogItemId, clientId, publicOrigin } = params;

  try {
    // Idempotency guard (spec: "duplicate registration protection"). A retry
    // (manual button, or the domain-provisioning cron re-checking a stuck
    // "registering" row) must never re-call purchaseDomain() once an order
    // already exists for this purchase — confirmed live: Hostinger rejects a
    // second purchase attempt for the same domain with an opaque
    // "[Billing:9999] Request failed" rather than a clear "already
    // registered" message, so this has to be checked ourselves before ever
    // placing the order, not inferred from Hostinger's error text.
    const { data: existingPurchase } = await admin
      .from("domain_purchases")
      .select("hostinger_order_id")
      .eq("id", domainPurchaseId)
      .maybeSingle<{ hostinger_order_id: string | null }>();

    // At-most-once purchase. Two callers (Stripe webhook, Retry click, cron)
    // can reach this point together, and purchaseDomain() spends real money, so
    // the right to place the order is claimed ATOMICALLY first: only the caller
    // whose conditional update flips hostinger_order_id from NULL wins. Everyone
    // else skips the purchase and just re-checks status. A claim marker older
    // than CLAIM_STALE_MS (crashed caller) can be taken over.
    const CLAIM_STALE_MS = 10 * 60 * 1000;
    const stored = existingPurchase?.hostinger_order_id ?? null;
    const claimTs = stored?.startsWith("pending:") ? Number(stored.slice(8)) : NaN;
    const claimStale = Number.isFinite(claimTs) && Date.now() - claimTs > CLAIM_STALE_MS;

    let hostingerOrderId: string;
    if (stored && !stored.startsWith("pending:")) {
      // eslint-disable-next-line no-console
      console.log(`[domains] purchase=${domainPurchaseId} client=${clientId} already has a Hostinger order — skipping purchaseDomain, re-checking status`);
      hostingerOrderId = stored;
    } else {
      const marker = `pending:${Date.now()}`;
      let claim = admin.from("domain_purchases").update({ hostinger_order_id: marker }).eq("id", domainPurchaseId);
      claim = stored ? claim.eq("hostinger_order_id", stored) : claim.is("hostinger_order_id", null);
      const { data: claimed } = await (stored && !claimStale ? { data: [] as { id: string }[] } : claim.select("id"));
      if (!claimed?.length) {
        // eslint-disable-next-line no-console
        console.log(`[domains] purchase=${domainPurchaseId} client=${clientId} order already being placed by another caller — not purchasing again`);
        hostingerOrderId = "";
      } else {
        try {
          const result = await purchaseDomain(domain, catalogItemId);
          // eslint-disable-next-line no-console
          console.log(`[domains] purchase=${domainPurchaseId} client=${clientId} Hostinger order placed`);
          hostingerOrderId = String(result.id ?? "");
        } catch (purchaseErr) {
          // Domain can end up "awaiting setup" — the billing order went through
          // and it's in the portfolio, but the registrar-side registration never
          // completed. completeDomainSetup finishes that same already-paid order
          // instead of placing a new one.
          if (!/already registered/i.test((purchaseErr as Error).message)) {
            // Release the claim so a human Retry can try again.
            await admin.from("domain_purchases").update({ hostinger_order_id: null }).eq("id", domainPurchaseId).eq("hostinger_order_id", marker);
            throw purchaseErr;
          }
          // eslint-disable-next-line no-console
          console.log(`[domains] purchase=${domainPurchaseId} domain already in portfolio but unregistered — completing setup`);
          await completeDomainSetup(domain);
          hostingerOrderId = "";
        }
      }
    }

    // The order call above only means Hostinger accepted/billed it — actual
    // ICANN/registry registration lags behind. Confirmed live: a domain can
    // come back as an empty {} from the portfolio endpoint (not even
    // "pending") right after a successful purchase call. Poll before ever
    // telling the client "registered"; anything still not Active after that is
    // recorded truthfully as "registering" rather than as a false positive.
    //
    // `resolvedOrderId` is the order this call is entitled to talk about:
    // either the one just placed above, or one already stored from an earlier
    // attempt.
    const resolvedOrderId = hostingerOrderId || stored || "";

    let confirmedActive = false;
    let triedCompleteSetup = false;
    // Set when Hostinger holds the order but is waiting on the registrant to
    // click the ICANN verification email. That state is neither "failed"
    // (nothing is wrong, and no amount of retrying clears it) nor "registered",
    // so without tracking it the client sees a domain parked on "registering"
    // forever with no hint that the only remaining step is a human one.
    let pendingVerification = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const status = await getPortfolioStatus(domain);
      if (status && status.toLowerCase() === "active") {
        confirmedActive = true;
        break;
      }
      // getPortfolioStatus() is structurally blind to a not-yet-Active domain —
      // its detail endpoint 404s for those — so ask the list endpoint what
      // Hostinger actually thinks before assuming this is merely slow.
      const entry = await getPortfolioEntry(domain).catch(() => null);
      if (entry?.status?.toLowerCase() === "pending_verification") pendingVerification = true;
      // Hostinger routinely ACCEPTS AND BILLS a new order and then leaves it
      // "awaiting setup": the order exists, but the registrar-side
      // registration never completes (confirmed live — several paid orders sat
      // exactly like this, with GET .../portfolio/{domain} returning
      // "[Domains:2006] Domain is not registered at Hostinger"). Only a human
      // clicking "Register" in hPanel used to finish those.
      // completeDomainSetup is the idempotent finish-this-already-paid-order
      // call, so run it as soon as we hold an order and Hostinger does not
      // report Active.
      //
      // This used to be gated on `existingPurchase?.hostinger_order_id` — the
      // snapshot read BEFORE the order was placed. On a first purchase that is
      // always null, so the recovery never ran on exactly the attempt that
      // needed it, and the domain stayed unregistered. Gate on the order we
      // just obtained instead.
      if (resolvedOrderId && !triedCompleteSetup) {
        triedCompleteSetup = true;
        await completeDomainSetup(domain).catch(() => {});
      }
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    await admin
      .from("domain_purchases")
      .update({
        status: confirmedActive ? "registered" : "registering",
        // Never overwrite a stored order id / in-flight claim with an empty value.
        ...(hostingerOrderId ? { hostinger_order_id: hostingerOrderId } : {}),
        last_error: pendingVerification
          ? "Hostinger accepted and billed the order, but the domain is pending ICANN registrant verification. Whoever controls the registrant contact email must click the verification link Hostinger sent before the domain goes live."
          : null,
      })
      .eq("id", domainPurchaseId);

    // Mirror into the (pre-existing) `domains` table — that's what the
    // Settings page and downstream DNS/mailbox provisioning read from.
    // Upsert with ignoreDuplicates (backed by the unique (client_id, domain)
    // constraint — see supabase/add_domains_and_mailboxes_unique_constraints.sql)
    // instead of a select-then-insert guard: a redelivered webhook racing a
    // manual retry could both pass a SELECT-based check before either INSERT
    // lands, producing two rows for the same domain (confirmed live before
    // this fix). The upsert is atomic at the DB level, so a race now safely
    // no-ops on the second call instead of inserting a duplicate.
    await admin
      .from("domains")
      .upsert(
        { client_id: clientId, domain, hostinger_order_id: hostingerOrderId || null, dns_status: "pending" },
        { onConflict: "client_id,domain", ignoreDuplicates: true }
      );

    // Don't chain into DNS/mailbox provisioning against a domain Hostinger
    // hasn't actually confirmed Active yet — that would create a Mailgun
    // domain and DNS records for something that might still fail to finish
    // registering. The "Retry registration" action re-runs this whole
    // function and will pick up provisioning once a later poll confirms it.
    if (!confirmedActive) {
      return { ok: true as const };
    }

    // Domain is registered but unusable for outreach until Mailgun is set up on it and the required DNS
    // records exist on the Hostinger zone. This used to be delegated to an n8n workflow that reported "success"
    // while silently never writing the DNS records at all, so it runs in-process now and every step's ACTUAL
    // result (records read back from the zone, Mailgun's own verified state) gates the next one and the stored
    // dns_status. The same idempotent routine is what the provisioning cron uses to repair a domain.
    const mailboxAddress = `sales@${domain}`;
    // Atomic upsert (unique (client_id, address)): a redelivered webhook racing a manual retry cannot create a
    // second row. A mailbox row never means "can send" - readiness is gated on Mailgun's verified domain state.
    await admin
      .from("mailboxes")
      .upsert(
        { client_id: clientId, address: mailboxAddress, warmup_day: 1, daily_send_limit: 3 },
        { onConflict: "client_id,address", ignoreDuplicates: true }
      );
    await ensureDomainProvisioned(admin, { clientId, domain, publicOrigin });

    return { ok: true as const };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Hostinger registration failed for ${domain}:`, (err as Error).message);
    // Stamp updated_at explicitly — there is no DB trigger for it, and the
    // provisioning cron uses it to space out retries of a declined charge.
    await admin
      .from("domain_purchases")
      .update({
        status: "registration_failed",
        last_error: (err as Error).message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", domainPurchaseId);
    return { ok: false as const, error: (err as Error).message };
  }
}
