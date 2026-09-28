import StatCard from "@/components/stat-card";
import type { OutreachStatus } from "@/lib/outreach-status";

const INTENT_COLOR: Record<string, string> = {
  booking: "text-green-600",
  positive: "text-green-600",
  negative: "text-red-600",
  unsubscribe: "text-red-600",
  question: "text-amber-600",
  neutral: "text-zinc-500",
  out_of_office: "text-zinc-500",
};

function pipelineStep(leadStatus: string, touchCount: number): string {
  const s = leadStatus.toLowerCase();
  if (s === "unsubscribed") return "Unsubscribed";
  if (s === "replied") return "Replied";
  if (s === "booked") return "Meeting booked";
  if (s === "bounced") return "Bounced";
  if (s === "complained") return "Spam complaint";
  if (s === "stopped") return "Stopped manually";
  if (s === "exhausted") return "Sequence exhausted (no reply)";
  if (touchCount === 0) return "Queued";
  return `Touch ${touchCount} sent`;
}

export default function OutreachPipeline({ status }: { status: OutreachStatus | null }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Outreach pipeline</h2>
        {status && (
          <span className="text-xs text-zinc-500">
            Updated {new Date(status.generated_at).toLocaleTimeString()}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        Computed live from your own leads, sent emails and replies. Delivery receipts are not stored, so bounces are shown instead of a delivered count.
      </p>

      {!status ? (
        <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Could not load the outreach pipeline right now. Other dashboard data is unaffected.
        </p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Leads found" value={status.counts.leads_found} />
            <StatCard label="Emails sent" value={status.counts.emails_sent} />
            <StatCard label="Bounced" value={status.counts.bounced} />
            <StatCard label="Replies" value={status.counts.replies} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Interested" value={status.counts.interested} />
            <StatCard label="Meetings booked" value={status.counts.meetings_booked} />
            <StatCard label="Unsubscribed" value={status.counts.unsubscribed} />
            <StatCard label="Mailboxes" value={status.counts.mailboxes} />
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.145]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/[.08] text-left text-xs text-zinc-500 dark:border-white/[.145]">
                  <th className="px-4 py-3 font-medium">Lead</th>
                  <th className="px-4 py-3 font-medium">Pipeline step</th>
                  <th className="px-4 py-3 font-medium">Reply intent</th>
                  <th className="px-4 py-3 font-medium">Next touch</th>
                </tr>
              </thead>
              <tbody>
                {status.leads.map((lead) => (
                  <tr key={lead.email} className="border-b border-black/[.06] last:border-0 dark:border-white/[.08]">
                    <td className="px-4 py-3">
                      <div>{lead.name || lead.email}</div>
                      <div className="text-xs text-zinc-500">{lead.company}</div>
                    </td>
                    <td className="px-4 py-3">{pipelineStep(lead.status, lead.touch_count)}</td>
                    <td className="px-4 py-3">
                      {lead.reply_intent ? (
                        <span className={INTENT_COLOR[lead.reply_intent] ?? "text-zinc-500"}>
                          {lead.reply_intent}
                          {lead.requires_human && " (needs human)"}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-500">
                      {lead.next_touch_at ? new Date(lead.next_touch_at).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
                {status.leads.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-zinc-500">
                      No leads in the outreach sequence yet for this client.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
