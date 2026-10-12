"use client";

import { useEffect, useState } from "react";

type Saved = { start: string | null; end: string | null; timezone: string | null };

/**
 * The client's own outreach window: when each day's campaign emails may go out, and in which timezone.
 * Empty values mean the default 08:00-24:00 in the client's own timezone. Saved through /api/campaigns/send-window.
 */
export default function SendWindowSettings() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [timezone, setTimezone] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/campaigns/send-window");
        const data = (await res.json()) as Saved & { ok?: boolean };
        if (cancelled || !data.ok) return;
        setStart(data.start ?? "");
        setEnd(data.end ?? "");
        setTimezone(data.timezone ?? "");
      } catch {
        if (!cancelled) setError("Could not load your send window.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/campaigns/send-window", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start, end, timezone }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Save failed");
      setStatus(start && end ? `Saved: ${start} to ${end} (${timezone})` : `Saved: default window 08:00 to 24:00 (${timezone})`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-black/[.08] p-4 dark:border-white/[.145]">
      <div>
        <h3 className="text-sm font-semibold">Sending window</h3>
        <p className="text-xs text-zinc-500">
          Campaign emails go out only between these times each day, in YOUR timezone, one mailbox block at a time. Default is 08:00 to 24:00. An end time earlier than the start runs past midnight. Sending does not start until your timezone is set.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="text-xs text-zinc-500">Start</span>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="w-full rounded-md border border-black/[.08] bg-transparent px-2 py-1.5 dark:border-white/[.145]" />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs text-zinc-500">End</span>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full rounded-md border border-black/[.08] bg-transparent px-2 py-1.5 dark:border-white/[.145]" />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-xs text-zinc-500">Your timezone (e.g. Asia/Dubai)</span>
          <input type="text" value={timezone} placeholder="Asia/Dubai" onChange={(e) => setTimezone(e.target.value)} className="w-full rounded-md border border-black/[.08] bg-transparent px-2 py-1.5 dark:border-white/[.145]" />
        </label>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {status && <p className="text-sm text-green-700 dark:text-green-400">{status}</p>}
      <button onClick={save} disabled={saving} className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]">
        {saving ? "Saving…" : "Save window"}
      </button>
    </div>
  );
}
