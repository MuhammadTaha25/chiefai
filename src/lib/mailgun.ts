const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_API_BASE_URL = process.env.MAILGUN_API_BASE_URL ?? "https://api.mailgun.net/v3";

function authHeader() {
  if (!MAILGUN_API_KEY) throw new Error("MAILGUN_API_KEY is not set");
  return "Basic " + Buffer.from(`api:${MAILGUN_API_KEY}`).toString("base64");
}

/**
 * Server-only. Wraps the Mailgun API (ZERNIO_META_ADS_SPEC.md §7) for
 * sending nurture-sequence emails and provisioning per-client mailboxes.
 * Never call from the browser — always go through a Next.js API route.
 */
export async function sendMail(params: {
  domain: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Provider Message-Id of the message this one replies to — sets In-Reply-To/References for real threading. */
  inReplyTo?: string;
  /** Extra message headers, e.g. { "List-Unsubscribe": "<mailto:...>" } (sent as h:<name>). */
  headers?: Record<string, string>;
}) {
  const body = new URLSearchParams({
    from: params.from,
    to: params.to,
    subject: params.subject,
    text: params.text,
    ...(params.html ? { html: params.html } : {}),
  });
  // Mailboxes are addressed on the ROOT domain (sales@example.com) but only
  // the per-prefix Mailgun subdomain (sales.example.com) has MX records
  // pointing at Mailgun — confirmed live: mail to sales@example.com fails
  // with "unable to connect to MX servers" because the root domain has no
  // MX. Replies must therefore go to the subdomain address, which Mailgun
  // actually receives. (The webhook maps it back to the root-form mailbox.)
  if (params.inReplyTo) {
    body.set("h:In-Reply-To", params.inReplyTo);
    body.set("h:References", params.inReplyTo);
  }
  for (const [k, v] of Object.entries(params.headers ?? {})) body.set(`h:${k}`, v);
  const [fromLocal, fromRoot] = params.from.replace(/^.*</, "").replace(/>$/, "").split("@");
  if (fromLocal && fromRoot && params.domain === `${fromLocal}.${fromRoot}`) {
    body.set("h:Reply-To", `${fromLocal}@${params.domain}`);
  }

  const res = await fetch(`${MAILGUN_API_BASE_URL}/${params.domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Mailgun send failed: ${res.status} ${text}`);
  }

  return res.json() as Promise<{ id: string; message: string }>;
}

/**
 * The Mailgun domain a mailbox sends through: ONE Mailgun domain per ROOT
 * domain — never one per mailbox prefix.
 *
 * `taha@`, `sales@` and `hello@example.com` are just different local parts of
 * the same domain; Mailgun tells them apart through routes and addresses, so
 * none of them needs a domain of its own.
 *
 * The old per-prefix scheme (`taha.example.com`, `sales.example.com`, …)
 * demanded a SEPARATE Mailgun domain for every mailbox, which hard-fails on
 * any plan with a domain cap — confirmed live: "Domains limit of 1 has been
 * exceeded for the account". On such a plan the first mailbox worked and every
 * later one silently became a DB row with no Mailgun domain behind it, so it
 * could never send or receive anything.
 */
export function mailgunDomainForAddress(address: string) {
  const at = address.lastIndexOf("@");
  return (at === -1 ? address : address.slice(at + 1)).trim().toLowerCase();
}

export type DeliveryStatus = "delivered" | "bounced" | "accepted" | "unknown";

/**
 * Looks up the latest known delivery outcome for each recipient on a domain,
 * from Mailgun's own event log (not our DB — Mailgun is the source of truth
 * for whether a send actually landed). Used to show Delivered/Bounced badges
 * on the sent-emails view instead of silently treating "we called the send
 * API" as "the client got the email".
 */
