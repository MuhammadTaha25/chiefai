import type { SupabaseClient } from "@supabase/supabase-js";
import { getMailboxHealth, getUnhealthyMailboxIds } from "@/lib/mailbox-health";
import { getMailboxReadiness } from "@/lib/mailgun";
import { getSendingBrokenDomains } from "@/lib/dns-health-gate";
import { domainCapForAge, effectiveDailyLimit } from "@/lib/warmup-schedule";
import { startOfLocalDay } from "@/lib/company-facts";
import { followUpsPinnedTo, newEmailFits, originalMailboxByLead } from "@/lib/follow-up-capacity";

/**
 * Picks a mailbox this client can actually send from — one whose Mailgun
 * domain is verified/active. Prefers the mailbox that already emailed this
 * lead (thread continuity), then any other ready one. Returns null when none
 * is ready, so callers skip the send instead of failing against Mailgun
 * (or worse, recording a send that never happened).
 */
export async function pickReadyMailbox(
  admin: SupabaseClient,
  clientId: string,
  leadId?: string
): Promise<{ id: string; address: string } | null> {
  const { data: mailboxes } = await admin
    .from("mailboxes")
    .select("id, address")
    .eq("client_id", clientId)
    .order("created_at", { ascending: true });
  if (!mailboxes || mailboxes.length === 0) return null;

  let preferredId: string | undefined;
  if (leadId) {
    const { data: last } = await admin
      .from("outreach_log")
      .select("mailbox_id")
      .eq("client_id", clientId)
      .eq("lead_id", leadId)
      .not("mailbox_id", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ mailbox_id: string }>();
    preferredId = last?.mailbox_id;
  }
  const ordered = [...mailboxes].sort((a, b) => Number(b.id === preferredId) - Number(a.id === preferredId));
  // Prefer healthy mailboxes; an unhealthy one (high bounce/complaint rate) is only used if nothing else is ready,
  // because a reply to someone who already wrote to us is not cold outreach.
  const unhealthy = await getUnhealthyMailboxIds(admin, clientId);
  const dnsBroken = await getSendingBrokenDomains(admin, clientId); // empty unless DNS_HEALTH_PAUSE_SENDING=1
  let fallback: { id: string; address: string } | null = null;
  for (const m of ordered) {
    if (dnsBroken.has(m.address.slice(m.address.lastIndexOf("@") + 1).trim().toLowerCase())) continue;
    if ((await getMailboxReadiness(m.address)) !== "ready") continue;
    if (!unhealthy.has(m.id)) return m;
    fallback ??= m;
  }
  return fallback;
}

/**
 * Start of the current sending day, as an ISO time. With the client's timezone it is that client's own midnight, the same
 * boundary send-batch uses for the first-email cap and the Domains page uses for "sent today", so every limit resets at
 * the same moment. Without a valid timezone it falls back to the server's midnight.
 */
export function startOfSendDay(timeZone?: string | null): string {
  if (timeZone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone });
      return startOfLocalDay(timeZone).toISOString();
    } catch {
      // invalid timezone: fall through to the server clock
    }
  }
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function clientTimeZone(admin: SupabaseClient, clientId: string): Promise<string | null> {
  try {
    const { data } = await admin.from("clients").select("timezone").eq("id", clientId).maybeSingle<{ timezone: string | null }>();
    return data?.timezone ?? null;
  } catch {
    return null;
  }
}

export { WARMUP_CAP, coldLimitForAge, effectiveDailyLimit, describeMailboxLimit } from "@/lib/warmup-schedule";

export type MailboxReservation =
  | { ok: true; mailbox: { id: string; address: string }; reservationId: string }
  | { ok: false; reason: "no_mailbox" | "at_capacity" | "all_unhealthy" | "duplicate_touch" };

/**
 * Sales sends today for one mailbox. touch_number 0 (auto-replies to prospects) is excluded: replies are
 * not outbound prospecting, and the limit exists to protect cold-outreach volume.
 */
async function salesSendsToday(admin: SupabaseClient, mailboxId: string, since: string): Promise<number> {
  const { count } = await admin
    .from("outreach_log")
    .select("id", { count: "exact", head: true })
    .eq("mailbox_id", mailboxId)
    .gte("touch_number", 1)
    .gte("sent_at", since);
  return count ?? 0;
}

/** Max cold sends per sending DOMAIN per day, across all its mailboxes (Google counts reputation per domain). */
export const domainDailySendCap = () => (Number(process.env.DOMAIN_DAILY_SEND_CAP) > 0 ? Number(process.env.DOMAIN_DAILY_SEND_CAP) : 100);

