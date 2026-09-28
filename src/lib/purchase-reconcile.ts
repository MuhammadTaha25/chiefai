import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { getPortfolioStatus, getDomainCatalogItem } from "@/lib/hostinger";
import { registerDomainAndProvision } from "@/lib/domain-registration";

// How long a checkout may sit at "pending_payment" before we go ask Stripe
// about it ourselves.
//
// Deliberately short. The long 30-minute wait this used to be assumed the
// checkout.session.completed webhook is the primary path and Stripe only needs
// a late backstop — but a webhook that never arrives (no Stripe CLI forwarding
// to localhost, a dropped delivery, a tunnel that was down) left a genuinely
// PAID purchase invisible to the app for half an hour, with no domain ordered
// at Hostinger and the client staring at "confirming payment". Confirmed live:
// several purchases sat at pending_payment while Stripe reported
// payment_status "paid" for every one of them.
//
// Asking earlier is safe: a session only reports "paid" once the buyer has
// finished, so a still-open checkout simply gets skipped and re-checked on the
// next run. This is what makes the flow self-healing instead of dependent on a
// webhook, a browser visit, or a human.
const PENDING_GRACE_MS = 2 * 60 * 1000;
const REGISTERING_GRACE_MS = 24 * 3600 * 1000;

interface Purchase {
  id: string;
  client_id: string;
  domain: string;
  status: string;
  created_at: string;
  stripe_checkout_session_id: string | null;
}

/**
 * Keeps domain_purchases from sitting in a false pending state forever
 * (e.g. Stripe's webhook never reached us). It ONLY makes state truthful and
 * never spends money: registration is still triggered by the verified webhook
 * or the explicit Retry action.
 *  - pending_payment: ask Stripe. expired -> payment_failed; paid -> paid
 *    (payment confirmed, registration outstanding); still open -> untouched.
 *  - registering > 24h and Hostinger does not list it as Active -> registration_failed
 *    (so the UI offers Retry instead of spinning forever).
 * Every transition is conditional on the row still being in the state we read,
 * so it cannot race the webhook.
 */
