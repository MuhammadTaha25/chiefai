"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import MailboxSentEmailsModal from "@/components/mailbox-sent-emails-modal";

interface MailboxRow {
  id: string;
  address: string;
  daily_send_limit: number;
  warmup_day: number;
  sent_today: number;
  sent_this_month: number;
  readiness: "ready" | "verifying" | "not_provisioned";
}

const READINESS_LABEL: Record<MailboxRow["readiness"], { text: string; cls: string; title: string }> = {
  ready: { text: "Ready", cls: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300", title: "Mailgun domain verified — can send and receive" },
  verifying: { text: "Verifying DNS", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300", title: "Mailgun domain exists but is not verified yet — sending is blocked until it is" },
  not_provisioned: { text: "Not set up", cls: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300", title: "No Mailgun domain exists for this mailbox — sending is blocked" },
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

  return (
    <div>
      <h2 className="text-lg font-semibold">Mailboxes</h2>
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
              <th className="px-4 py-3 font-medium">Warmup day</th>
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
                <td className="px-4 py-3 text-zinc-500">Day {m.warmup_day}</td>
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
