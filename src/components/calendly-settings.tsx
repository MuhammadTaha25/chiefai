"use client";

import { useState } from "react";

export default function CalendlySettings({
  initialUrl,
  connected,
  businessName,
}: {
  initialUrl: string;
  connected: boolean;
  /** Shown instead of the raw calendly.com/<slug> link, which is set by whoever owns that Calendly account — not something this app can rename. */
  businessName?: string | null;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/calendly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calendly_url: url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-3 space-y-3">
      <div className="flex items-center gap-2">
        <a
          href="/api/calendly/connect?next=/settings"
          className="rounded-md border border-black/[.1] px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-white/[.145] dark:hover:bg-zinc-900"
        >
          {connected ? "Reconnect Calendly" : "Connect Calendly"}
        </a>
        {connected && (
          <span className="rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-700 dark:bg-green-900/40 dark:text-green-300">
            Connected
          </span>
        )}
      </div>

      {connected && (
        <p className="text-sm text-zinc-500">
          Booking link: <span className="font-medium text-foreground">{businessName ? `Book with ${businessName}` : "Your Calendly scheduling page"}</span>
          {" — "}the exact calendly.com address is set in your own Calendly account, not here.
        </p>
      )}

      <details className="text-sm text-zinc-500">
        <summary className="cursor-pointer select-none">Or paste your scheduling link manually</summary>
        <form onSubmit={save} className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="url"
            placeholder="https://calendly.com/your-agency/intro"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setSaved(false);
            }}
            className="flex-1 min-w-[240px] rounded-md border border-black/[.1] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-transparent"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {loading ? "Saving…" : "Save"}
          </button>
          {saved && <span className="text-xs text-green-600">Saved</span>}
          {error && <p className="w-full text-xs text-red-600">{error}</p>}
        </form>
      </details>
    </div>
  );
}
