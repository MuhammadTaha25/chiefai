import { NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { getMailboxReadiness } from "@/lib/mailgun";
import { buildDomainPipeline } from "@/lib/domain-pipeline";

/**
 * Live pipeline status for the signed-in client's domains: payment -> registration -> DNS/Mailgun -> mailboxes.
 * Read-only and scoped to the session's own client (RLS client + explicit client_id filter); polled by the
 * Domains page. Stage states come from stored, provider-verified state, never from a UI-side guess.
 */
export async function GET() {
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const [{ data: purchases }, { data: domains }, { data: mailboxes }] = await Promise.all([
    supabase
      .from("domain_purchases")
      .select("id, domain, status, last_error, created_at")
      .eq("client_id", client.id)
      .order("created_at", { ascending: false })
      .returns<{ id: string; domain: string; status: string; last_error: string | null }[]>(),
    supabase.from("domains").select("domain, dns_status").eq("client_id", client.id).returns<{ domain: string; dns_status: string | null }[]>(),
    supabase.from("mailboxes").select("address").eq("client_id", client.id).returns<{ address: string }[]>(),
  ]);

  // Newest purchase per domain wins.
  const latest = new Map<string, { id: string; domain: string; status: string; last_error: string | null }>();
  for (const p of purchases ?? []) if (!latest.has(p.domain)) latest.set(p.domain, p);

  const pipelines = await Promise.all(
    [...latest.values()].map(async (p) => {
      const onDomain = (mailboxes ?? []).filter((m) => m.address.toLowerCase().endsWith(`@${p.domain.toLowerCase()}`));
      const readiness = p.status === "registered" ? await Promise.all(onDomain.map((m) => getMailboxReadiness(m.address))) : onDomain.map(() => "pending");
      return buildDomainPipeline({
        domain: p.domain,
        purchaseId: p.id,
        purchaseStatus: p.status,
        lastError: p.last_error,
        dnsStatus: (domains ?? []).find((d) => d.domain === p.domain)?.dns_status ?? null,
        mailboxReadiness: readiness,
      });
    })
  );

  return NextResponse.json({ ok: true, pipelines, inProgress: pipelines.some((p) => p.inProgress) });
}
