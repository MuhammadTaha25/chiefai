"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import MailboxSentEmailsModal from "@/components/mailbox-sent-emails-modal";
import { crowdedDomains } from "@/lib/mailbox-crowding";

interface MailboxRow {
  id: string;
  address: string;
  /** The limit sending really uses today: the lower of the saved limit and the age-based warm-up ceiling. */
  daily_send_limit: number;
  /** The limit saved on the mailbox. */
  configured_limit: number;
  /** What the age-based warm-up ramp allows today. */
  warmup_allows: number;
  limited_by: "configured" | "warm-up" | "none";
  /** Real warm-up stage, counted from the mailbox's age. */
  warmup_day: number;
  warmed_up: boolean;
  days_until_warmed: number;
  /** Follow-ups overdue by more than an hour that are pinned to this mailbox. */
  waiting_followups: number;
  /** Of those, overdue by more than 3 days. */
  stuck_followups: number;
  sent_today: number;
  sent_this_month: number;
  readiness: "ready" | "verifying" | "not_provisioned" | "sandbox";
}

const READINESS_LABEL: Record<MailboxRow["readiness"], { text: string; cls: string; title: string }> = {
  ready: { text: "Ready", cls: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300", title: "Mailgun domain verified — can send and receive" },
  verifying: { text: "Verifying DNS", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300", title: "Mailgun domain exists but is not verified yet — sending is blocked until it is" },
  not_provisioned: { text: "Not set up", cls: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300", title: "No Mailgun domain exists for this mailbox — sending is blocked" },
  sandbox: { text: "Sandbox only", cls: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300", title: "This Mailgun domain is a sandbox — it can only deliver to pre-approved test addresses. Add a real domain in Mailgun." },
};

export default function DomainMailboxList({ mailboxes }: { mailboxes: MailboxRow[] }) {
  const router = useRouter();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewingMailbox, setViewingMailbox] = useState<MailboxRow | null>(null);

  if (mailboxes.length === 0) return null;

  async function handleDelete(id: string, address: string) {
    if (!confirm(`Delete ${address}? This only removes it from ChiefAI — any Mailgun route stays.`)) return;

    setDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/domains/mailboxes/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not delete mailbox");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  // Many mailboxes on one domain share one domain reputation, so more of them does not mean more safe volume.
  const crowded = crowdedDomains(mailboxes.map((m) => m.address));

  return (
    <div>
      <h2 className="text-lg font-semibold">Mailboxes</h2>
      {crowded.length > 0 && (
        <p className="mt-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {crowded.map(([d, n]) => `${d} has ${n} mailboxes`).join("; ")}. About 3 per domain is the usual safe maximum: all mailboxes on a domain share one reputation, so extra ones add risk, not capacity.
        </p>
      )}
      {error && (
        <p className="mt-2 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">{error}</p>
      )}
      <div className="mt-3 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.145]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/[.08] text-left text-xs text-zinc-500 dark:border-white/[.145]">
              <th className="px-4 py-3 font-medium">Address</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Sent today</th>
              <th className="px-4 py-3 font-medium">Sent this month</th>
              <th className="px-4 py-3 font-medium">Daily limit</th>
              <th className="px-4 py-3 font-medium">Warm-up</th>
              <th className="px-4 py-3 font-medium">Follow-ups waiting</th>
              <th className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody>
            {mailboxes.map((m) => (
              <tr key={m.id} className="border-b border-black/[.06] last:border-0 dark:border-white/[.08]">
                <td className="px-4 py-3 font-medium">{m.address}</td>
                <td className="px-4 py-3">
                  <span
                    title={READINESS_LABEL[m.readiness].title}
                    className={`rounded-full px-2 py-1 text-xs ${READINESS_LABEL[m.readiness].cls}`}
                  >
                    {READINESS_LABEL[m.readiness].text}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {m.sent_today} / {m.daily_send_limit}
                </td>
                <td className="px-4 py-3">{m.sent_this_month}</td>
                <td className="px-4 py-3">
                  <div className="font-medium">{m.daily_send_limit} a day</div>
                  <div className="text-xs text-zinc-500">
                    {m.limited_by === "configured"
                      ? `Held by the limit saved on this mailbox (${m.configured_limit}); warm-up would allow ${m.warmup_allows}`
                      : m.limited_by === "warm-up"
                        ? `Held by warm-up; the saved limit is ${m.configured_limit}`
                        : m.configured_limit > 0 && m.configured_limit < m.daily_send_limit
                          ? `Fully warmed up: sends up to ${m.daily_send_limit}/day. The saved limit (${m.configured_limit}) only applies while warming up`
                          : "Fully warmed up"}
                  </div>
                </td>
                <td className="px-4 py-3 text-zinc-500">
                  {m.warmed_up ? "Fully warmed up" : `Day ${m.warmup_day} · full volume in ~${m.days_until_warmed} days`}
                </td>
                <td className="px-4 py-3">
                  {m.waiting_followups === 0 ? (
                    <span className="text-zinc-400">None</span>
                  ) : (
                    <span
                      title="Follow-ups always go out from the mailbox that sent the first email, so they wait for it instead of switching"
                      className={m.stuck_followups > 0 ? "text-red-600" : "text-amber-700 dark:text-amber-400"}
                    >
                      {m.waiting_followups} waiting
                      {m.stuck_followups > 0 ? ` · ${m.stuck_followups} stuck for 3+ days` : ""}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => setViewingMailbox(m)}
                    className="mr-2 rounded-md border border-black/[.08] px-3 py-1.5 text-xs font-medium hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-white/[.06]"
                  >
                    View sent emails
                  </button>
                  <button
                    onClick={() => handleDelete(m.id, m.address)}
                    disabled={deletingId === m.id}
                    className="rounded-md border border-black/[.08] px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-red-950"
                  >
                    {deletingId === m.id ? "Deleting…" : "Delete"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {viewingMailbox && (
        <MailboxSentEmailsModal
          mailboxId={viewingMailbox.id}
          address={viewingMailbox.address}
          onClose={() => setViewingMailbox(null)}
        />
      )}
    </div>
  );
}
