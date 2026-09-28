import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import IntegrationsPanel from "@/components/integrations-panel";
import CalendlySettings from "@/components/calendly-settings";
import VoiceNumberPanel from "@/components/voice-number-panel";

interface SocialConnection {
  id: string;
  platform: string;
  connection_status: string | null;
  connected_at: string | null;
}
interface Domain {
  id: string;
  domain: string;
  dns_status: string | null;
}
interface Mailbox {
  id: string;
  address: string;
  warmup_day: number | null;
  daily_send_limit: number | null;
}

export default async function SettingsPage(props: {
  searchParams: Promise<{
    zernio_connected?: string;
    zernio_error?: string;
    calendly_connected?: string;
    calendly_error?: string;
    leads_connected?: string;
    leads_error?: string;
    vibe_prospecting_connected?: string;
    vibe_prospecting_error?: string;
  }>;
}) {
  const searchParams = await props.searchParams;
  const supabase = await createClient();

  const [
    { data: connections },
    { data: domains },
    { data: mailboxes },
    { data: client },
    { data: voiceNumber },
    { data: leadsConnection },
    { data: vibeProspectingConnection },
  ] = await Promise.all([
    supabase.from("social_connections").select("*").returns<SocialConnection[]>(),
    supabase.from("domains").select("*").returns<Domain[]>(),
    supabase.from("mailboxes").select("*").returns<Mailbox[]>(),
    supabase
      .from("clients")
      .select("calendly_url, calendly_connected_at, calendly_webhook_uri")
      .maybeSingle<{ calendly_url: string | null; calendly_connected_at: string | null; calendly_webhook_uri: string | null }>(),
    supabase
      .from("client_phone_numbers")
      .select("twilio_number, status")
      .eq("status", "active")
      .limit(1)
      .maybeSingle<{ twilio_number: string; status: string }>(),
    // Account-level connections, not client-scoped — admin client bypasses
    // RLS deliberately (see supabase/add_leads_mcp_connection_table.sql).
    createAdminClient()
      .from("leads_mcp_connection")
      .select("connected_at")
      .eq("id", "default")
      .maybeSingle<{ connected_at: string | null }>(),
    createAdminClient()
      .from("leads_mcp_connection")
      .select("connected_at")
      .eq("id", "vibe_prospecting")
      .maybeSingle<{ connected_at: string | null }>(),
  ]);

  return (
    <div className="space-y-10">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      {searchParams.zernio_connected && (
        <p className="rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
          Connected {searchParams.zernio_connected.replace("_", " ")}.
        </p>
      )}
      {searchParams.zernio_error && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
          Connection failed: {searchParams.zernio_error}
        </p>
      )}
      {searchParams.calendly_connected && (
        <p className="rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
          Calendly connected.
        </p>
      )}
      {searchParams.calendly_error && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
          Calendly connection failed: {searchParams.calendly_error}
        </p>
      )}
      {searchParams.leads_connected && (
        <p className="rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
          Frontage Leads connected.
        </p>
      )}
      {searchParams.leads_error && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
          Frontage Leads connection failed: {searchParams.leads_error}
        </p>
      )}
      {searchParams.vibe_prospecting_connected && (
        <p className="rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
          Vibe Prospecting connected.
        </p>
      )}
      {searchParams.vibe_prospecting_error && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
          Vibe Prospecting connection failed: {searchParams.vibe_prospecting_error}
        </p>
      )}

      <section>
        <h2 className="text-lg font-semibold">Business Profile</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Industry, ICP, marketing voice, and brand details used by AI content generation and lead targeting.
        </p>
        <Link
          href="/settings/business-profile"
          className="mt-3 inline-block rounded-md border border-black/[.1] px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-white/[.145] dark:hover:bg-zinc-900"
        >
          Edit Business Profile
        </Link>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Integrations</h2>
        <IntegrationsPanel connections={connections ?? []} />
      </section>

      <section>
        <h2 className="text-lg font-semibold">Calendly</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Your scheduling link, sent to leads during outreach.{" "}
          {client?.calendly_webhook_uri
            ? "Bookings arrive instantly through your Calendly webhook."
            : client?.calendly_connected_at
              ? "Bookings are synced from Calendly every few minutes (Calendly webhooks need a paid Calendly plan)."
              : "Connect Calendly so bookings are picked up automatically."}
        </p>
        <CalendlySettings initialUrl={client?.calendly_url ?? ""} connected={Boolean(client?.calendly_connected_at)} />
      </section>

      <section>
        <h2 className="text-lg font-semibold">Lead Prospecting (Frontage Leads)</h2>
        <p className="mt-1 text-sm text-zinc-500">
          One account-level connection — every client&apos;s lead search draws credits from this
          single Frontage Leads subscription.
        </p>
        <div className="mt-3 flex items-center gap-3">
          {leadsConnection?.connected_at ? (
            <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800 dark:bg-green-950 dark:text-green-300">
              Connected
            </span>
          ) : (
            <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              Not connected
            </span>
          )}
          <a
            href="/api/leads/connect"
            className="rounded-md border border-black/[.1] px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-white/[.145] dark:hover:bg-zinc-900"
          >
            {leadsConnection?.connected_at ? "Reconnect" : "Connect with Frontage Leads"}
          </a>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Vibe Prospecting</h2>
        <p className="mt-1 text-sm text-zinc-500">
          One account-level connection — every client&apos;s prospecting request draws credits from
          this single account.
        </p>
        <div className="mt-3 flex items-center gap-3">
          {vibeProspectingConnection?.connected_at ? (
            <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800 dark:bg-green-950 dark:text-green-300">
              Connected
            </span>
          ) : (
            <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              Not connected
            </span>
          )}
          <a
            href="/api/vibe-prospecting/connect"
            className="rounded-md border border-black/[.1] px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-white/[.145] dark:hover:bg-zinc-900"
          >
            {vibeProspectingConnection?.connected_at ? "Reconnect" : "Connect Vibe Prospecting"}
          </a>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Voice Agent</h2>
        <p className="mt-1 text-sm text-zinc-500">
          A dedicated phone number for your business. Call it any time for a spoken summary of
          leads, outreach, social posts, and ad spend.
        </p>
        <div className="mt-3">
          <VoiceNumberPanel initialNumber={voiceNumber?.twilio_number ?? null} initialStatus={voiceNumber?.status ?? null} />
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Domains</h2>
        <div className="mt-3 space-y-2">
          {(domains ?? []).map((d) => (
            <div key={d.id} className="flex items-center justify-between rounded-md border border-black/[.08] px-4 py-3 text-sm dark:border-white/[.145]">
              <span>{d.domain}</span>
              <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-800">{d.dns_status || "pending"}</span>
            </div>
          ))}
          {(!domains || domains.length === 0) && (
            <p className="text-sm text-zinc-500">No domains provisioned yet.</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Mailboxes</h2>
        <div className="mt-3 space-y-2">
          {(mailboxes ?? []).map((m) => (
            <div key={m.id} className="flex items-center justify-between rounded-md border border-black/[.08] px-4 py-3 text-sm dark:border-white/[.145]">
              <span>{m.address}</span>
              <span className="text-xs text-zinc-500">
                Warmup day {m.warmup_day ?? 0} · {m.daily_send_limit ?? 0}/day
              </span>
            </div>
          ))}
          {(!mailboxes || mailboxes.length === 0) && (
            <p className="text-sm text-zinc-500">No mailboxes provisioned yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}
