/**
 * Formats a stored (UTC) timestamp in a specific IANA timezone.
 *
 * Server components render on the host's clock, which is UTC on Vercel, so a bare
 * `new Date(x).toLocaleString()` shows UTC to everybody. Pass the viewer's timezone instead.
 * An unknown timezone falls back to `fallbackTz` rather than throwing (an invalid zone makes
 * Intl throw a RangeError, which would take the whole page down); an unparseable date gives "—".
 */
function formatWith(
  iso: string | null | undefined,
  tz: string,
  fallbackTz: string,
  options: Intl.DateTimeFormatOptions
): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: tz }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: fallbackTz }).format(date);
  }
}

/** "Oct 7, 2026, 4:58 PM" */
export function formatInTimezone(iso: string | null | undefined, tz: string, fallbackTz = "Asia/Karachi"): string {
  return formatWith(iso, tz, fallbackTz, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Clock time only, same look as toLocaleTimeString(): "4:54:28 PM" */
export function formatClockInTimezone(iso: string | null | undefined, tz: string, fallbackTz = "Asia/Karachi"): string {
  return formatWith(iso, tz, fallbackTz, { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
}

/** Date only, same look as toLocaleDateString(): "10/10/2026" */
export function formatDateInTimezone(iso: string | null | undefined, tz: string, fallbackTz = "Asia/Karachi"): string {
  return formatWith(iso, tz, fallbackTz, { year: "numeric", month: "numeric", day: "numeric" });
}
