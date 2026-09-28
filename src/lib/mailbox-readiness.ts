import type { SupabaseClient } from "@supabase/supabase-js";
import { getMailboxReadiness } from "@/lib/mailgun";

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
  for (const m of ordered) {
    if ((await getMailboxReadiness(m.address)) === "ready") return m;
  }
  return null;
}

/** Start of the current day: the same boundary the Domains page uses for "sent today". */
export function startOfSendDay(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Warmup ramp: the stored daily_send_limit is the day-1 base; it grows by WARMUP_STEP per full day since the mailbox was created, up to WARMUP_CAP. */
export const WARMUP_STEP = 2;
export const WARMUP_CAP = 30;
export function effectiveDailyLimit(m: { daily_send_limit: number | null; created_at?: string | null }, now = Date.now()): number {
  const base = Math.max(0, m.daily_send_limit ?? 0);
  if (base === 0) return 0;
  const ageDays = m.created_at ? Math.max(0, Math.floor((now - new Date(m.created_at).getTime()) / 86400000)) : 0;
  return Math.max(base, Math.min(WARMUP_CAP, base + WARMUP_STEP * ageDays));
}

export type MailboxReservation =
  | { ok: true; mailbox: { id: string; address: string }; reservationId: string }
  | { ok: false; reason: "no_mailbox" | "at_capacity" };

/**
 * Sales sends today for one mailbox. touch_number 0 (auto-replies to prospects) is excluded: replies are
 * not outbound prospecting, and the limit exists to protect cold-outreach volume.
 */
async function salesSendsToday(admin: SupabaseClient, mailboxId: string): Promise<number> {
  const { count } = await admin
    .from("outreach_log")
    .select("id", { count: "exact", head: true })
    .eq("mailbox_id", mailboxId)
    .gte("touch_number", 1)
    .gte("sent_at", startOfSendDay());
  return count ?? 0;
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
  row: { touch_number: number; campaign_id?: string | null; subject?: string; body?: string }
): Promise<MailboxReservation> {
  const { data: mailboxes } = await admin
    .from("mailboxes")
    .select("id, address, daily_send_limit, created_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: true })
    .returns<{ id: string; address: string; daily_send_limit: number | null; created_at: string }[]>();
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
  const readyMailboxes: { m: (typeof mailboxes)[number]; used: number }[] = [];
  for (const m of mailboxes) {
    if ((await getMailboxReadiness(m.address)) !== "ready") continue;
    readyMailboxes.push({ m, used: await salesSendsToday(admin, m.id) });
  }
  const ordered = readyMailboxes
    .sort((x, y) => Number(y.m.id === preferredId) - Number(x.m.id === preferredId) || x.used - y.used || Math.random() - 0.5)
    .map((r) => r.m);

  let sawReady = false;
  for (const m of ordered) {
    sawReady = true;
    const limit = effectiveDailyLimit(m);
    // Contention can make every racing request back off at once (safe, but nobody wins); a short random
    // jitter and retry lets one of them through. The limit is re-checked on every attempt.
    for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 40 + Math.random() * 160));
    if ((await salesSendsToday(admin, m.id)) >= limit) break;

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
    if (error || !reserved) break;

    if ((await salesSendsToday(admin, m.id)) > limit) {
      await admin.from("outreach_log").delete().eq("id", reserved.id);
      continue;
    }
    return { ok: true, mailbox: { id: m.id, address: m.address }, reservationId: reserved.id };
    }
  }
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
