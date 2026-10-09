import { resolveAppOrigin } from "@/lib/app-url";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMailboxReadiness } from "@/lib/mailgun";
import { ensureDomainProvisioned } from "@/lib/domain-provisioning";
import { assertDomainUsableByClient } from "@/lib/domain-ownership";

const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i;

/**
 * Creates up to 5 mailboxes on a domain the client already owns (registered
 * via /api/domains/checkout + the Stripe webhook). Called from the
 * post-purchase onboarding step where the client names their team's inboxes
 * (sales@, johnson@, ...) — Hostinger/Mailgun details never reach the browser.
 */
export async function POST(req: NextRequest) {
  const { user, client, supabase } = await getCurrentClient();
  // Fail closed on missing production config before any provisioning work starts.
  const publicOrigin = resolveAppOrigin(req);
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { domain, locals } = await req.json();
  if (!domain || typeof domain !== "string") {
    return NextResponse.json({ error: "domain is required" }, { status: 400 });
  }
  if (!Array.isArray(locals) || locals.length === 0 || locals.length > 5) {
    return NextResponse.json({ error: "locals must be an array of 1-5 mailbox names" }, { status: 400 });
  }

  // The browser lands here straight off the Stripe redirect, but the `domains`
  // row is only inserted by the Stripe webhook — a separate async call that
  // still has to hit Hostinger's registration API first. A client typing a
  // mailbox name and hitting Next is often faster than that, so poll briefly
  // instead of failing on what's just a timing gap, not a real problem.
  let domainRow: { id: string } | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    // .maybeSingle() throws if more than one row matches — the webhook can
    // insert a duplicate row on Stripe's at-least-once redelivery, so query
    // for a list and just take the most recent instead of assuming one row.
    const { data } = await supabase
      .from("domains")
      .select("id")
      .eq("client_id", client.id)
      .eq("domain", domain)
      .order("created_at", { ascending: false })
      .limit(1);
    if (data && data.length > 0) {
      domainRow = data[0];
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  if (!domainRow) {
    return NextResponse.json(
      { error: "Still finishing registration — wait a few seconds and try again" },
      { status: 404 }
    );
  }

  // P0 SECURITY GATE: mailbox creation is the step that actually makes a
  // domain usable for outreach, so it is re-checked here independently of
  // ensureDomainProvisioned's own internal gate — never create a mailbox
  // row for a domain this client doesn't (or can't yet prove they) own.
  const { data: domainManagement } = await supabase
    .from("domains")
    .select("dns_managed_externally")
    .eq("client_id", client.id)
    .eq("domain", domain)
    .maybeSingle<{ dns_managed_externally: boolean | null }>();
  const usable = await assertDomainUsableByClient(createAdminClient(), client.id, domain, {
    requireExplicitOwnership: domainManagement?.dns_managed_externally === true,
  });
  if (!usable.usable) {
    const message =
      usable.reason === "owned_by_other"
        ? "This domain is connected to a different account."
        : usable.reason === "ownership_not_verified"
          ? "Verify ownership of this domain before creating mailboxes on it."
          : "Invalid domain.";
    return NextResponse.json({ error: message }, { status: 403 });
  }

  const cleanLocals = locals.map((l) => String(l).trim().toLowerCase()).filter(Boolean);
  for (const local of cleanLocals) {
    if (!LOCAL_PART_RE.test(local)) {
      return NextResponse.json({ error: `"${local}" isn't a valid mailbox name` }, { status: 400 });
    }
  }

  const created: {
    address: string;
    status: "created" | "already_exists" | "route_failed" | "verifying" | "provisioning_failed";
  }[] = [];

  for (const local of cleanLocals) {
    const address = `${local}@${domain}`;

    // The `mailboxes` table only has a SELECT RLS policy for clients (see
    // supabase/fix_all_client_rls.sql) — no INSERT policy exists, so this
    // write has to go through the admin client. Ownership is already
    // enforced above (the domain lookup and this row's client_id both tie
    // back to the authenticated client.id).
    //
    // Upsert with ignoreDuplicates (backed by the unique (client_id, address)
    // constraint — see supabase/add_domains_and_mailboxes_unique_constraints.sql)
    // instead of a select-then-insert guard: two requests for the same
    // mailbox racing each other could both pass a SELECT-based check before
    // either INSERT lands, producing two rows for the same address. The
    // upsert is atomic at the DB level; .select() on it only returns the row
    // when this call actually inserted it (a skipped conflict returns
    // nothing), so "already_exists" vs "created" is still detected correctly.
    const admin = createAdminClient();
    const { data: insertedMailbox, error: insertError } = await admin
      .from("mailboxes")
      .upsert(
        { client_id: client.id, address, warmup_day: 1, daily_send_limit: 3 },
        { onConflict: "client_id,address", ignoreDuplicates: true }
      )
      .select("id")
      .maybeSingle();

    if (insertError) {
      return NextResponse.json({ error: `Could not create ${address}: ${insertError.message}` }, { status: 500 });
    }

    if (!insertedMailbox) {
      // The row already exists — but a row is not proof of a working mailbox
      // (it is inserted BEFORE provisioning, which can fail). Only skip if
      // Mailgun confirms it's really ready; otherwise fall through and
      // re-run provisioning, which is idempotent, so a failed setup can be
      // retried instead of staying broken forever.
      if ((await getMailboxReadiness(address)) === "ready") {
        created.push({ address, status: "already_exists" });
        continue;
      }
    }

    // The Stripe webhook does this same provisioning call right after
    // registering the domain, but it can fail silently (e.g. the domain's
    // Hostinger DNS zone isn't ready yet) and there was previously no way to
    // retry it — a mailbox created afterward here (via this manual "Set up
    // mailbox" button) would insert fine in our DB but never actually exist
    // on Mailgun, so nothing could send/receive. Always (re)provision here
    // too — it's a no-op on Mailgun's side if that prefix's subdomain is
    // already active.
    // Same idempotent routine as the post-purchase flow and the cron: create the Mailgun domain, write + confirm
    // DNS, verify, and (re)register the inbound route and bounce/complaint webhooks. Safe to repeat, so a failed
    // earlier setup is repaired here instead of staying broken.
    const outcome = await ensureDomainProvisioned(admin, { clientId: client.id, domain, publicOrigin });
    const routeOk = !outcome.notes.some((n) => n.startsWith("inbound route"));
    created.push({
      address,
      status:
        outcome.state === "active" ? (routeOk ? "created" : "route_failed") : outcome.state === "pending" ? "verifying" : "provisioning_failed",
    });
  }

  return NextResponse.json({ ok: true, mailboxes: created });
}
