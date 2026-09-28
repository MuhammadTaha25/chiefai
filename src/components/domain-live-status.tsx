"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DomainPipeline, StageState } from "@/lib/domain-pipeline";

const POLL_FAST_MS = 5000; // registration / DNS in flight
const POLL_SLOW_MS = 20000; // only waiting on a mailbox's Mailgun domain, or idle
// While something is still in flight, also ask the server to re-check the registrar / Mailgun itself
// (the same idempotent path the scheduled cron runs), so status moves without anyone clicking anything.
const NUDGE_MS = 30000;

const dot: Record<StageState, string> = {
  done: "bg-green-500",
  active: "bg-amber-500 animate-pulse",
  pending: "bg-zinc-300 dark:bg-zinc-600",
  failed: "bg-red-500",
};

/** Live payment -> registration -> DNS -> mailbox tracker. Shows recorded state only; nothing is inferred client-side. */
export default function DomainLiveStatus() {
  const router = useRouter();
  const [pipelines, setPipelines] = useState<DomainPipeline[] | null>(null);
  const [error, setError] = useState(false);
  const lastSignature = useRef<string | null>(null);
  const lastNudge = useRef(0);
  const nudging = useRef(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      let nextDelay = POLL_SLOW_MS;
      try {
        const res = await fetch("/api/domains/status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { pipelines: DomainPipeline[]; inProgress: boolean };
        if (stopped) return;
        setError(false);
        setPipelines(data.pipelines);

        const signature = JSON.stringify(data.pipelines.map((p) => p.stages.map((s) => s.state)));
        if (lastSignature.current !== null && lastSignature.current !== signature) router.refresh();
        lastSignature.current = signature;

        // Only registration / DNS need the server to re-check the registrar; a mailbox that is merely not yet verified does not.
        const needsProvisioning = data.pipelines.some((p) => p.stages.some((s) => (s.key === "registration" || s.key === "dns") && s.state === "active"));
        nextDelay = needsProvisioning ? POLL_FAST_MS : POLL_SLOW_MS;
        if (needsProvisioning && !nudging.current && Date.now() - lastNudge.current > NUDGE_MS) {
          nudging.current = true;
          lastNudge.current = Date.now();
          fetch("/api/cron/domain-provisioning", { cache: "no-store" })
            .catch(() => {})
            .finally(() => {
              nudging.current = false;
            });
        }
      } catch {
        if (!stopped) setError(true);
      }
      if (!stopped) timer = setTimeout(tick, nextDelay);
    }

    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [router]);

  if (!pipelines || pipelines.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-zinc-500">Live setup status</h2>
      {error && <p className="text-xs text-amber-600">Reconnecting to live status…</p>}
      {pipelines.map((p) => (
        <div key={p.purchaseId} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="mb-2 flex items-center justify-between text-sm font-medium">
            <span>{p.domain}</span>
            {p.inProgress && <span className="text-xs font-normal text-amber-600">updating live…</span>}
          </div>
          <ol className="grid gap-2 sm:grid-cols-4">
            {p.stages.map((s) => (
              <li key={s.key} className="text-xs">
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot[s.state]}`} />
                  <span className={s.state === "failed" ? "text-red-600" : ""}>{s.label}</span>
                </div>
                {s.detail && <p className="mt-1 pl-4 text-zinc-500">{s.detail}</p>}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}
