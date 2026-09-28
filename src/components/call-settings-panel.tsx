"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Daily-report call settings.
 *
 * Two numbers, two directions, and it is easy to confuse them — so the copy
 * says it plainly: the number you BUY is what the world calls; THIS number is
 * your own mobile that the agent rings with the daily report.
 */
export default function CallSettingsPanel({
  initial,
  available,
  hint,
  numberActive = false,
  pinSet = false,
}: {
  initial: {
    personal_phone_number: string | null;
    daily_call_enabled: boolean | null;
    daily_call_time: string | null;
    daily_call_timezone: string | null;
    daily_call_last_at: string | null;
  } | null;
  available: boolean;
  hint?: string;
  numberActive?: boolean;
  pinSet?: boolean;
}) {
  const router = useRouter();
  const [phone, setPhone] = useState(initial?.personal_phone_number ?? "");
  // First time here (no mobile saved yet): default the daily call to ON, so buying
  // the number and typing your mobile is all the setup there is.
  const [enabled, setEnabled] = useState(initial?.personal_phone_number ? Boolean(initial?.daily_call_enabled) : true);
  const [testing, setTesting] = useState(false);
  const [pin, setPin] = useState("");
  const [pinIsSet, setPinIsSet] = useState(pinSet);
  // "18:00:00" -> "18:00" for the time input.
  const [time, setTime] = useState((initial?.daily_call_time ?? "18:00:00").slice(0, 5));
  const [tz, setTz] = useState(initial?.daily_call_timezone ?? "Asia/Karachi");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    if (enabled && !phone.trim()) {
      setMsg({ ok: false, text: "Type your mobile number first — without it there is nobody to call." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/voice/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personal_phone_number: phone.trim(),
          daily_call_enabled: enabled,
          daily_call_time: time,
          daily_call_timezone: tz,
          ...(pin ? { voice_pin: pin } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save");
      if (pin) { setPinIsSet(true); setPin(""); }
      setMsg({ ok: true, text: "Saved." });
      router.refresh();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function testCall() {
    setTesting(true);
    setMsg(null);
    try {
      const res = await fetch("/api/voice/settings/test", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not place the call");
      setMsg({ ok: true, text: data.message });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }

  const saved = Boolean(initial?.personal_phone_number);
  const steps: [string, boolean][] = [
    ["Business number bought", numberActive],
    ["Your mobile saved", saved],
    ["Daily call switched on", saved && Boolean(initial?.daily_call_enabled)],
  ];

  async function removePin() {
    const res = await fetch("/api/voice/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice_pin: null }) });
    if (res.ok) { setPinIsSet(false); setMsg({ ok: true, text: "PIN removed." }); }
  }

  if (!available) {
    return (
      <div className="panel panel-body space-y-2">
        <h2 className="text-lg font-semibold">Daily report call</h2>
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {hint ?? "Daily-call settings are not available yet."}
        </p>
      </div>
    );
  }

  return (
    <div className="panel panel-body space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Daily report call</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Your agent rings <strong>this</strong> number once a day and reads you the numbers — leads, emails, replies,
          deals, social posts and ad budget. This is your own mobile, not the number you bought.
        </p>
      </div>

      <ol className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {steps.map(([label, done]) => (
          <li key={label} className={done ? "text-green-700 dark:text-green-400" : "text-zinc-500"}>
            {done ? "✓" : "○"} {label}
          </li>
        ))}
      </ol>
      <p className="text-xs text-zinc-500">
        Next step: type your own mobile below and press Save. The agent then calls you every day at the time you pick,
        and you can also call your business number from that mobile any time — it answers in your language.
      </p>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Your phone number</span>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+923394816706"
          className="w-full rounded-md border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.145]"
        />
        <span className="text-xs text-zinc-500">International format. Leave blank to stop the calls.</span>
      </label>

      <div className="flex flex-wrap items-end gap-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Call at</span>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="rounded-md border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.145]"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Timezone</span>
          <input
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            list="tz-options"
            className="rounded-md border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.145]"
          />
          <datalist id="tz-options">
            <option value="Asia/Karachi" />
            <option value="Asia/Dubai" />
            <option value="Europe/London" />
            <option value="Europe/Dublin" />
            <option value="America/New_York" />
            <option value="America/Los_Angeles" />
            <option value="Asia/Kolkata" />
          </datalist>
        </label>
        <label className="flex items-center gap-2 pb-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="text-sm">Call me daily</span>
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Call-in PIN (optional)</span>
        <input
          type="password"
          inputMode="numeric"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          placeholder={pinIsSet ? "PIN is set — type a new one to change it" : "4–6 digits"}
          className="w-full rounded-md border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.145]"
        />
        <span className="text-xs text-zinc-500">
          When set, anyone calling your business number must say this PIN before the agent shares anything (the daily call to you needs no PIN).
          {pinIsSet && (
            <button type="button" onClick={removePin} className="ml-2 underline">Remove PIN</button>
          )}
        </span>
      </label>

      {initial?.daily_call_last_at && (
        <p className="text-xs text-zinc-500">
          Last call placed: {new Date(initial.daily_call_last_at).toLocaleString()}
        </p>
      )}
      {msg && (
        <p className={`rounded-md p-3 text-sm ${msg.ok
          ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300"
          : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300"}`}>
          {msg.text}
        </p>
      )}

      <button
        onClick={save}
        disabled={busy}
        className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {busy ? "Saving…" : "Save"}
      </button>
      {saved && numberActive && (
        <button
          onClick={testCall}
          disabled={testing || busy}
          className="ml-3 rounded-md border border-black/[.1] px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/[.145]"
        >
          {testing ? "Calling…" : "Call me now (test)"}
        </button>
      )}
    </div>
  );
}
