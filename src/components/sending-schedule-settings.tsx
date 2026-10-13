"use client";

import { useState, useEffect } from "react";

// Common IANA timezones — enough for global users without an enormous list.
const COMMON_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Vancouver",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Warsaw",
  "Europe/Istanbul",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
  "Africa/Cairo",
  "Africa/Lagos",
  "Africa/Nairobi",
];

const TIME_OPTIONS: { label: string; value: string }[] = [];
for (let h = 0; h < 24; h++) {
  for (const m of [0, 30]) {
    const hh = String(h).padStart(2, "0");
    const mm = String(m).padStart(2, "0");
    const label = `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${mm} ${h < 12 ? "AM" : "PM"}`;
    TIME_OPTIONS.push({ value: `${hh}:${mm}`, label });
  }
}

export default function SendingScheduleSettings() {
  const [timezone, setTimezone] = useState("");
  const [sendStart, setSendStart] = useState("08:00");
  const [sendEnd, setSendEnd] = useState("20:00");
  const [followUpDays, setFollowUpDays] = useState(3);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings/sending-schedule")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setTimezone(d.timezone ?? "");
          setSendStart((d.sendStart ?? "08:00").slice(0, 5));
          setSendEnd((d.sendEnd ?? "20:00").slice(0, 5));
          setFollowUpDays(Number(d.followUpDays) || 3);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/sending-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone, sendStart, sendEnd, followUpDays }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  return (
    <form onSubmit={save} className="mt-3 space-y-5 max-w-md">
      {/* Timezone */}
      <div>
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Your timezone
        </label>
        <p className="mt-0.5 text-xs text-zinc-500">
          Emails are sent during your local business hours, not the server&apos;s.
        </p>
        <select
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className="mt-1.5 w-full rounded-md border border-black/[.1] bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-white/[.15] dark:bg-zinc-900 dark:text-zinc-100"
        >
          <option value="">— Select timezone —</option>
          {COMMON_TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>

      {/* Send window */}
      <div>
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Sending window
        </label>
        <p className="mt-0.5 text-xs text-zinc-500">
          Emails only go out inside this window (in your timezone). Default is 8 AM – 8 PM.
        </p>
        <div className="mt-1.5 flex items-center gap-2">
          <select
            value={sendStart}
            onChange={(e) => setSendStart(e.target.value)}
            className="flex-1 rounded-md border border-black/[.1] bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-white/[.15] dark:bg-zinc-900 dark:text-zinc-100"
          >
            {TIME_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <span className="text-sm text-zinc-500">to</span>
          <select
            value={sendEnd}
            onChange={(e) => setSendEnd(e.target.value)}
            className="flex-1 rounded-md border border-black/[.1] bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-white/[.15] dark:bg-zinc-900 dark:text-zinc-100"
          >
            {TIME_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Follow-up delay */}
      <div>
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Follow-up delay: <span className="font-semibold text-zinc-900 dark:text-zinc-100">{followUpDays} {followUpDays === 1 ? "day" : "days"}</span>
        </label>
        <p className="mt-0.5 text-xs text-zinc-500">
          How many days to wait before sending a follow-up to a lead that hasn&apos;t replied. Default is 3 days.
        </p>
        <input
          type="range"
          min={1}
          max={14}
          step={1}
          value={followUpDays}
          onChange={(e) => setFollowUpDays(Number(e.target.value))}
          className="mt-2 w-full accent-blue-600"
        />
        <div className="flex justify-between text-xs text-zinc-400 mt-0.5">
          <span>1 day</span>
          <span>7 days</span>
          <span>14 days</span>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {saving ? "Saving…" : "Save schedule"}
        </button>
        {saved && (
          <span className="text-sm text-green-600 dark:text-green-400">✓ Saved</span>
        )}
      </div>
    </form>
  );
}