export async function reconcileStuckPurchases(admin: SupabaseClient, clientId?: string) {
  const out = { toPaid: 0, toPaymentFailed: 0, toRegistrationFailed: 0, toRegistered: 0 };
  let q = admin
    .from("domain_purchases")
    .select("id, client_id, domain, status, created_at, stripe_checkout_session_id")
    .in("status", ["pending_payment", "registering"]);
  if (clientId) q = q.eq("client_id", clientId);
  const { data } = await q.returns<Purchase[]>();

  for (const p of data ?? []) {
    const age = Date.now() - new Date(p.created_at).getTime();
    if (p.status === "pending_payment" && age > PENDING_GRACE_MS && p.stripe_checkout_session_id) {
      try {
        const s = await getStripe().checkout.sessions.retrieve(p.stripe_checkout_session_id);
        if (s.payment_status === "paid") {
          const { data: r } = await admin.from("domain_purchases").update({ status: "paid", stripe_payment_intent_id: typeof s.payment_intent === "string" ? s.payment_intent : null }).eq("id", p.id).eq("status", "pending_payment").select("id");
          if (r?.length) out.toPaid++;
        } else if (s.status === "expired") {
          const { data: r } = await admin.from("domain_purchases").update({ status: "payment_failed" }).eq("id", p.id).eq("status", "pending_payment").select("id");
          if (r?.length) out.toPaymentFailed++;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[reconcile] stripe lookup failed purchase=${p.id} client=${p.client_id}: ${(e as Error).message}`);
      }
    } else if (p.status === "registering" && age > REGISTERING_GRACE_MS) {
      const hs = await getPortfolioStatus(p.domain).catch(() => null);
      if (hs && hs.toLowerCase() === "active") {
        const { data: r } = await admin.from("domain_purchases").update({ status: "registered" }).eq("id", p.id).eq("status", "registering").select("id");
        if (r?.length) out.toRegistered++;
      } else {
        const { data: r } = await admin.from("domain_purchases").update({ status: "registration_failed", last_error: "Hostinger did not confirm this registration within 24h. Use Retry." }).eq("id", p.id).eq("status", "registering").select("id");
        if (r?.length) out.toRegistrationFailed++;
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[reconcile] domain_purchases ${JSON.stringify(out)}`);
  return out;
}

/**
 * Confirms the payment for the purchase the buyer has just returned from
 * Stripe with, and starts registration right away.
 *
 * The redirect itself proves NOTHING: `?domain_purchase=success` is merely a
 * URL Stripe was told to send the browser to, and it is trivially forgeable.
 * So this asks Stripe what actually happened to THIS purchase's own checkout
 * session before changing any state.
 *
 * This exists because the app otherwise learns a payment succeeded ONLY from
 * the `checkout.session.completed` webhook. A webhook that never arrives — no
 * Stripe CLI forwarding to localhost, a dropped delivery, a tunnel that was
 * down — leaves the purchase parked at "pending_payment" forever even though
 * Stripe already holds the money. Confirmed live: two purchases sat at
 * pending_payment while Stripe reported payment_status "paid" for both.
 *
 * Registration is still gated on the payment Stripe itself confirms here, so
 * this can never register a domain nobody paid for.
 */
export async function confirmCheckoutReturn(
  admin: SupabaseClient,
  params: { clientId: string; domain: string; publicOrigin: string }
): Promise<{ confirmed: boolean; reason: string }> {
  const { clientId, domain, publicOrigin } = params;

  const { data: purchase } = await admin
    .from("domain_purchases")
    .select("id, domain, tld, status, stripe_checkout_session_id")
    .eq("client_id", clientId)
    .eq("domain", domain)
    .in("status", ["pending_payment", "paid"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{
      id: string;
      domain: string;
      tld: string;
      status: string;
      stripe_checkout_session_id: string | null;
    }>();

  // Nothing open for this domain — either it is already registered (fine) or
  // there is no purchase at all. Either way there is nothing to confirm, and
  // the caller must not report success.
  if (!purchase) return { confirmed: false, reason: "no open purchase for this domain" };
  if (!purchase.stripe_checkout_session_id) return { confirmed: false, reason: "no Stripe session recorded" };

  let session;
  try {
    session = await getStripe().checkout.sessions.retrieve(purchase.stripe_checkout_session_id);
  } catch (e) {
    return { confirmed: false, reason: `Stripe lookup failed: ${(e as Error).message}` };
  }

  if (session.payment_status !== "paid") return { confirmed: false, reason: `Stripe says ${session.payment_status}` };
  if (session.metadata?.domain_purchase_id && session.metadata.domain_purchase_id !== purchase.id) {
    return { confirmed: false, reason: "session metadata does not match this purchase" };
  }

  // Atomic claim, identical to the webhook's: if Stripe's webhook DOES arrive
  // too, only one of the two callers can start registration.
  const { data: claimed } = await admin
    .from("domain_purchases")
    .update({
      status: "registering",
      stripe_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : null,
    })
    .eq("id", purchase.id)
    .in("status", ["pending_payment", "paid"])
    .select("id");
  if (!claimed?.length) return { confirmed: false, reason: "already being registered by another caller" };

  const catalog = await getDomainCatalogItem(purchase.tld).catch(() => null);
  if (!catalog) {
    // Payment IS confirmed and already recorded as "registering"; the
    // domain-provisioning cron picks it up once pricing resolves again.
    return { confirmed: true, reason: "payment confirmed, pricing lookup failed" };
  }

  const result = await registerDomainAndProvision({
    domainPurchaseId: purchase.id,
    domain: purchase.domain,
    catalogItemId: catalog.itemId,
    clientId,
    publicOrigin,
  });

  return {
    confirmed: true,
    reason: result.ok ? "registration started" : `registration failed: ${result.error}`,
  };
}
