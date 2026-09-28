"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lead, LeadStatus } from "@/types/db";

interface OutreachEntry {
  id: string;
  subject: string | null;
  body: string | null;
  touch_number: number;
  sent_at: string;
}

const STATUS_GROUPS: { label: string; statuses: LeadStatus[] }[] = [
  { label: "All", statuses: [] },
  { label: "Inbound (ads)", statuses: [] },
  { label: "Outbound (email)", statuses: [] },
  { label: "New / researching", statuses: ["new", "researching", "qualified"] },
  {
    label: "In outreach",
    statuses: [
      "email_sent", "waiting_for_reply",
      "follow_up_1", "follow_up_2", "follow_up_3", "follow_up_4", "follow_up_5",
      "follow_up_6", "follow_up_7", "follow_up_8", "follow_up_9", "follow_up_10",
    ],
  },
  { label: "Responded", statuses: ["responded", "analyzing", "positive", "angry", "booking"] },
  { label: "Pipeline", statuses: ["appointment_booked", "proposal", "negotiation"] },
  { label: "Closed", statuses: ["won", "lost", "dropped"] },
];

/**
 * What to show for a lead, derived from real state. `status` alone is not
 * enough: "booking" is only the AI's read of a reply (a Calendly link may
 * have been sent, nothing booked), while `booked` is true only after
 * Calendly's webhook confirmed an actual booking. Stop flags win over status
 * so a stopped lead never looks like it is still in play.
 */
type BookingInfo = { scheduled_at: string | null; booking_status: string };

