"use client";

import { useEffect, useState } from "react";

type DeliveryStatus = "delivered" | "bounced" | "accepted" | "unknown";

interface SentEmail {
  id: string;
  subject: string | null;
  body: string | null;
  touch_number: number | null;
  sent_at: string;
  lead_id: string;
  leads: { email: string | null; company: string | null } | { email: string | null; company: string | null }[] | null;
  delivery_status: DeliveryStatus;
}

function leadInfo(email: SentEmail) {
  const lead = Array.isArray(email.leads) ? email.leads[0] : email.leads;
  return { email: lead?.email ?? "Unknown recipient", company: lead?.company ?? null };
}

function initialsFor(text: string) {
  return text.trim().slice(0, 1).toUpperCase() || "?";
}

const STATUS_LABEL: Record<DeliveryStatus, string> = {
  delivered: "Delivered",
  bounced: "Bounced",
  accepted: "Sending…",
  unknown: "Status unknown",
};

const STATUS_CLASS: Record<DeliveryStatus, string> = {
  delivered: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  bounced: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  accepted: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  unknown: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

function StatusBadge({ status }: { status: DeliveryStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASS[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export default function MailboxSentEmailsModal({
  mailboxId,
  address,
  onClose,
}: {
  mailboxId: string;
  address: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [emails, setEmails] = useState<SentEmail[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset before refetching for a new mailbox
    setLoading(true);
    setError(null);
    fetch(`/api/domains/mailboxes/${mailboxId}/sent-emails`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load sent emails");
        if (!cancelled) {
          setEmails(data.emails);
          if (data.emails.length > 0) setSelectedId(data.emails[0].id);
        }
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [mailboxId]);

  const selected = emails.find((e) => e.id === selectedId) ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[min(720px,90vh)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-black/[.08] bg-background shadow-2xl dark:border-white/[.145]"
      >
        <div className="flex items-center justify-between border-b border-black/[.08] px-5 py-4 dark:border-white/[.145]">
          <div>
            <h2 className="text-base font-semibold">Sent emails</h2>
            <p className="text-sm text-zinc-500">{address}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-zinc-500 hover:bg-black/[.05] hover:text-foreground dark:hover:bg-white/[.08]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Loading…</div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-red-600">{error}</div>
        ) : emails.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
            No emails sent from this mailbox yet.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="w-[280px] shrink-0 overflow-y-auto border-r border-black/[.08] dark:border-white/[.145]">
              {emails.map((email) => {
                const info = leadInfo(email);
                const isActive = email.id === selectedId;
                return (
                  <button
                    key={email.id}
                    onClick={() => setSelectedId(email.id)}
                    className={`flex w-full flex-col gap-0.5 border-b border-black/[.06] px-4 py-3 text-left transition-colors dark:border-white/[.06] ${
                      isActive
                        ? "bg-zinc-100 dark:bg-zinc-800"
                        : "hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[11px] font-semibold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
                        {initialsFor(info.company || info.email)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {info.company || info.email}
                      </span>
                      {email.delivery_status === "bounced" && (
                        <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" title="Bounced" />
                      )}
                    </span>
                    <span className="truncate pl-8 text-xs text-zinc-500">{email.subject || "(no subject)"}</span>
                    <span className="flex items-center gap-2 pl-8 text-[11px] text-zinc-400">
                      {new Date(email.sent_at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      <StatusBadge status={email.delivery_status} />
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex-1 overflow-y-auto">
              {selected && (
                <div className="p-6">
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold leading-snug">{selected.subject || "(no subject)"}</h3>
                    <StatusBadge status={selected.delivery_status} />
                  </div>
                  {selected.delivery_status === "bounced" && (
                    <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-300">
                      This email bounced — the recipient&apos;s address doesn&apos;t exist or can&apos;t receive mail.
                      Consider marking this lead&apos;s email as invalid.
                    </p>
                  )}
                  <div className="mt-3 flex items-center justify-between border-b border-black/[.08] pb-4 dark:border-white/[.145]">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-200 text-sm font-semibold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
                        {initialsFor(leadInfo(selected).company || leadInfo(selected).email)}
                      </span>
                      <div>
                        <p className="text-sm font-medium">
                          {leadInfo(selected).company || leadInfo(selected).email}
                        </p>
                        <p className="text-xs text-zinc-500">To: {leadInfo(selected).email}</p>
                      </div>
                    </div>
                    <div className="text-right text-xs text-zinc-500">
                      <p>{new Date(selected.sent_at).toLocaleString()}</p>
                      {selected.touch_number != null && <p>{selected.touch_number === 0 ? "Automated reply" : `Touch #${selected.touch_number}`}</p>}
                    </div>
                  </div>
                  <div className="mt-5 whitespace-pre-wrap text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                    {selected.body || "(no content recorded)"}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