export async function getDeliveryStatusesForDomain(domain: string): Promise<Map<string, DeliveryStatus>> {
  const statuses = new Map<string, DeliveryStatus>();

  const res = await fetch(
    `${MAILGUN_API_BASE_URL}/${domain}/events?limit=300&event=delivered%20OR%20failed%20OR%20accepted`,
    { headers: { Authorization: authHeader() } }
  );
  if (!res.ok) return statuses;

  const data = (await res.json()) as { items?: { event: string; recipient: string; severity?: string }[] };

  // Events come back newest-first; keep the first (latest) status seen per
  // recipient, and let a real "delivered"/"failed" outcome win over a merely
  // "accepted" (queued, outcome not yet known) one recorded around the same time.
  for (const item of data.items ?? []) {
    const existing = statuses.get(item.recipient);
    const next: DeliveryStatus =
      item.event === "delivered" ? "delivered" : item.event === "failed" ? "bounced" : "accepted";
    if (!existing || existing === "accepted") statuses.set(item.recipient, next);
  }

  return statuses;
}

/**
 * Registers a domain on Mailgun so mailboxes on it can send/receive. This is
 * separate from the DNS records themselves (the removed n8n provision-dns route; now handled in-app,
 * which provisions the actual DNS records via the domain registrar) — the
 * client must add the DNS records Mailgun returns here before the domain
 * verifies.
 */
export async function createMailgunDomain(domain: string) {
  // Look first. On a plan at its domain limit, Mailgun answers a create for a domain that ALREADY exists with
  // "403 domain limit exceeded" instead of "400 already exists" - so relying on the create error made every
  // retry of an already-provisioned domain fail. Existing domain = success, no create call.
  const existing = await fetch(`${MAILGUN_API_BASE_URL}/domains/${encodeURIComponent(domain)}`, {
    headers: { Authorization: authHeader() },
  }).catch(() => null);
  if (existing?.ok) return { message: "Domain already exists" };

  const res = await fetch(`${MAILGUN_API_BASE_URL}/domains`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ name: domain }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // "already exists" is the expected, non-fatal outcome on a retry — the
    // caller still needs its DNS records back either way, so treat it as
    // success and continue to getMailgunDnsRecords instead of throwing.
    if (res.status === 400 && /already exists/i.test(text)) {
      return { message: "Domain already exists" };
    }
    if (res.status === 403 && /limit/i.test(text)) {
      throw new Error(`Mailgun plan domain limit reached - upgrade the Mailgun plan to add ${domain} (${text.slice(0, 160)})`);
    }
    throw new Error(`Mailgun domain create failed: ${res.status} ${text}`);
  }

  return res.json();
}

export interface MailgunDnsRecord {
  record_type: "TXT" | "CNAME" | "MX";
  name: string;
  value: string;
  priority?: string;
  valid: string;
}

/**
 * Ground truth for what Mailgun actually requires this domain to have in
 * DNS — never hardcode these from a previous domain's values (SPF/DKIM keys
 * are per-domain). Call after createMailgunDomain so the domain exists to
 * query.
 */
