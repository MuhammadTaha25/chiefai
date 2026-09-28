#!/usr/bin/env node
/**
 * Domain onboarding diagnostic.
 *
 * Prints everything needed to answer "why is this domain stuck?" in one place:
 * the three Supabase tables the flow writes, this client's live Hostinger
 * portfolio status, and — importantly — whether each stuck purchase's Stripe
 * session was actually paid.
 *
 * Usage (from the repo root):
 *   node --env-file=.env.local scripts/check-domain-state.mjs [domain ...]
 *
 * Read-only: it never purchases, registers, or writes anything.
 */
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HG = process.env.HOSTINGER_BASE_URL ?? 'https://developers.hostinger.com';
const HK = process.env.HOSTINGER_API_KEY;

if (!url || !svc) { console.error('FATAL: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(1); }
const admin = createClient(url, svc, { auth: { persistSession: false } });
const filter = process.argv.slice(2);

const star = (s) => (filter.length ? filter.some((f) => s.includes(f)) : true);

for (const t of ['domain_purchases', 'domains', 'mailboxes']) {
  const { data, error, count } = await admin.from(t).select('*', { count: 'exact' }).limit(200);
  console.log(`\n=== ${t} (${count} rows) ===`);
  if (error) { console.log('  ERROR:', error.message); continue; }
  for (const r of data ?? []) {
    const blob = JSON.stringify(r);
    if (star(blob)) console.log('  ' + blob);
  }
}

// Hostinger is the source of truth for whether a domain is really registered.
// The LIST endpoint is the only one that reports a domain sitting at
// "pending_verification" — GET /portfolio/{domain} 404s for those.
console.log('\n=== Hostinger portfolio (live) ===');
try {
  const res = await fetch(`${HG}/api/domains/v1/portfolio`, { headers: { Authorization: `Bearer ${HK}` } });
  const list = await res.json();
  for (const d of list) console.log(`  ${String(d.domain).padEnd(26)} status=${d.status}  expires=${d.expires_at ?? '-'}`);
} catch (e) {
  console.log('  could not reach Hostinger:', e.message);
}

// A purchase stuck before registration is usually a Stripe webhook that never
// arrived. Ask Stripe directly, otherwise "pending_payment" is ambiguous.
if (process.env.STRIPE_SECRET_KEY) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { data: stuck } = await admin
    .from('domain_purchases')
    .select('domain, status, stripe_checkout_session_id')
    .in('status', ['pending_payment', 'paid', 'registering', 'registration_failed']);
  console.log('\n=== Stripe truth for non-terminal purchases ===');
  for (const p of stuck ?? []) {
    if (!star(p.domain)) continue;
    if (!p.stripe_checkout_session_id) { console.log(`  ${p.domain.padEnd(26)} db=${p.status}  no Stripe session recorded`); continue; }
    try {
      const s = await stripe.checkout.sessions.retrieve(p.stripe_checkout_session_id);
      console.log(`  ${p.domain.padEnd(26)} db=${p.status.padEnd(20)} stripe=${s.payment_status}`);
    } catch (e) {
      console.log(`  ${p.domain.padEnd(26)} db=${p.status}  stripe lookup failed: ${e.message}`);
    }
  }
}