function bookingDetail(b?: BookingInfo): string | null {
  if (!b) return null;
  if (b.booking_status === "canceled") return "Booking canceled";
  if (!b.scheduled_at) return null;
  return new Date(b.scheduled_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

function leadDisplay(lead: Lead): { label: string; cls: string; stopped: boolean } {
  const red = "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
  if (lead.booked) return { label: "Booked", cls: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300", stopped: true };
  if (lead.unsubscribed) return { label: "Stopped — unsubscribed", cls: red, stopped: true };
  if (lead.complained) return { label: "Stopped — complaint", cls: red, stopped: true };
  if (lead.email_bounced) return { label: "Bounced", cls: red, stopped: true };
  if (lead.manually_stopped) return { label: "Stopped — manual", cls: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400", stopped: true };
  if (lead.reply_classification === "BOOKING")
    return { label: "Wants to book (not booked yet)", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300", stopped: false };
  return {
    label: lead.status.replace(/_/g, " "),
    cls: STATUS_COLORS[lead.status] ?? "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    stopped: false,
  };
}

const STATUS_COLORS: Partial<Record<LeadStatus, string>> = {
  won: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  positive: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  lost: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  angry: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  dropped: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  appointment_booked: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
};

interface DraftState {
  leadId: string;
  leadName: string;
  subject: string;
  body: string;
  loading: boolean;
  sending: boolean;
  error: string | null;
}

export default function LeadsTable({
  leads,
  bookings = {},
}: {
  leads: Lead[];
  bookings?: Record<string, BookingInfo>;
}) {
  const router = useRouter();
  const [group, setGroup] = useState(0);
  const [search, setSearch] = useState("");
  const [expandedLeadId, setExpandedLeadId] = useState<string | null>(null);
  const [outreachByLead, setOutreachByLead] = useState<Record<string, OutreachEntry[]>>({});
  const [loadingLeadId, setLoadingLeadId] = useState<string | null>(null);
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);

  async function openDraft(lead: Lead) {
    setDraft({ leadId: lead.id, leadName: lead.name || lead.email || "this lead", subject: "", body: "", loading: true, sending: false, error: null });
    try {
      const res = await fetch(`/api/leads/${lead.id}/draft-email`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not draft email");
      setDraft({ leadId: lead.id, leadName: lead.name || lead.email || "this lead", subject: data.subject, body: data.body, loading: false, sending: false, error: null });
    } catch (err) {
      setDraft((prev) => (prev ? { ...prev, loading: false, error: (err as Error).message } : prev));
    }
  }

  async function sendDraft(confirmOverride = false) {
    if (!draft) return;
    setDraft({ ...draft, sending: true, error: null });
    try {
      const res = await fetch(`/api/leads/${draft.leadId}/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: draft.subject, body: draft.body, ...(confirmOverride ? { confirm_override: true } : {}) }),
      });
      const data = await res.json();
      if (res.status === 409 && data.code === "needs_confirm") {
        // Replied / booked / manually-stopped lead: sending is allowed only after an explicit human confirmation.
        if (window.confirm(`${data.error}

This sends a real email.`)) return sendDraft(true);
        setDraft((prev) => (prev ? { ...prev, sending: false } : prev));
        return;
      }
      if (!res.ok) throw new Error(data.error || "Send failed");
      setDraft(null);
      setOutreachByLead((prev) => {
        const next = { ...prev };
        delete next[draft.leadId];
        return next;
      });
      router.refresh();
    } catch (err) {
      setDraft((prev) => (prev ? { ...prev, sending: false, error: (err as Error).message } : prev));
    }
  }

  async function toggleLead(leadId: string) {
    if (expandedLeadId === leadId) {
      setExpandedLeadId(null);
      return;
    }
    setExpandedLeadId(leadId);
    setExpandedEntryId(null);
    if (!outreachByLead[leadId]) {
      setLoadingLeadId(leadId);
      try {
        const res = await fetch(`/api/leads/${leadId}/outreach`);
        const data = await res.json();
        setOutreachByLead((prev) => ({ ...prev, [leadId]: res.ok ? data.outreach : [] }));
      } finally {
        setLoadingLeadId(null);
      }
    }
  }

  const filtered = useMemo(() => {
    const statuses = STATUS_GROUPS[group].statuses;
    return leads.filter((l) => {
      if (group === 1 && l.lead_type !== "inbound") return false;
      if (group === 2 && l.lead_type !== "outbound") return false;
      if (statuses.length && !statuses.includes(l.status)) return false;
      if (search) {
        const s = search.toLowerCase();
        return (
          l.name?.toLowerCase().includes(s) ||
          l.company?.toLowerCase().includes(s) ||
          l.email?.toLowerCase().includes(s)
        );
      }
      return true;
    });
  }, [leads, group, search]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_GROUPS.map((g, i) => (
          <button
            key={g.label}
            onClick={() => setGroup(i)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${
              group === i
                ? "bg-foreground text-background"
                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
            }`}
          >
            {g.label}
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, company, email…"
          className="ml-auto rounded-md border border-black/[.1] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-transparent"
        />
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.145]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/[.08] text-left text-xs text-zinc-500 dark:border-white/[.145]">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Company</th>
              <th className="px-4 py-3 font-medium">Title</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Source</th>
              <th className="px-4 py-3 font-medium">Last contact</th>
              <th className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((lead) => (
              <Fragment key={lead.id}>
                <tr
                  onClick={() => toggleLead(lead.id)}
                  className="cursor-pointer border-b border-black/[.06] last:border-0 hover:bg-black/[.02] dark:border-white/[.08] dark:hover:bg-white/[.04]"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium">{lead.name || "—"}</div>
                    <div className="text-xs text-zinc-500">{lead.email}</div>
                  </td>
                  <td className="px-4 py-3">{lead.company || "—"}</td>
                  <td className="px-4 py-3">{lead.job_title || "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-1 text-xs font-medium ${leadDisplay(lead).cls}`}>
                      {leadDisplay(lead).label}
                    </span>
                    {lead.booked && bookingDetail(bookings[lead.id]) && (
                      <p className="mt-1 text-xs text-zinc-500">{bookingDetail(bookings[lead.id])}</p>
                    )}
                    {!leadDisplay(lead).stopped && lead.next_follow_up_at && (
                      <p className="mt-1 text-xs text-zinc-500">
                        Follow-up scheduled {new Date(lead.next_follow_up_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${
                        lead.lead_type === "inbound"
                          ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                          : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                      }`}
                    >
                      {lead.lead_type === "inbound" ? "Inbound" : "Outbound"}
                    </span>
                  </td>
                  <td className="px-4 py-3">{lead.lead_source || "—"}</td>
                  <td className="px-4 py-3 text-zinc-500">
                    {lead.last_contact_at ? new Date(lead.last_contact_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openDraft(lead);
                      }}
                      disabled={!lead.email || leadDisplay(lead).stopped}
                      title={leadDisplay(lead).stopped ? "Outreach is stopped for this lead" : undefined}
                      className="rounded-md border border-black/[.08] px-3 py-1.5 text-xs font-medium hover:bg-black/[.03] disabled:opacity-40 dark:border-white/[.145] dark:hover:bg-white/[.06]"
                    >
                      Draft &amp; send
                    </button>
                  </td>
                </tr>
                {expandedLeadId === lead.id && (
                  <tr className="border-b border-black/[.06] bg-black/[.015] last:border-0 dark:border-white/[.08] dark:bg-white/[.02]">
                    <td colSpan={8} className="px-4 py-3">
                      {loadingLeadId === lead.id && (
                        <p className="text-sm text-zinc-500">Loading sent emails…</p>
                      )}
                      {loadingLeadId !== lead.id && (outreachByLead[lead.id]?.length ?? 0) === 0 && (
                        <p className="text-sm text-zinc-500">No emails sent to this lead yet.</p>
                      )}
                      {loadingLeadId !== lead.id && (outreachByLead[lead.id]?.length ?? 0) > 0 && (
                        <div className="space-y-2">
                          {outreachByLead[lead.id].map((entry) => (
                            <div
                              key={entry.id}
                              className="rounded-md border border-black/[.08] dark:border-white/[.145]"
                            >
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedEntryId(expandedEntryId === entry.id ? null : entry.id);
                                }}
                                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-black/[.02] dark:hover:bg-white/[.04]"
                              >
                                <span className="truncate">
                                  <span className="text-zinc-500">{entry.touch_number === 0 ? "Automated reply" : `Touch ${entry.touch_number}`} — </span>
                                  {entry.subject || "(no subject recorded)"}
                                </span>
                                <span className="ml-3 shrink-0 text-xs text-zinc-500">
                                  {new Date(entry.sent_at).toLocaleString()}
                                </span>
                              </button>
                              {expandedEntryId === entry.id && (
                                <div className="border-t border-black/[.08] px-3 py-3 text-sm whitespace-pre-wrap dark:border-white/[.145]">
                                  {entry.body || "(email body wasn't recorded for this send)"}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">
                  No leads in this view yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-black/[.08] bg-background p-6 shadow-xl dark:border-white/[.145]">
            <h2 className="text-lg font-semibold">Email to {draft.leadName}</h2>

            {draft.loading && <p className="mt-4 text-sm text-zinc-500">Drafting with AI…</p>}

            {!draft.loading && (
              <div className="mt-4 space-y-3">
                {draft.error && (
                  <p className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
                    {draft.error}
                  </p>
                )}
                <input
                  value={draft.subject}
                  onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                  placeholder="Subject"
                  className="w-full rounded-md border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-transparent"
                />
                <textarea
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  rows={10}
                  placeholder="Email body"
                  className="w-full rounded-md border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-transparent"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => setDraft(null)}
                    className="flex-1 rounded-md border border-black/[.08] px-4 py-2 text-sm font-medium hover:bg-black/[.03] dark:border-white/[.145] dark:hover:bg-white/[.06]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => sendDraft()}
                    disabled={draft.sending || !draft.subject || !draft.body}
                    className="flex-1 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
                  >
                    {draft.sending ? "Sending…" : "Send"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
