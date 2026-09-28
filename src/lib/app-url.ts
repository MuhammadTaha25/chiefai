/**
 * The app's PUBLIC origin, used for every ABSOLUTE URL that leaves the app (webhook /
 * callback URLs registered with Mailgun, Calendly, Zernio and MCP OAuth providers;
 * Stripe success/cancel URLs).
 *
 * Production: PUBLIC_APP_URL is REQUIRED and is the only source. The request's Host
 * header is never trusted, so a spoofed Host cannot point a provider callback at
 * another domain. Missing config fails closed with a clear error.
 *
 * Development: falls back to the request's own origin (localhost) so local flows keep
 * working. `preferEnv` keeps PUBLIC_APP_URL (e.g. an ngrok tunnel) winning where the
 * provider must be able to reach the app from the internet (webhook registration).
 */
export class AppUrlNotConfiguredError extends Error {
  constructor() {
    super("PUBLIC_APP_URL is not configured; it is required in production for provider callback/webhook URLs");
  }
}

export function resolveAppOrigin(req: { nextUrl: { origin: string } }, opts: { preferEnv?: boolean } = { preferEnv: true }): string {
  const configured = process.env.PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") {
    if (!configured) throw new AppUrlNotConfiguredError();
    return configured;
  }
  return opts.preferEnv && configured ? configured : req.nextUrl.origin;
}
