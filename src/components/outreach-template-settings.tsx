"use client";

import { useEffect, useState } from "react";

const PLACEHOLDERS = ["first_name", "company", "industry", "job_title", "sender_company", "website"];

const SOURCE_LABEL: Record<string, string> = {
  custom: "Your custom template",
  aida: "AI-written (AIDA)",
  fixed: "Standard template",
};

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
  const [preview, setPreview] = useState<{ subject: string; body: string; source: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

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

  async function loadPreview() {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch("/api/campaigns/template/preview");
      const data = (await res.json()) as { ok?: boolean; subject?: string; body?: string; source?: string; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Preview failed");
      setPreview({ subject: data.subject ?? "", body: data.body ?? "", source: data.source ?? "fixed" });
    } catch (err) {
      setPreviewError((err as Error).message);
    } finally {
      setPreviewing(false);
    }
  }

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
      <div className="flex gap-2">
        <button onClick={save} disabled={saving || previewing} className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]">
          {saving ? "Checking…" : "Save template"}
        </button>
        <button onClick={loadPreview} disabled={previewing || saving} className="rounded-md border border-black/[.1] px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-zinc-800">
          {previewing ? "Generating…" : "Preview email"}
        </button>
      </div>
      {previewError && <p className="text-sm text-red-600">{previewError}</p>}

      {preview && (
        <div className="rounded-md border border-black/[.08] dark:border-white/[.145] bg-zinc-50 dark:bg-zinc-900 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
              {SOURCE_LABEL[preview.source] ?? preview.source}
            </span>
            <button onClick={() => setPreview(null)} className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">✕ Close</button>
          </div>
          <div className="text-xs text-zinc-500">Subject</div>
          <div className="text-sm font-medium">{preview.subject}</div>
          <div className="text-xs text-zinc-500 mt-2">Body</div>
          <pre className="whitespace-pre-wrap text-sm font-sans leading-relaxed">{preview.body}</pre>
          <p className="text-xs text-zinc-400 mt-2">Sample values: Sam · Acme Dental · dental care · Owner</p>
        </div>
      )}
    </div>
  );
}
