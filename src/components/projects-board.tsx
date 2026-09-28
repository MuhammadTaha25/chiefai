"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Project, ProjectStatus } from "@/types/db";

const COLUMNS: { status: ProjectStatus; label: string; next: ProjectStatus | null }[] = [
  { status: "not_started", label: "Not started", next: "in_development" },
  { status: "in_development", label: "In development", next: "qa" },
  { status: "qa", label: "QA", next: "client_review" },
  { status: "client_review", label: "Client review", next: "delivered" },
  { status: "delivered", label: "Delivered", next: "closed" },
  { status: "closed", label: "Closed", next: null },
];

export default function ProjectsBoard({ projects }: { projects: Project[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function advance(project: Project, next: ProjectStatus) {
    setBusyId(project.id);
    setError(null);
    try {
      const res = await fetch("/api/projects/advance-stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: project.id, new_status: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to advance");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const blocked = projects.filter((p) => p.is_blocked);

  return (
    <div>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {blocked.length > 0 && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {blocked.length} project{blocked.length > 1 ? "s" : ""} blocked:{" "}
          {blocked.map((p) => p.name).join(", ")}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 overflow-x-auto sm:grid-cols-3 lg:grid-cols-6">
        {COLUMNS.map((col) => {
          // The DB's initial state is "started" (projects_status_check has no "not_started").
          const items = projects.filter((p) => p.status === col.status || (col.status === "not_started" && p.status === "started"));
          return (
            <div key={col.status} className="min-w-[220px]">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {col.label} · {items.length}
              </h3>
              <div className="mt-2 space-y-2">
                {items.map((p) => (
                  <div key={p.id} className="rounded-lg border border-black/[.08] p-3 dark:border-white/[.145]">
                    <p className="text-sm font-medium">{p.name}</p>
                    {p.is_blocked && (
                      <p className="mt-1 text-xs text-red-600">Blocked: {p.block_reason}</p>
                    )}
                    {p.deadline && (
                      <p className="mt-1 text-xs text-zinc-500">
                        Due {new Date(p.deadline).toLocaleDateString()}
                      </p>
                    )}
                    {col.next && (
                      <button
                        onClick={() => advance(p, col.next!)}
                        disabled={busyId === p.id}
                        className="mt-2 w-full rounded-md bg-zinc-100 px-2 py-1.5 text-xs font-medium hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                      >
                        {busyId === p.id ? "Advancing…" : `Advance → ${col.next.replace(/_/g, " ")}`}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
