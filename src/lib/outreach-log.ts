import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * touch_number convention (existing schema, no direction column):
 *   1        = initial outreach
 *   2..n     = numbered follow-ups
 *   0        = an automated reply/confirmation we sent in response to a prospect
 *              (NOT an outreach touch — the dashboard counts only ===1 and >1)
 */
export const REPLY_TOUCH_NUMBER = 0;

/**
 * Inserts an outreach_log row, carrying Mailgun's message id in
 * provider_message_id when that column exists (supabase/add_email_threading.sql).
 * Before the migration is applied the column is missing (Postgres 42703); the
 * row is then written without it rather than losing the log entry entirely.
 */
export async function insertOutreachLog(admin: SupabaseClient, row: Record<string, unknown>) {
  const res = await admin.from("outreach_log").insert(row);
  // PostgREST reports a missing column as PGRST204 (schema-cache miss); raw
  // Postgres as 42703. Either way, don't lose the log row over the new column.
  const missingColumn =
    res.error &&
    (res.error.code === "PGRST204" || res.error.code === "42703" || /provider_message_id/.test(res.error.message ?? ""));
  if (missingColumn && "provider_message_id" in row) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { provider_message_id, ...rest } = row;
    const retry = await admin.from("outreach_log").insert(rest);
    if (retry.error) {
      // eslint-disable-next-line no-console
      console.error(`outreach_log insert failed: ${retry.error.message}`);
    }
    return retry;
  }
  if (res.error) {
    // eslint-disable-next-line no-console
    console.error(`outreach_log insert failed: ${res.error.message}`);
  }
  return res;
}
