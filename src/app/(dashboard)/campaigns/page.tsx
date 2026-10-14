import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentClient } from "@/lib/get-current-client";
import CampaignPanel from "@/components/campaign-panel";

interface Campaign {
  id: string;
  client_id: string;
  campaign_month: string;
  status: string;
  target_leads: number;
  generated_leads: number;
  eligible_leads: number;
  sent_count: number;
  reply_count: number;
  booking_count: number;
  created_at: string;
}

function currentCampaignMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export default async function CampaignsPage() {
  const supabase = await createClient();
  const { client } = await getCurrentClient();
  const admin = createAdminClient();

  // Fetch auto-send readiness: mailbox, timezone, and template mode.
  const [{ data: mailboxRows }, { data: clientRow }] = await Promise.all([
    client
      ? admin.from("mailboxes").select("id, daily_send_limit").eq("client_id", client.id).returns<{ id: string; daily_send_limit: number | null }[]>()
      : Promise.resolve({ data: null }),
    client
      ? admin
          .from("clients")
          .select("timezone, outreach_template_subject, outreach_template_body")
          .eq("id", client.id)
          .maybeSingle<{ timezone: string | null; outreach_template_subject: string | null; outreach_template_body: string | null }>()
      : Promise.resolve({ data: null }),
  ]);

  const hasMailbox = !!mailboxRows && mailboxRows.length > 0;
  // A mailbox with no explicit limit still sends via the warmup curve (effectiveDailyLimit
  // now returns coldLimitForAge when daily_send_limit is null), so any mailbox counts.
  const hasSendLimit = hasMailbox; // renamed for clarity — kept in place to avoid JSX churn
  const hasTimezone = !!clientRow?.timezone;
  const templateMode: "custom" | "ai" =
    clientRow?.outreach_template_subject && clientRow?.outreach_template_body ? "custom" : "ai";
  const autoSendReady = hasMailbox && hasTimezone;

  const campaignMonth = currentCampaignMonth();

  const [{ data: currentCampaign }, { data: history }] = await Promise.all([
    supabase
      .from("campaigns")
      .select("id, client_id, campaign_month, status, target_leads, generated_leads, eligible_leads, sent_count, reply_count, booking_count, created_at")
      .eq("campaign_month", campaignMonth)
      .maybeSingle<Campaign>(),
    supabase
      .from("campaigns")
      .select("id, client_id, campaign_month, status, target_leads, generated_leads, eligible_leads, sent_count, reply_count, booking_count, created_at")
      .neq("campaign_month", campaignMonth)
      .order("campaign_month", { ascending: false })
      .returns<Campaign[]>(),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
        <p className="mt-1 text-sm text-zinc-500">
          One monthly outreach cycle — fresh leads from Vibe Prospecting, deduplicated against everyone you&apos;ve
          already contacted, sent gradually with a daily limit.
        </p>
      </div>

      {/* Auto-send status banner */}
      <div className={`rounded-xl border px-4 py-3 text-sm flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4 ${
        autoSendReady
          ? "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/40"
          : "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
      }`}>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-base ${autoSendReady ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>
            {autoSendReady ? "✅" : "⚠️"}
          </span>
          <span className={`font-semibold ${autoSendReady ? "text-green-800 dark:text-green-300" : "text-amber-800 dark:text-amber-300"}`}>
            {autoSendReady ? "Auto-send active" : "Auto-send not ready"}
          </span>
        </div>
        <div className="text-zinc-600 dark:text-zinc-400 space-y-1">
          {autoSendReady ? (
            <>
              <p>
                Emails are sent automatically every day during your sending window.{" "}
                <span className="font-medium">
                  Template: {templateMode === "custom" ? "Your custom template" : "ChiefAI AI writes each email"}
                </span>
              </p>
              <p className="text-xs text-zinc-500">
                To change your email template, go to{" "}
                <a href="/campaigns/template" className="underline hover:text-zinc-700">
                  Campaigns → Template
                </a>{" "}
                or update it on the{" "}
                <a href="/settings" className="underline hover:text-zinc-700">Settings</a> page.
              </p>
            </>
          ) : (
            <ul className="space-y-0.5 list-none">
              {!hasMailbox && (
                <li>
                  • No verified mailbox —{" "}
                  <a href="/domains" className="underline hover:text-amber-800 dark:hover:text-amber-200">
                    add one under Domains
                  </a>
                </li>
              )}
              {hasMailbox && !hasSendLimit && (
                <li>
                  • Daily send limit not set —{" "}
                  <a href="/settings#mailboxes" className="underline hover:text-amber-800 dark:hover:text-amber-200">
                    set it in Settings → Mailboxes
                  </a>
                </li>
              )}
              {!hasTimezone && (
                <li>
                  • Sending timezone not set —{" "}
                  <a href="/settings#sending-schedule" className="underline hover:text-amber-800 dark:hover:text-amber-200">
                    set it in Settings → Sending Schedule
                  </a>
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      <CampaignPanel campaign={currentCampaign ?? null} />

      {history && history.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold">Previous months</h2>
          <div className="mt-3 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.145]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/[.08] text-left text-xs text-zinc-500 dark:border-white/[.145]">
                  <th className="px-4 py-3 font-medium">Month</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Generated</th>
                  <th className="px-4 py-3 font-medium">Sent</th>
                  <th className="px-4 py-3 font-medium">Replies</th>
                  <th className="px-4 py-3 font-medium">Bookings</th>
                </tr>
              </thead>
              <tbody>
                {history.map((c) => (
                  <tr key={c.id} className="border-b border-black/[.06] last:border-0 dark:border-white/[.08]">
                    <td className="px-4 py-3">
                      {new Date(c.campaign_month + "T00:00:00Z").toLocaleDateString(undefined, {
                        month: "long",
                        year: "numeric",
                        timeZone: "UTC",
                      })}
                    </td>
                    <td className="px-4 py-3 capitalize">{c.status}</td>
                    <td className="px-4 py-3">{c.generated_leads}</td>
                    <td className="px-4 py-3">{c.sent_count}</td>
                    <td className="px-4 py-3">{c.reply_count}</td>
                    <td className="px-4 py-3">{c.booking_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
