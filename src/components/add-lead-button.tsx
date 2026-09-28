"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AddLeadButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", company: "", job_title: "" });

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add lead");
      setOpen(false);
      setForm({ name: "", email: "", company: "", job_title: "" });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] dark:hover:bg-[#ccc]"
      >
        Add lead
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-black/[.08] bg-background p-6 shadow-xl dark:border-white/[.145]">
            <h2 className="text-lg font-semibold">Add a lead</h2>
            <p className="mt-1 text-sm text-zinc-500">
              For adding real leads by hand while automatic prospecting is being set up.
            </p>

            {error && (
              <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
                {error}
              </p>
            )}

            <div className="mt-4 space-y-3">
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Name"
                className="w-full rounded-md border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-transparent"
              />
              <input
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="Email *"
                type="email"
                className="w-full rounded-md border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-transparent"
              />
              <input
                value={form.company}
                onChange={(e) => setForm({ ...form, company: e.target.value })}
                placeholder="Company"
                className="w-full rounded-md border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-transparent"
              />
              <input
                value={form.job_title}
                onChange={(e) => setForm({ ...form, job_title: e.target.value })}
                placeholder="Job title"
                className="w-full rounded-md border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145] dark:bg-transparent"
              />
            </div>

            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setOpen(false)}
                className="flex-1 rounded-md border border-black/[.08] px-4 py-2 text-sm font-medium hover:bg-black/[.03] dark:border-white/[.145] dark:hover:bg-white/[.06]"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving || !form.email}
                className="flex-1 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
              >
                {saving ? "Saving…" : "Add lead"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
