import http from "node:http";

/**
 * In-app scheduler: the app wakes ITSELF, so nothing outside it (Vercel cron,
 * n8n, cron-job.org) is needed.
 *
 * It works whenever the app runs as a normal long-lived Node server (`npm run
 * dev`, `npm start`, a VPS). It is switched off on Vercel, where a serverless
 * function cannot keep a timer alive (and Vercel's own cron is what applies).
 *
 * Each tick just GETs the same protected /api/cron/* route Vercel would call,
 * on 127.0.0.1 with the CRON_SECRET, so all logic (what is due, per-slot
 * de-duplication, publish permissions) stays in one place. node:http is used
 * instead of fetch because a video job runs for minutes and fetch's default
 * headers timeout would cut the connection long before it finishes.
 *
 * Jobs are grouped. Only "social" is on by default; the rest send emails, place
 * voice calls or write to third-party accounts, so they stay opt-in:
 *   IN_APP_SCHEDULER_JOBS=social,email,voice,domains,calendly,ads,endpoints
 * Turn everything off with IN_APP_SCHEDULER=off.
 */

interface Job {
  group: string;
  path: string;
  everyMinutes: number;
}

const JOBS: Job[] = [
  { group: "social", path: "/api/cron/social-content/post", everyMinutes: 10 },
  { group: "social", path: "/api/cron/social-content/story", everyMinutes: 10 },
  { group: "social", path: "/api/cron/social-initial", everyMinutes: 2 },
  { group: "endpoints", path: "/api/cron/sync-endpoints", everyMinutes: 10 },
  { group: "email", path: "/api/cron/follow-ups", everyMinutes: 60 },
  { group: "email", path: "/api/campaigns/send-daily-batch", everyMinutes: 60 },
  { group: "voice", path: "/api/cron/voice-daily-call", everyMinutes: 1 },
  { group: "domains", path: "/api/cron/domain-provisioning", everyMinutes: 5 },
  { group: "calendly", path: "/api/cron/calendly-sync", everyMinutes: 5 },
  { group: "ads", path: "/api/ads/sync", everyMinutes: 30 },
];

const STARTUP_DELAY_MS = 60_000;

function call(path: string, secret: string, port: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { authorization: `Bearer ${secret}` } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/** One-line summary of a job response for the server log. */
function summarize(body: string): string {
  try {
    const j = JSON.parse(body) as { generated?: number; processed?: number; results?: { result?: string; status?: string; detail?: string; slot?: string }[] };
    const acted = (j.results ?? []).filter((r) => r.result && r.result !== "skipped");
    if (acted.length) return acted.map((r) => `${r.slot ?? ""} ${r.result}${r.detail ? ` (${r.detail})` : ""}`).join("; ");
    if (typeof j.processed === "number") return `processed ${j.processed}`;
    return typeof j.generated === "number" ? `generated ${j.generated}` : "ok";
  } catch {
    return body.slice(0, 80);
  }
}

export function startInAppScheduler(): void {
  if (process.env.VERCEL || process.env.IN_APP_SCHEDULER === "off") return;
  const g = globalThis as { __infomistScheduler?: boolean };
  if (g.__infomistScheduler) return; // dev hot-reload must not stack timers
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn("[scheduler] CRON_SECRET is not set — in-app scheduler not started");
    return;
  }
  g.__infomistScheduler = true;

  const groups = new Set((process.env.IN_APP_SCHEDULER_JOBS ?? "social,voice").split(",").map((s) => s.trim()).filter(Boolean));
  const jobs = JOBS.filter((j) => groups.has(j.group));
  const port = process.env.PORT || "3000";
  const running = new Set<string>();

  const tick = async (job: Job) => {
    if (running.has(job.path)) return; // a long run (video) must never overlap itself
    running.add(job.path);
    try {
      const { status, body } = await call(job.path, secret, port);
      const summary = status === 200 ? summarize(body) : `HTTP ${status}`;
      // Idle ticks are silent; log only when something happened or failed.
      if (status !== 200 || !/^(generated 0|processed 0|ok)$/.test(summary)) console.log(`[scheduler] ${job.path} → ${summary}`);
    } catch (err) {
      console.warn(`[scheduler] ${job.path} failed: ${(err as Error).message}`);
    } finally {
      running.delete(job.path);
    }
  };

  for (const job of jobs) {
    setTimeout(() => {
      void tick(job);
      setInterval(() => void tick(job), job.everyMinutes * 60_000).unref?.();
    }, STARTUP_DELAY_MS).unref?.();
  }
  console.log(`[scheduler] started: ${jobs.map((j) => `${j.path} /${j.everyMinutes}m`).join(", ")}`);
}
