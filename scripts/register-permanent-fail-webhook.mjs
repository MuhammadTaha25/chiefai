#!/usr/bin/env node
/**
 * Registers the Mailgun "permanent_fail" (hard bounce) webhook on every Mailgun domain that already
 * has a mailbox. New domains get it from registerTrackingWebhooks(); this backfills existing ones.
 *
 * Usage (repo root):
 *   node --env-file=.env.local scripts/register-permanent-fail-webhook.mjs          # dry run
 *   node --env-file=.env.local scripts/register-permanent-fail-webhook.mjs --apply  # write
 *
 * Idempotent: a domain whose webhook already points at the right URL is skipped; one pointing elsewhere
 * is updated (PUT) — only the permanent_fail hook is ever touched.
 */
import { createClient } from "@supabase/supabase-js";

const apply = process.argv.includes("--apply");
const base = process.env.MAILGUN_API_BASE_URL ?? "https://api.mailgun.net/v3";
const auth = "Basic " + Buffer.from(`api:${process.env.MAILGUN_API_KEY}`).toString("base64");
const appUrl = (process.env.PUBLIC_APP_URL ?? "").replace(/\/$/, "");
if (!process.env.MAILGUN_API_KEY || !appUrl) throw new Error("MAILGUN_API_KEY and PUBLIC_APP_URL are required");
const target = `${appUrl}/api/webhooks/mailgun/events`;

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: mailboxes, error } = await admin.from("mailboxes").select("address");
if (error) throw new Error(error.message);
const domains = [...new Set(mailboxes.map((m) => m.address.slice(m.address.lastIndexOf("@") + 1).trim().toLowerCase()))];

console.log(`${apply ? "APPLY" : "DRY RUN"} -> ${target}\n${domains.length} mailgun domain(s)`);
for (const d of domains) {
  const get = await fetch(`${base}/domains/${d}/webhooks`, { headers: { Authorization: auth } });
  if (!get.ok) { console.log(`${d}: cannot read webhooks (${get.status})`); continue; }
  const hooks = (await get.json()).webhooks ?? {};
  const current = hooks.permanent_fail?.urls ?? (hooks.permanent_fail?.url ? [hooks.permanent_fail.url] : []);
  if (current.includes(target)) { console.log(`${d}: already registered`); continue; }
  const exists = current.length > 0;
  console.log(`${d}: ${exists ? "update" : "register"} permanent_fail${apply ? "" : " (not applied)"}`);
  if (!apply) continue;
  const res = await fetch(`${base}/domains/${d}/webhooks${exists ? "/permanent_fail" : ""}`, {
    method: exists ? "PUT" : "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(exists ? { url: target } : { id: "permanent_fail", url: target }),
  });
  console.log(`  -> ${res.status}${res.ok ? "" : " " + (await res.text()).slice(0, 200)}`);
}
