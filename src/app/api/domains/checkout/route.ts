import { resolveAppOrigin } from "@/lib/app-url";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { getStripe } from "@/lib/stripe";
import { getDomainCatalogItem, sellPriceForCatalogPrice } from "@/lib/hostinger";

export async function POST(req: NextRequest) {
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { domain, catalog_item_id } = await req.json();
  if (!domain || typeof domain !== "string") {
    return NextResponse.json({ error: "domain is required" }, { status: 400 });
  }
  if (!catalog_item_id || typeof catalog_item_id !== "string") {
    return NextResponse.json({ error: "catalog_item_id is required — search for the domain first" }, { status: 400 });
  }

  const tld = domain.split(".").slice(1).join(".");

  // Recompute the price server-side from Hostinger's own catalog instead of
  // trusting anything price-related from the client — the request body only
  // carries catalog_item_id (which item to buy), never what to charge for it.
  const catalog = await getDomainCatalogItem(tld).catch(() => null);
  if (!catalog) {
    return NextResponse.json({ error: `Could not price .${tld} — try searching again` }, { status: 502 });
  }
  const sellPrice = sellPriceForCatalogPrice(catalog.price);

  const { data: purchase, error: insertError } = await supabase
    .from("domain_purchases")
    .insert({
      client_id: client.id,
      domain,
      tld,
      amount_cents: sellPrice.amountMinorUnits,
      currency: sellPrice.currency.toLowerCase(),
      status: "pending_payment",
    })
    .select()
    .single();

  if (insertError || !purchase) {
    return NextResponse.json(
      { error: `Could not start domain purchase (has the domain_purchases table been created yet?): ${insertError?.message}` },
      { status: 500 }
    );
  }

  const origin = resolveAppOrigin(req, { preferEnv: false });

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: sellPrice.currency.toLowerCase(),
            unit_amount: sellPrice.amountMinorUnits,
            product_data: { name: `Domain registration — ${domain}` },
          },
          quantity: 1,
        },
      ],
      // Receipt goes to the authenticated buyer — never a fixed address.
      ...(user.email ? { customer_email: user.email } : {}),
      metadata: {
        domain_purchase_id: purchase.id,
        client_id: client.id,
        domain,
        catalog_item_id,
      },
      success_url: `${origin}/domains?domain_purchase=success&domain=${encodeURIComponent(domain)}`,
      cancel_url: `${origin}/domains?domain_purchase=cancelled`,
    });

    await supabase
      .from("domain_purchases")
      .update({ stripe_checkout_session_id: session.id })
      .eq("id", purchase.id);

    return NextResponse.json({ ok: true, checkout_url: session.url });
  } catch (err) {
    await supabase
      .from("domain_purchases")
      .update({ status: "payment_failed", last_error: (err as Error).message })
      .eq("id", purchase.id);
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
