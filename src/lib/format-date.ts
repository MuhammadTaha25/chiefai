/**
 * Formats a timestamp for display in the owner's timezone instead of the
 * server's. These pages are server components, so `toLocaleString()` without
 * a timeZone renders in whatever zone the Vercel function runs in (UTC) —
 * see MINOR-03, QA report Oct 2026.
 */
export function formatLocalDateTime(iso: string, timeZone = "Asia/Karachi") {
  return new Date(iso).toLocaleString(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });
}
