import Stripe from "stripe";

/**
 * Server-only. Sandbox/test-mode Stripe client for the domain purchase flow
 * (ZERNIO_META_ADS_SPEC.md §6) — never import from a Client Component.
 */
export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return new Stripe(key);
}
