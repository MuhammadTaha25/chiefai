import { resolveAppOrigin } from "@/lib/app-url";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { registerDomainAndProvision } from "@/lib/domain-registration";
import { getStripe } from "@/lib/stripe";

/**
 * Manual retry for a domain purchase stuck at registration_failed — the
 * Stripe charge already succeeded (this never touches Stripe), it just
 * re-attempts the Hostinger side using the same idempotent path the webhook
 * uses. Only valid from registration_failed: retrying a payment_failed or
 * pending_payment purchase would mean registering a domain nobody paid for.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: purchase } = await supabase
    .from("domain_purchases")
    .select("id, domain, tld, status, stripe_checkout_session_id")
    .eq("id", id)
    .eq("client_id", client.id)
    .maybeSingle<{ id: string; domain: string; tld: string; status: string; stripe_checkout_session_id: string | null }>();

  if (!purchase) {
    return NextResponse.json({ error: "Purchase not found" }, { status: 404 });
  }
  // "registering" is included alongside "registration_failed" — Hostinger's
  // own registration can still be finishing asynchronously after the order
  // was placed (confirmed live: a domain can sit un-findable in the
  // portfolio for minutes before flipping to Active), so this doubles as a
  // manual "check again" for a domain that just hasn't confirmed yet.
  // registerDomainAndProvision already treats "already registered" from a
  // repeat purchaseDomain() call as a no-op via completeDomainSetup, so
  // re-running it here is safe either way.
  if (purchase.status !== "registration_failed" && purchase.status !== "registering" && purchase.status !== "paid") {
    return NextResponse.json(
      { error: `Can only retry a failed or in-progress registration — this purchase is "${purchase.status}"` },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Fail closed on missing production config BEFORE touching any state (claim, Stripe, Hostinger).
  const publicOrigin = resolveAppOrigin(req);

  // Never register (spend) for a domain whose payment Stripe does not confirm:
  // re-check the checkout session itself, and that it belongs to THIS purchase
  // and client, before any Hostinger call.
  if (!purchase.stripe_checkout_session_id) {
    return NextResponse.json({ error: "No Stripe checkout session is recorded for this purchase" }, { status: 409 });
  }
  try {
    const session = await getStripe().checkout.sessions.retrieve(purchase.stripe_checkout_session_id);
    if (
      session.payment_status !== "paid" ||
      session.metadata?.domain_purchase_id !== purchase.id ||
      session.metadata?.client_id !== client.id
    ) {
      return NextResponse.json({ error: "Stripe does not confirm a completed payment for this purchase" }, { status: 409 });
    }
  } catch {
    return NextResponse.json({ error: "Could not verify the payment with Stripe right now — try again shortly" }, { status: 502 });
  }

  // catalog_item_id isn't stored on domain_purchases itself — re-derive the
  // same price-lookup catalog id used at checkout time from the domain's TLD.
  const { getDomainCatalogItem } = await import("@/lib/hostinger");
  const catalog = await getDomainCatalogItem(purchase.tld).catch(() => null);
  if (!catalog) {
    return NextResponse.json({ error: `Could not re-price .${purchase.tld} — try again shortly` }, { status: 502 });
  }

  // Atomic: a double-click or concurrent caller cannot start a second attempt.
  const { data: claimedRow } = await admin
    .from("domain_purchases")
    .update({ status: "registering" })
    .eq("id", purchase.id)
    .in("status", ["paid", "registration_failed", "registering"])
    .select("id");
  if (!claimedRow?.length) {
    return NextResponse.json({ error: "This purchase is no longer retryable" }, { status: 409 });
  }

  const result = await registerDomainAndProvision({
    domainPurchaseId: purchase.id,
    domain: purchase.domain,
    catalogItemId: catalog.itemId,
    clientId: client.id,
    publicOrigin,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
