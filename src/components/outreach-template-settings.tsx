"use client";

import { useEffect, useState } from "react";

const PLACEHOLDERS = ["first_name", "company", "industry", "job_title", "sender_company", "website"];

/**
 * The client's own cold-email template. Only these placeholders work, and a template must pass the same deliverability
 * check as the fixed template. Clearing both fields returns to the fixed template.
 */
export default function OutreachTemplateSettings() {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/campaigns/template");
        const data = (await res.json()) as { ok?: boolean; subject?: string; body?: string };
        if (cancelled || !data.ok) return;
        setSubject(data.subject ?? "");
        setBody(data.body ?? "");
      } catch {
        if (!cancelled) setError("Could not load your template.");
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
      const res = await fetch("/api/campaigns/template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Save failed");
      setStatus(subject || body ? "Template saved and passed the deliverability check." : "Cleared. The fixed template will be used.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-black/[.08] p-4 dark:border-white/[.145]">
      <div>
        <h3 className="text-sm font-semibold">Your email template</h3>
        <p className="text-xs text-zinc-500">
          Optional. Use {PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}. No links, and it must pass the same deliverability check.
          Leave both empty to use the standard template.
        </p>
      </div>
      <label className="block space-y-1 text-sm">
        <span className="text-xs text-zinc-500">Subject</span>
        <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={80} className="w-full rounded-md border border-black/[.08] bg-transparent px-2 py-1.5 dark:border-white/[.145]" />
      </label>
      <label className="block space-y-1 text-sm">
        <span className="text-xs text-zinc-500">Body</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} maxLength={2000} className="w-full rounded-md border border-black/[.08] bg-transparent px-2 py-1.5 dark:border-white/[.145]" />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {status && <p className="text-sm text-green-700 dark:text-green-400">{status}</p>}
      <button onClick={save} disabled={saving} className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]">
        {saving ? "Checking…" : "Save template"}
      </button>
    </div>
  );
}
