import { resolveAppOrigin } from "@/lib/app-url";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { registerDomainAndProvision } from "@/lib/domain-registration";
import { unsignedWebhooksAllowed } from "@/lib/webhook-security";
import { logEvent } from "@/lib/log-event";

/**
 * ZERNIO_META_ADS_SPEC.md §6 step 5: once the Stripe charge succeeds,
 * actually register the domain via Hostinger. Doing this from the webhook
 * (not the checkout-creation route) means it fires even if the client closes
 * the tab right after paying.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event: Stripe.Event;
  const stripe = getStripe();

  // Fail-closed. This webhook triggers a REAL Hostinger domain registration
  // (spend), so an unsigned/forged "checkout.session.completed" must never be
  // accepted. Unsigned events are only possible with the explicit dev flag,
  // which is ignored in production builds.
  if (webhookSecret && signature) {
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch {
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }
  } else if (unsignedWebhooksAllowed()) {
    try {
      event = JSON.parse(rawBody) as Stripe.Event;
    } catch {
      return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: "Missing signature or webhook secret" }, { status: 401 });
  }

  if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
    const failed = event.data.object as Stripe.Checkout.Session;
    const purchaseId = failed.metadata?.domain_purchase_id;
    if (purchaseId) {
      // Only ever moves a still-unpaid row; never touches paid/registered purchases.
      await createAdminClient()
        .from("domain_purchases")
        .update({ status: "payment_failed" })
        .eq("id", purchaseId)
        .eq("status", "pending_payment")
        .eq("stripe_checkout_session_id", failed.id);
    }
    return NextResponse.json({ ok: true, recorded: event.type });
  }

  if (event.type !== "checkout.session.completed") {
    return NextResponse.json({ ok: true, ignored: event.type });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const domainPurchaseId = session.metadata?.domain_purchase_id;
  const catalogItemId = session.metadata?.catalog_item_id;
  const domain = session.metadata?.domain;
  const clientId = session.metadata?.client_id;

  if (!domainPurchaseId || !catalogItemId || !domain || !clientId) {
    return NextResponse.json({ error: "Missing metadata on checkout session" }, { status: 400 });
  }

  // Fail closed on missing production config before any state change (Stripe will redeliver on a 5xx).
  const publicOrigin = resolveAppOrigin(req);

  // Only a genuinely paid session may trigger registration.
  if (session.payment_status !== "paid") {
    return NextResponse.json({ ok: true, ignored: `payment_status ${session.payment_status}` });
  }

  const admin = createAdminClient();

  // Stripe delivers webhooks at-least-once — the same checkout.session.completed
  // event (or a manual redelivery) can arrive more than once. Without this
  // check, a redelivery re-runs the Hostinger registration for an
  // already-registered domain: harmless in the common case (Hostinger 422s
  // "already registered"), but a real risk of a second Hostinger-side charge
  // if that check ever doesn't hold. Short-circuit on business state instead
  // of just Stripe's event id, since that also covers a manual re-trigger.
  // Trust our own row, not just session metadata: it must exist, belong to the
  // client/domain named in the metadata, and be the session Stripe reports.
  const { data: existingPurchase } = await admin
    .from("domain_purchases")
    .select("status, client_id, domain, stripe_checkout_session_id")
    .eq("id", domainPurchaseId)
    .maybeSingle<{ status: string; client_id: string; domain: string; stripe_checkout_session_id: string | null }>();

  if (
    !existingPurchase ||
    existingPurchase.client_id !== clientId ||
    existingPurchase.domain !== domain ||
    (existingPurchase.stripe_checkout_session_id && existingPurchase.stripe_checkout_session_id !== session.id)
  ) {
    // eslint-disable-next-line no-console
    console.error(`[stripe] checkout ${session.id} metadata does not match domain_purchases ${domainPurchaseId}; ignored`);
    logEvent("stripe.checkout_completed", { client_id: clientId, purchase_id: domainPurchaseId, provider_event_id: event.id, result: "ignored_purchase_mismatch" });
    return NextResponse.json({ ok: true, ignored: "purchase mismatch" });
  }

  if (existingPurchase.status === "registered" || existingPurchase.status === "registering") {
    return NextResponse.json({ ok: true, already_registered: existingPurchase.status === "registered", in_progress: existingPurchase.status === "registering" });
  }

  // Atomic claim: only one concurrent delivery can flip the row into "registering".
  const { data: claimed } = await admin
    .from("domain_purchases")
    .update({
      status: "registering",
      stripe_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : null,
    })
    .eq("id", domainPurchaseId)
    .in("status", ["pending_payment", "paid", "registration_failed", "payment_failed"])
    .select("id");
  if (!claimed?.length) return NextResponse.json({ ok: true, in_progress: true });

  logEvent("stripe.checkout_completed", { client_id: clientId, purchase_id: domainPurchaseId, provider_event_id: event.id, domain, result: "registration_started" });
  await registerDomainAndProvision({
    domainPurchaseId,
    domain,
    catalogItemId,
    clientId,
    publicOrigin,
  });

  // Always 200 — Stripe already has our money; a failed Hostinger call needs
  // manual/retry handling (see /api/domains/purchases/[id]/retry), not a
  // Stripe webhook redelivery storm.
  return NextResponse.json({ ok: true });
}
