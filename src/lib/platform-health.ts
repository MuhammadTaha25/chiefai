import type { SupabaseClient } from "@supabase/supabase-js";
import { listInboundRoutes } from "@/lib/mailgun";
import { findDuplicateMailboxes, inboundRouteStatus, type InboundRouteStatus } from "@/lib/platform-health-core";

export interface PlatformHealth {
  duplicateMailboxes: { address: string; clients: number; rows: number }[];
  inboundRoute: InboundRouteStatus | { ok: false; problem: "check_failed" };
  /** True when anything needs a human: the cron response carries this so the scheduler's alert can key on it. */
  needsAttention: boolean;
}

/** Read-only. A failure to reach Mailgun is reported as check_failed, never as "all fine". */
export async function runPlatformHealth(admin: SupabaseClient, webhookUrl: string): Promise<PlatformHealth> {
  const { data } = await admin.from("mailboxes").select("address, client_id").limit(5000).returns<{ address: string; client_id: string }[]>();
  const duplicateMailboxes = findDuplicateMailboxes(data ?? []);
  let inboundRoute: PlatformHealth["inboundRoute"];
  try {
    inboundRoute = inboundRouteStatus(await listInboundRoutes(), webhookUrl);
  } catch (e) {
    console.error(`[platform-health] inbound route check failed: ${(e as Error).message}`);
    inboundRoute = { ok: false, problem: "check_failed" };
  }
  return { duplicateMailboxes, inboundRoute, needsAttention: duplicateMailboxes.length > 0 || !inboundRoute.ok };
}
