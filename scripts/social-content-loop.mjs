/**
 * Local dev scheduler for automatic social content.
 *
 * Production uses the Vercel cron entries in vercel.json. This script is the
 * LOCAL equivalent: it polls the clock once a minute in Asia/Karachi and, at
 * 12:00 / 14:00 / 18:00 / 21:00, hits the same cron route Vercel would hit.
 *
 * Run it alongside `next dev`:
 *   node scripts/social-content-loop.mjs
 * (CRON_SECRET must be in the environment — copy it from .env.local.)
 */

const APP_URL = process.env.APP_URL || "http://localhost:3000";
const CRON_SECRET = process.env.CRON_SECRET;
const TZ = process.env.CONTENT_TIMEZONE || "Asia/Karachi";

const SLOTS = [
  { hour: 12, type: "post" },
  { hour: 14, type: "story" },
  { hour: 18, type: "post" },
  { hour: 21, type: "story" },
];

if (!CRON_SECRET) {
  console.error("CRON_SECRET is not set");
  process.exit(1);
}

function nowInTz() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

const fired = new Set();

async function tick() {
  const { date, hour, minute } = nowInTz();
  for (const slot of SLOTS) {
    if (hour !== slot.hour || minute !== 0) continue;
    const key = `${slot.type}_${slot.hour}_${date}`;
    if (fired.has(key)) continue;
    fired.add(key);
    console.log(`[${new Date().toISOString()}] triggering ${slot.type} (${slot.hour}:00 ${TZ})`);
    try {
      const res = await fetch(`${APP_URL}/api/cron/social-content/${slot.type}?hour=${slot.hour}`, {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });
      console.log(`  -> ${res.status} ${(await res.text()).slice(0, 220)}`);
    } catch (e) {
      console.log(`  -> ERROR ${e.message}`);
    }
  }
}

console.log(`social-content-loop started (TZ=${TZ}, app=${APP_URL})`);
tick();
setInterval(tick, 60_000);
