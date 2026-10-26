import type { SendingHealth } from "@/lib/sending-health-core";

const STYLE: Record<SendingHealth["level"], { box: string; icon: string }> = {
  ok: { box: "border-emerald-500/30 bg-emerald-500/5", icon: "✅" },
  warn: { box: "border-amber-500/40 bg-amber-500/5", icon: "⚠️" },
  bad: { box: "border-red-500/40 bg-red-500/5", icon: "❌" },
};

export default function SendingHealthCard({ health }: { health: SendingHealth }) {
  const s = STYLE[health.level];
  return (
    <div role={health.level === "bad" ? "alert" : "status"} className={`mb-6 rounded-xl border px-4 py-3 text-sm ${s.box}`}>
      <p className="font-medium">
        <span aria-hidden="true">{s.icon} </span>
        {health.headline}
      </p>
      {health.details.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-zinc-600 dark:text-zinc-400">
          {health.details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
