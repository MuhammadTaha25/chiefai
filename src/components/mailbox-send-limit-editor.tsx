"use client";

import { useState } from "react";

interface Mailbox {
  id: string;
  address: string;
  warmup_day: number | null;
  daily_send_limit: number | null;
  created_at?: string | null;
}

/** Mirror of warmup-schedule.ts — kept inline so no server import is needed in this client component. */
function coldLimitForAge(ageDays: number): number {
  return Math.min(30, Math.floor(4 + 46 * (1 - Math.exp(-ageDays / 18))));
}

function warmupInfo(m: Mailbox): { ageDays: number; warmupAllows: number } {
  if (!m.created_at) return { ageDays: 0, warmupAllows: coldLimitForAge(0) };
  const ageDays = Math.max(
    0,
    Math.floor((Date.now() - new Date(m.created_at).getTime()) / 86400000)
  );
  return { ageDays, warmupAllows: coldLimitForAge(ageDays) };
}

function WarmupLine({ mailbox, cap }: { mailbox: Mailbox; cap: number }) {
  const { ageDays, warmupAllows } = warmupInfo(mailbox);
  const fullyWarmed = warmupAllows >= 30;

  if (cap <= 0) {
    // No limit set — just show where warmup is at
    return (
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Warmup: Day {ageDays} — curve allows{" "}
        <span className="font-medium">{warmupAllows}/day</span>
        {fullyWarmed ? " (fully warmed ✓)" : " — set a limit to start sending"}
      </p>
    );
  }

  // Warmup curve is the bottleneck while ageDays < ~21; once warmed, cap governs
  const effectiveSends = Math.min(cap, warmupAllows);
  const warming = warmupAllows < cap;

  return (
    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
      Warmup: Day {ageDays} — curve allows{" "}
      <span className="font-medium">{warmupAllows}/day</span>
      {warming ? (
        <>
          {" "}— today will send{" "}
          <span className="font-medium">{effectiveSends}</span> (cap of {cap} reached ~Day 21)
        </>
      ) : (
        <>
          {" "}— fully warmed ✓, sending up to{" "}
          <span className="font-medium">{cap}/day</span>
        </>
      )}
    </p>
  );
}

export default function MailboxSendLimitEditor({ mailboxes }: { mailboxes: Mailbox[] }) {
  const [limits, setLimits] = useState<Record<string, number>>(() =>
    Object.fromEntries(mailboxes.map((m) => [m.id, m.daily_send_limit ?? 0]))
  );
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save(id: string) {
    const limit = limits[id];
    if (!limit || limit < 1) {
      setErrors((e) => ({ ...e, [id]: "Enter a limit between 1 and 200" }));
      return;
    }
    setSaving(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const res = await fetch(`/api/mailboxes/${id}/send-limit`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daily_send_limit: limit }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setSaved(id);
      setTimeout(() => setSaved((s) => (s === id ? null : s)), 2000);
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: (err as Error).message }));
    } finally {
      setSaving(null);
    }
  }

  if (mailboxes.length === 0) {
    return <p className="text-sm text-zinc-500">No mailboxes provisioned yet.</p>;
  }

  return (
    <div className="space-y-2">
      {mailboxes.map((m) => (
        <div
          key={m.id}
          className="rounded-md border border-black/[.08] px-4 py-3 text-sm dark:border-white/[.145]"
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 min-w-0 truncate font-medium">{m.address}</span>
            <span className="text-xs text-zinc-400">Day {warmupInfo(m).ageDays}</span>
            <div className="flex items-center gap-2">
              <label htmlFor={`limit-${m.id}`} className="text-xs text-zinc-500 shrink-0">
                Daily limit
              </label>
              <input
                id={`limit-${m.id}`}
                type="number"
                min={1}
                max={200}
                value={limits[m.id] ?? ""}
                onChange={(e) =>
                  setLimits((l) => ({ ...l, [m.id]: Number(e.target.value) }))
                }
                onKeyDown={(e) => e.key === "Enter" && save(m.id)}
                className="w-16 rounded border border-black/[.12] bg-transparent px-2 py-1 text-center text-sm dark:border-white/[.2] focus:outline-none focus:ring-1 focus:ring-black/20 dark:focus:ring-white/20"
              />
              <button
                onClick={() => save(m.id)}
                disabled={saving === m.id}
                className="rounded border border-black/[.12] px-2 py-1 text-xs hover:bg-zinc-50 dark:border-white/[.2] dark:hover:bg-zinc-900 disabled:opacity-50"
              >
                {saving === m.id ? "Saving…" : saved === m.id ? "✓ Saved" : "Save"}
              </button>
            </div>
          </div>
          {/* Warmup info line — shows what will actually send today */}
          <WarmupLine mailbox={m} cap={limits[m.id] ?? 0} />
          {errors[m.id] && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors[m.id]}</p>
          )}
          {(limits[m.id] ?? 0) === 0 && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              ⚠ Set a daily limit so this mailbox can send email
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
