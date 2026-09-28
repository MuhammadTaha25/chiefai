import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Comment/DM handling helpers around the Zernio webhook: tenant-scoped memory
 * and post-context lookups, the deterministic decision layer that sits between
 * the model's draft and the send call, and the interaction log.
 *
 * Every query here filters by client_id (the business). The client id is the
 * one the webhook resolved from OUR social_connections row — never from the
 * payload — so one business's history/posts can never reach another's prompt.
 */

export type { Decision, InteractionStatus } from "@/lib/brand-guard";
import type { InteractionStatus } from "@/lib/brand-guard";

/** Earlier turns of this DM thread, oldest first, for THIS business only. */
export async function loadConversation(
  admin: SupabaseClient,
  clientId: string,
  conversationId: string | undefined,
  excludeExternalId: string
): Promise<{ role: "customer" | "us"; text: string }[]> {
  if (!conversationId) return [];
  const { data } = await admin
    .from("social_interactions")
    .select("external_id, message_text, ai_response, response_status, created_at")
    .eq("client_id", clientId)
    .eq("conversation_id", conversationId)
    .neq("external_id", excludeExternalId)
    .order("created_at", { ascending: false })
    .limit(10);
  const turns: { role: "customer" | "us"; text: string }[] = [];
  for (const row of (data ?? []).reverse()) {
    turns.push({ role: "customer", text: row.message_text });
    if (row.ai_response && row.response_status === "sent") turns.push({ role: "us", text: row.ai_response });
  }
  return turns;
}

/** The post a comment was left on: our own record of it if we published it, else what the payload carries. */
export async function loadPostContext(
  admin: SupabaseClient,
  clientId: string,
  postIds: (string | undefined)[],
  payloadText: string | undefined
): Promise<string | undefined> {
  const ids = postIds.filter((x): x is string => Boolean(x));
  if (ids.length) {
    const { data } = await admin
      .from("social_posts")
      .select("topic, hook, caption, content_pillar")
      .eq("client_id", clientId)
      .in("zernio_post_id", ids)
      .limit(1)
      .maybeSingle();
    if (data?.caption || data?.hook) {
      return [data.topic && !/^auto_/.test(data.topic) ? `Topic: ${data.topic}` : "", data.hook ? `Hook: ${data.hook}` : "", data.caption ? `Caption: ${data.caption}` : ""]
        .filter(Boolean)
        .join("\n");
    }
  }
  return payloadText?.trim() || undefined;
}

export interface InteractionRecord {
  client_id: string;
  social_account_id: string;
  platform: "instagram" | "facebook";
  interaction_type: "comment" | "dm";
  external_id: string;
  conversation_id?: string;
  post_id?: string;
  commenter_id?: string;
  message_text: string;
  detected_intent?: string;
  requires_human?: boolean;
  handoff_reason?: string;
  retrieved_context?: unknown;
  ai_response?: string;
  response_status: InteractionStatus;
}

/** Best-effort: the log must never turn a successfully sent reply into a webhook failure. */
export async function recordInteraction(admin: SupabaseClient, rec: InteractionRecord): Promise<void> {
  const { error } = await admin
    .from("social_interactions")
    .upsert(rec, { onConflict: "client_id,platform,interaction_type,external_id" });
  if (error) console.error(`[social_interactions] could not record interaction: ${error.message}`);
}