async function domainCapReached(
  admin: SupabaseClient,
  all: { id: string; address: string; created_at?: string | null }[],
  m: { id: string; address: string },
  dayStart: string
): Promise<boolean> {
  const domain = m.address.slice(m.address.lastIndexOf("@") + 1).toLowerCase();
  const siblings = all.filter((x) => x.address.slice(x.address.lastIndexOf("@") + 1).toLowerCase() === domain);
  if (siblings.length < 2) return false; // a single mailbox is already bound by its own (<= 30 while warming) limit
  let total = 0;
  for (const s of siblings) total += await salesSendsToday(admin, s.id, dayStart);
  // A young domain gets a lower ceiling that rises with its age (oldest mailbox on the domain), up to the env cap.
  const oldest = Math.min(...siblings.map((x) => (x.created_at ? Date.parse(x.created_at) : Date.now())));
  const ageDays = Math.max(0, Math.floor((Date.now() - oldest) / 86400000));
  return total >= domainCapForAge(ageDays, domainDailySendCap());
}

/**
 * Follow-ups still due today (or overdue) that are pinned to this mailbox because it sent their first email.
 * New first emails leave room for them (see follow-up-capacity.ts). Any lookup problem counts as 0 so a database
 * hiccup can never stop sending.
 */
async function dueFollowUpsPinnedTo(admin: SupabaseClient, clientId: string, mailboxId: string, dayStart: string): Promise<number> {
  try {
    const endOfDay = new Date(new Date(dayStart).getTime() + 24 * 60 * 60 * 1000).toISOString();
    const { data: due } = await admin
      .from("leads")
      .select("id")
      .eq("client_id", clientId)
      .gte("follow_up_number", 1)
      .eq("reply_received", false)
      .eq("unsubscribed", false)
      .eq("email_bounced", false)
      .eq("booked", false)
      .eq("complained", false)
      .eq("manually_stopped", false)
      .lte("next_follow_up_at", endOfDay)
      .limit(150)
      .returns<{ id: string }[]>();
    if (!due?.length) return 0;
    const ids = due.map((d) => d.id);
    const { data: firsts } = await admin
      .from("outreach_log")
      .select("lead_id, mailbox_id")
      .eq("client_id", clientId)
      .in("lead_id", ids)
      .not("mailbox_id", "is", null)
      .order("sent_at", { ascending: true })
      .returns<{ lead_id: string; mailbox_id: string | null }[]>();
    return followUpsPinnedTo(ids, originalMailboxByLead(firsts ?? []), mailboxId);
  } catch {
    return 0;
  }
}

/**
 * Picks a ready mailbox of THIS client that still has capacity today and reserves one send slot on it,
 * atomically. EVERY outbound sales email must go through this before calling Mailgun.
 *
 * Concurrency: the reservation is an outreach_log row inserted BEFORE the count that decides the outcome
 * ("insert, then verify"). Each request commits its own row first and then counts all of today's rows
 * including its own, so whichever of any two racing requests counts last sees both rows. Two requests can
 * therefore never both be accepted for the last slot; under contention both may back off (they fall through
 * to the next mailbox or report at_capacity) but the limit is never exceeded. A reservation whose send never
 * completed keeps counting until released — the safe direction.
 *
 * The caller must call finalizeReservation() after a successful send, or releaseReservation() if the send
 * failed. The pending row carries provider_message_id = "pending:<id>" until then.
 */
