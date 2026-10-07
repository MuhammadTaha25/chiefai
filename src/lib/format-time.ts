/**
 * Formats a stored (UTC) timestamp in a specific IANA timezone.
 *
 * Server components render on the host's clock, which is UTC on Vercel, so a bare
 * `new Date(x).toLocaleString()` shows UTC to everybody. Pass the viewer's timezone instead.
 * An unknown timezone falls back to `fallbackTz` rather than throwing (an invalid zone makes
 * Intl throw a RangeError, which would take the whole page down); an unparseable date gives "—".
 */
export function formatInTimezone(iso: string | null | undefined, tz: string, fallbackTz = "Asia/Karachi"): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: tz }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: fallbackTz }).format(date);
  }
}
