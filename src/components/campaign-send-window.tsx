"use client";

import { useEffect, useState } from "react";

interface Props {
  campaignId: string;
}

type WindowData = {
  start: string | null;
  end: string | null;
  timezone: string | null;
  clientDefault: { start: string; end: string; timezone: string | null };
};

export default function CampaignSendWindow({ campaignId }: Props) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [timezone, setTimezone] = useState("");
  const [defaults, setDefaults] = useState<WindowData["clientDefault"] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/send-window`);
        const data = (await res.json()) as WindowData & { ok?: boolean };
        if (cancelled || !data.ok) return;
        setStart(data.start ?? "");
        setEnd(data.end ?? "");
        setTimezone(data.timezone ?? "");
        setDefaults(data.clientDefault);
      } catch {
        if (!cancelled) setError("Could not load send window.");
      }
    })();
    return () => { cancelled = true; };
  }, [campaignId, open]);

  async function save() {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/send-window`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start, end, timezone }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Save failed");
      const tz = timezone || defaults?.timezone || "—";
      setStatus(start && end ? `Saved: ${start}–${end} (${tz})` : `Using default: ${defaults?.start ?? "08:00"}–${defaults?.end ?? "24:00"} (${tz})`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const effectiveStart = start || defaults?.start || "08:00";
  const effectiveEnd = end || defaults?.end || "24:00";
  const effectiveTz = timezone || defaults?.timezone || "not set";
  const isOverride = !!(start || end || timezone);

  return (
    <div className="rounded-md border border-black/[.08] dark:border-white/[.145]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <span className="text-sm font-medium">Sending window</span>
          <span className="ml-2 text-xs text-zinc-500">
            {isOverride ? (
              <span className="text-blue-600 dark:text-blue-400">Custom: {effectiveStart}–{effectiveEnd} · {effectiveTz}</span>
            ) : (
              <span>Default: {effectiveStart}–{effectiveEnd} · {effectiveTz}</span>
            )}
          </span>
        </div>
        <span className="text-zinc-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="border-t border-black/[.06] dark:border-white/[.08] px-4 pb-4 pt-3 space-y-3">
          <p className="text-xs text-zinc-500">
            Override the sending window just for this campaign. Leave empty to use your account default
            ({defaults?.start ?? "08:00"}–{defaults?.end ?? "24:00"}{defaults?.timezone ? ` · ${defaults.timezone}` : ""}).
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm">
              <span className="text-xs text-zinc-500">Start</span>
              <input
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                placeholder={defaults?.start ?? "08:00"}
                className="w-full rounded-md border border-black/[.08] bg-transparent px-2 py-1.5 dark:border-white/[.145]"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs text-zinc-500">End</span>
              <input
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                placeholder={defaults?.end ?? "24:00"}
                className="w-full rounded-md border border-black/[.08] bg-transparent px-2 py-1.5 dark:border-white/[.145]"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-xs text-zinc-500">Timezone (e.g. America/New_York)</span>
              <input
                type="text"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder={defaults?.timezone ?? "Asia/Karachi"}
                className="w-full rounded-md border border-black/[.08] bg-transparent px-2 py-1.5 dark:border-white/[.145]"
              />
            </label>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {status && <p className="text-sm text-green-700 dark:text-green-400">{status}</p>}
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
            >
              {saving ? "Saving…" : "Save window"}
            </button>
            {isOverride && (
              <button
                onClick={() => { setStart(""); setEnd(""); setTimezone(""); save(); }}
                disabled={saving}
                className="rounded-md border border-black/[.1] px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-zinc-800"
              >
                Reset to default
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