export async function getMailgunDnsRecords(
  mailgunDomain: string
): Promise<{ sending: MailgunDnsRecord[]; receiving: MailgunDnsRecord[] }> {
  const res = await fetch(`${MAILGUN_API_BASE_URL}/domains/${mailgunDomain}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Mailgun get domain failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return {
    sending: data.sending_dns_records ?? [],
    receiving: data.receiving_dns_records ?? [],
  };
}

/** Ground truth for "is this domain actually verified" — never inferred from a DNS write succeeding. */
export async function getMailgunDomainState(mailgunDomain: string): Promise<string | null> {
  const res = await fetch(`${MAILGUN_API_BASE_URL}/domains/${mailgunDomain}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.domain?.state ?? null;
}

/** Asks Mailgun to re-check DNS right now instead of waiting for its own polling cycle. */
export async function verifyMailgunDomain(mailgunDomain: string): Promise<string | null> {
  const res = await fetch(`${MAILGUN_API_BASE_URL}/domains/${mailgunDomain}/verify`, {
    method: "PUT",
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.domain?.state ?? null;
}

/**
 * Registers Mailgun's own tracking webhooks (complaint/unsubscribe — spec
 * PHASE 5/PHASE 4) for one domain, pointed at our central events handler.
 * Distinct from `createInboundRoute`, which handles actual reply *content*;
 * this handles Mailgun's provider-level signals about a message's fate.
 * Best-effort per call site — a failure here shouldn't block mailbox setup.
 */
export async function registerTrackingWebhooks(domain: string, webhookUrl: string) {
  const failures: string[] = [];
  for (const eventType of ["complained", "unsubscribed", "permanent_fail"] as const) {
    const res = await fetch(`${MAILGUN_API_BASE_URL}/domains/${domain}/webhooks`, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ id: eventType, url: webhookUrl }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Already registered is fine (idempotent). One event failing must not stop the others being registered.
      if (res.status === 400 && /already exist/i.test(text)) continue;
      failures.push(`${eventType}: ${res.status} ${text.slice(0, 120)}`);
    }
  }
  if (failures.length) throw new Error(`Mailgun webhook registration failed for ${domain}: ${failures.join("; ")}`);
}

/**
 * Sets up inbound routing so replies to `address` land on our webhook
 * (/api/webhooks/mailgun) instead of nowhere — Mailgun domains send-only by
 * default.
 */
/**
 * Ensures ONE catch-all inbound route forwards every received message to our
 * webhook. Per-mailbox routes don't scale (Mailgun's free plan caps routes at
 * 5 — confirmed live: "Routes quota (5) is exceeded") and were also pointing
 * at root-domain addresses that have no MX. The webhook resolves
 * recipient -> mailbox -> client itself, so one route serves every tenant.
 * Idempotent: no-ops if a route already forwards to this URL.
 */
export async function createInboundRoute(_address: string, webhookUrl: string) {
  const list = await fetch(`${MAILGUN_API_BASE_URL}/routes?limit=100`, { headers: { Authorization: authHeader() } });
  if (list.ok) {
    const data = (await list.json()) as { items?: { expression: string; actions: string[] }[] };
    const exists = (data.items ?? []).some(
      (r) => r.expression.includes("catch_all") && r.actions.some((act) => act.includes(webhookUrl))
    );
    if (exists) return { message: "catch-all route already present" };
  }
  const body = new URLSearchParams();
  body.set("priority", "0");
  body.set("description", "Infomist inbound catch-all -> webhook (tenant resolved by recipient mailbox)");
  body.set("expression", "catch_all()");
  body.append("action", `forward("${webhookUrl}")`);
  body.append("action", "stop()");
  const res = await fetch(`${MAILGUN_API_BASE_URL}/routes`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Mailgun route create failed: ${res.status} ${text}`);
  }
  return res.json();
}

export type MailboxReadiness = "ready" | "verifying" | "not_provisioned";

const readinessCache = new Map<string, { at: number; value: MailboxReadiness }>();
const READINESS_TTL_MS = 60_000;

/**
 * A mailbox row in our DB proves nothing about whether it can actually send:
 * the row is inserted before Mailgun/DNS provisioning runs, and provisioning
 * can fail (confirmed live — several mailboxes existed with no Mailgun domain
 * at all). Ground truth is Mailgun's own domain state for that mailbox's
 * sending subdomain: "active" = ready, present-but-not-active = still
 * verifying, absent = never provisioned.
 */
export async function getMailboxReadiness(address: string): Promise<MailboxReadiness> {
  const domain = mailgunDomainForAddress(address);
  const cached = readinessCache.get(domain);
  if (cached && Date.now() - cached.at < READINESS_TTL_MS) return cached.value;

  const res = await fetch(`${MAILGUN_API_BASE_URL}/domains/${domain}`, { headers: { Authorization: authHeader() } }).catch(
    () => null
  );
  let value: MailboxReadiness = "not_provisioned";
  if (res?.ok) {
    const data = await res.json().catch(() => null);
    value = data?.domain?.state === "active" ? "ready" : "verifying";
  }
  readinessCache.set(domain, { at: Date.now(), value });
  return value;
}
