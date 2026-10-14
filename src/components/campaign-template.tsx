"use client";

import { useEffect, useState } from "react";

const PLACEHOLDERS = ["first_name", "company", "industry", "job_title", "sender_company", "website"];

interface Props {
  campaignId: string;
}

type TemplateData = {
  subject: string;
  body: string;
  clientDefault: { subject: string; body: string };
};

export default function CampaignTemplate({ campaignId }: Props) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [defaults, setDefaults] = useState<TemplateData["clientDefault"] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/template`);
        const data = (await res.json()) as TemplateData & { ok?: boolean };
        if (cancelled || !data.ok) return;
        setSubject(data.subject ?? "");
        setBody(data.body ?? "");
        setDefaults(data.clientDefault);
      } catch {
        if (!cancelled) setError("Could not load template.");
      }
    })();
    return () => { cancelled = true; };
  }, [campaignId, open]);

  async function save() {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/template`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Save failed");
      setStatus(subject || body ? "Template saved." : "Cleared — using account default.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const isOverride = !!(subject || body);
  const hasAccountDefault = !!(defaults?.subject || defaults?.body);

  return (
    <div className="rounded-md border border-black/[.08] dark:border-white/[.145]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <span className="text-sm font-medium">Email template</span>
          <span className="ml-2 text-xs text-zinc-500">
            {isOverride ? (
              <span className="text-blue-600 dark:text-blue-400">Custom for this campaign</span>
            ) : hasAccountDefault ? (
              <span>Using account template</span>
            ) : (
              <span>AI-written (AIDA)</span>
            )}
          </span>
        </div>
        <span className="text-zinc-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="border-t border-black/[.06] dark:border-white/[.08] px-4 pb-4 pt-3 space-y-3">
          <p className="text-xs text-zinc-500">
            Override the email template for this campaign only. Use {PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}.
            Leave empty to use your {hasAccountDefault ? "account template" : "AI-written (AIDA) template"}.
          </p>
          <label className="block space-y-1 text-sm">
            <span className="text-xs text-zinc-500">Subject</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={80}
              placeholder={defaults?.subject || "e.g. Quick question about {company}"}
              className="w-full rounded-md border border-black/[.08] bg-transparent px-2 py-1.5 dark:border-white/[.145]"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-xs text-zinc-500">Body</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              maxLength={2000}
              placeholder={defaults?.body || "Hey {first_name},\n\n..."}
              className="w-full rounded-md border border-black/[.08] bg-transparent px-2 py-1.5 dark:border-white/[.145]"
            />
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {status && <p className="text-sm text-green-700 dark:text-green-400">{status}</p>}
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
            >
              {saving ? "Checking…" : "Save template"}
            </button>
            {isOverride && (
              <button
                onClick={() => { setSubject(""); setBody(""); save(); }}
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