export async function reserveMailboxSlot(
  admin: SupabaseClient,
  clientId: string,
  leadId: string,
  row: { touch_number: number; campaign_id?: string | null; subject?: string; body?: string },
  options?: { mailboxId?: string; timeZone?: string | null }
): Promise<MailboxReservation> {
  // "Today" is the client's own day, so the mailbox limit and the first-email cap reset at the same moment.
  const dayStart = startOfSendDay(options?.timeZone ?? (await clientTimeZone(admin, clientId)));
  const { data: allMailboxes } = await admin
    .from("mailboxes")
    .select("id, address, daily_send_limit, created_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: true })
    .returns<{ id: string; address: string; daily_send_limit: number | null; created_at: string }[]>();
  // Block mode: only the mailbox whose block is running right now may send.
  const mailboxes = options?.mailboxId ? (allMailboxes ?? []).filter((m) => m.id === options.mailboxId) : allMailboxes;
  if (!mailboxes || mailboxes.length === 0) return { ok: false, reason: "no_mailbox" };

  const { data: last } = await admin
    .from("outreach_log")
    .select("mailbox_id")
    .eq("client_id", clientId)
    .eq("lead_id", leadId)
    .not("mailbox_id", "is", null)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ mailbox_id: string }>();
  const preferredId = last?.mailbox_id;
  // Rotation: keep the mailbox that already emailed this lead (thread continuity); otherwise spread sends by
  // taking the READY mailbox with the fewest sales sends today (random tie-break). A mailbox that hits its
  // daily limit is skipped below, so sending switches to the next one automatically.
  // Health failover: a mailbox with a high recent bounce/complaint rate is skipped for NEW sales sends so mail
  // shifts to the tenant's other healthy mailboxes (see mailbox-health.ts).
  const { unhealthy, slow } = await getMailboxHealth(admin, clientId);
  let skippedUnhealthy = false;
  const readyMailboxes: { m: (typeof mailboxes)[number]; used: number }[] = [];
  for (const m of mailboxes) {
    if ((await getMailboxReadiness(m.address)) !== "ready") continue;
    if (unhealthy.has(m.id)) {
      skippedUnhealthy = true;
      continue;
    }
    readyMailboxes.push({ m, used: await salesSendsToday(admin, m.id, dayStart) });
  }
  const ordered = readyMailboxes
    .sort((x, y) => Number(y.m.id === preferredId) - Number(x.m.id === preferredId) || x.used - y.used || Math.random() - 0.5)
    .map((r) => r.m);

  let sawReady = false;
  for (const m of ordered) {
    sawReady = true;
    const limit = effectiveDailyLimit(m, Date.now(), !unhealthy.has(m.id), slow.has(m.id));
    // A NEW first email (touch 1) only gets the slots left after the follow-ups still due today that are pinned
    // to this mailbox, so follow-ups are not starved by new sends. Follow-ups themselves use the full limit.
    const reservedForFollowUps = row.touch_number === 1 ? await dueFollowUpsPinnedTo(admin, clientId, m.id, dayStart) : 0;
    // Contention can make every racing request back off at once (safe, but nobody wins); a short random
    // jitter and retry lets one of them through. The limit is re-checked on every attempt.
    for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 40 + Math.random() * 160));
    const usedNow = await salesSendsToday(admin, m.id, dayStart);
    if (usedNow >= limit) break;
    // Receivers count reputation per DOMAIN, so the sum over all of this domain's mailboxes is capped too.
    if (await domainCapReached(admin, allMailboxes ?? [], m, dayStart)) break;
    if (reservedForFollowUps > 0 && !newEmailFits(usedNow, reservedForFollowUps, limit)) break;

    const { data: reserved, error } = await admin
      .from("outreach_log")
      .insert({
        client_id: clientId,
        lead_id: leadId,
        mailbox_id: m.id,
        campaign_id: row.campaign_id ?? null,
        touch_number: row.touch_number,
        subject: row.subject ?? "(sending)",
        body: row.body ?? "",
        provider_message_id: `pending:${crypto.randomUUID()}`,
      })
      .select("id")
      .single<{ id: string }>();
    if (error && (error as { code?: string }).code === "23505") {
      // This lead already has a row for this touch (unique index lead_id + touch_number). A real send means a duplicate
      // attempt: refuse it. A stale "pending:" row from a crashed run is cleared once so the touch is not blocked forever.
      const { data: existing } = await admin
        .from("outreach_log")
        .select("id, provider_message_id, sent_at")
        .eq("lead_id", leadId)
        .eq("touch_number", row.touch_number)
        .limit(1)
        .maybeSingle<{ id: string; provider_message_id: string | null; sent_at: string }>();
      const stalePending = existing && String(existing.provider_message_id ?? "").startsWith("pending:") && Date.now() - Date.parse(existing.sent_at) > 15 * 60_000;
      if (stalePending && attempt < 3) {
        await admin.from("outreach_log").delete().eq("id", existing!.id);
        continue;
      }
      return { ok: false, reason: "duplicate_touch" };
    }
    if (error || !reserved) break;

    if ((await salesSendsToday(admin, m.id, dayStart)) > limit) {
      await admin.from("outreach_log").delete().eq("id", reserved.id);
      continue;
    }
    return { ok: true, mailbox: { id: m.id, address: m.address }, reservationId: reserved.id };
    }
  }
  if (!sawReady && skippedUnhealthy) return { ok: false, reason: "all_unhealthy" };
  return { ok: false, reason: sawReady ? "at_capacity" : "no_mailbox" };
}

export async function finalizeReservation(
  admin: SupabaseClient,
  reservationId: string,
  sent: { messageId?: string; subject: string; body: string }
) {
  await admin
    .from("outreach_log")
    .update({ provider_message_id: sent.messageId ?? null, subject: sent.subject, body: sent.body, sent_at: new Date().toISOString() })
    .eq("id", reservationId);
}

export async function releaseReservation(admin: SupabaseClient, reservationId: string) {
  await admin.from("outreach_log").delete().eq("id", reservationId);
}
