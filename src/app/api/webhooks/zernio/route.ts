import { getClientBusinessContext, retrieveBusinessContext, describeContextForLog } from "@/lib/business-context";
import { generateGroundedReply } from "@/lib/social-ai";
import { decideReply } from "@/lib/brand-guard";
import { loadConversation, loadPostContext, recordInteraction } from "@/lib/social-inbox";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  verifyZernioSignature,
  replyToComment,
  sendDirectMessage,
  type ZernioKeyGroup,
} from "@/lib/zernio";
import { unsignedWebhooksAllowed } from "@/lib/webhook-security";
import { logEvent } from "@/lib/log-event";

/**
 * Central Instagram/Facebook comment + DM auto-reply automation — this was
 * previously n8n-only (see supabase/add_social_reply_dedup_log.sql's own
 * comment describing that n8n workflow); moved in-app the same way the
 * Mailgun email flow was earlier in this project.
 *
 * One endpoint serves every client's account under a given Zernio API key
 * group (per Zernio's own webhook design — "account blocks with accountId
 * and profileId enabling one endpoint to serve many profiles"), so the
 * client is resolved per-event from `account.accountId` against
 * `social_connections`, never assumed or trusted from the payload itself.
 *
 * Dedup reuses the existing `social_reply_log` table/unique-constraint
 * (platform, event_type, external_id) — exactly the idempotency mechanism
 * that table's own migration comment describes needing, now actually wired
 * up to app code instead of n8n.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  const signature = req.headers.get("x-zernio-signature");

  // Fail-closed: an unset secret must reject, never silently skip verification.
  if (!unsignedWebhooksAllowed() && (!secret || !verifyZernioSignature(rawBody, signature, secret))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const eventType = body.event as string;
  if (eventType !== "comment.received" && eventType !== "message.received") {
    return NextResponse.json({ ok: true, ignored: eventType });
  }

  const accountId = body.account?.accountId as string | undefined;
  if (!accountId) {
    return NextResponse.json({ ok: true, ignored: "no accountId in payload" });
  }

  const admin = createAdminClient();

  // Resolve the owning client server-side from OUR OWN records — never from
  // anything the payload claims. An accountId that isn't ours (or belongs to
  // a disconnected/wrong client) simply matches nothing and is ignored.
  const { data: connection } = await admin
    .from("social_connections")
    .select("client_id, platform, zernio_account_id, connection_status")
    .eq("zernio_account_id", accountId)
    .eq("connection_status", "connected")
    .maybeSingle<{ client_id: string; platform: string; zernio_account_id: string; connection_status: string }>();

  if (!connection) {
    return NextResponse.json({ ok: true, matched_account: false });
  }

  if (connection.platform !== "instagram" && connection.platform !== "facebook") {
    return NextResponse.json({ ok: true, ignored: `unsupported platform ${connection.platform}` });
  }

  const keyGroup: ZernioKeyGroup = connection.platform === "instagram" ? "tiktok_instagram" : "google_meta";

  const { data: client } = await admin
    .from("clients")
    .select("company_name")
    .eq("id", connection.client_id)
    .maybeSingle();

  const isComment = eventType === "comment.received";
  const externalId: string | undefined = isComment
    ? (body.comment?.id as string | undefined) ?? (body.id as string | undefined)
    : (body.message?.id as string | undefined) ?? (body.id as string | undefined);
  const theirMessage: string = isComment ? body.comment?.text ?? "" : body.message?.text ?? "";

  if (!externalId || !theirMessage) {
    return NextResponse.json({ ok: true, ignored: "missing id/text in payload" });
  }

  // Respect the client's automation config. The wizard's toggles (DM/comment)
  // and the activate/pause switch only mean anything if the reply executor
  // actually honours them — without this, every connected account would keep
  // auto-replying forever, even before activation or after the client paused
  // automation (or switched a channel off).
  const { data: automation } = await admin
    .from("social_automation_settings")
    .select("automation_active, dm_enabled, comment_enabled")
    .eq("client_id", connection.client_id)
    .eq("platform", connection.platform)
    .maybeSingle<{ automation_active: boolean; dm_enabled: boolean; comment_enabled: boolean }>();

  if (!automation?.automation_active) {
    return NextResponse.json({ ok: true, ignored: "automation inactive" });
  }
  if (isComment ? !automation.comment_enabled : !automation.dm_enabled) {
    return NextResponse.json({ ok: true, ignored: `${isComment ? "comment" : "dm"} automation disabled` });
  }

  // Never reply to ourselves: our own reply arrives back as a comment event
  // authored by the connected account, which would otherwise loop forever.
  // Zernio flags the connected account's own messages with `isOwnAccount: true`.
  // The Facebook author id lives in a DIFFERENT id space than the Zernio
  // accountId, so comparing the two never matched — that is what let the page
  // keep replying to its own reply.
  const authorId = (body.comment?.author?.id ?? body.comment?.from?.id ?? body.message?.sender?.id ?? body.message?.from?.id) as string | undefined;
  const authorIsOwn =
    body.comment?.author?.isOwnAccount === true ||
    body.comment?.from?.isOwnAccount === true ||
    body.message?.sender?.isOwnAccount === true ||
    body.message?.from?.isOwnAccount === true;
  if (authorIsOwn || (authorId && authorId === accountId)) {
    return NextResponse.json({ ok: true, ignored: "authored by connected account" });
  }

  // Skip our own outbound messages echoed back as events. Zernio's direction
  // enum is "incoming" | "outgoing" — the old "outbound" spelling could never
  // match, so this guard never fired.
  if (!isComment && (body.message?.direction === "outgoing" || body.message?.direction === "outbound")) {
    return NextResponse.json({ ok: true, ignored: "outbound echo" });
  }

  // Idempotency: same event redelivered (Zernio guarantees at-least-once
  // delivery, explicitly documents duplicates on slow acks) must not
  // generate a second AI reply or a second post. The unique constraint on
  // (platform, event_type, external_id) makes the second insert fail, and
  // we bail out before ever calling Gemini or Zernio's send endpoints.
  const { error: dedupError } = await admin.from("social_reply_log").insert({
    platform: connection.platform,
    event_type: isComment ? "comment" : "dm",
    external_id: externalId,
    client_id: connection.client_id,
  });

  if (dedupError) {
    if (dedupError.code === "23505") {
      logEvent("social.event", { client_id: connection.client_id, platform: connection.platform, event_type: eventType, provider_event_id: externalId, result: "deduped" });
      return NextResponse.json({ ok: true, deduped: true });
    }
    return NextResponse.json({ error: dedupError.message }, { status: 500 });
  }

  // Fields recorded on every interaction, whatever the outcome.
  const conversationId = isComment ? undefined : (body.conversation?.id as string | undefined);
  const postId = isComment
    ? ((body.post?.platformPostId || body.post?.id || body.comment?.platformPostId || body.comment?.postId) as string | undefined)
    : undefined;
  const interactionBase = {
    client_id: connection.client_id,
    social_account_id: accountId,
    platform: connection.platform as "instagram" | "facebook",
    interaction_type: (isComment ? "comment" : "dm") as "comment" | "dm",
    external_id: externalId,
    conversation_id: conversationId,
    post_id: postId,
    commenter_id: authorId,
    message_text: theirMessage,
  };

  try {
    // Everything below is scoped by connection.client_id — the business that
    // OWNS the account this event arrived on (resolved from our own records
    // above), so retrieval, memory and post lookups can never cross tenants.
    const businessContext = await getClientBusinessContext(admin, connection.client_id);
    // eslint-disable-next-line no-console
    console.log(`[context] zernio ${describeContextForLog(businessContext)}`);

    const postContext = isComment
      ? await loadPostContext(admin, connection.client_id, [body.post?.id, body.post?.platformPostId, body.comment?.platformPostId, body.comment?.postId], body.post?.content ?? body.post?.text)
      : undefined;
    const conversation = isComment ? [] : await loadConversation(admin, connection.client_id, conversationId, externalId);

    const retrieved = retrieveBusinessContext(businessContext, {
      purpose: isComment ? "comment" : "dm",
      query: [theirMessage, postContext, conversation.map((m) => m.text).join(" ")].filter(Boolean).join(" "),
    });

    let draft: Awaited<ReturnType<typeof generateGroundedReply>>;
    try {
      draft = await generateGroundedReply({
        businessContext: retrieved.text,
        senderCompany: client?.company_name ?? "us",
        platform: connection.platform,
        messageType: isComment ? "comment" : "dm",
        theirMessage,
        postContext,
        conversation,
      });
    } catch (aiErr) {
      // The AI step failed BEFORE anything was sent: release the dedupe row and ask
      // Zernio to redeliver (at-least-once), instead of silently losing the event.
      await admin
        .from("social_reply_log")
        .delete()
        .eq("platform", connection.platform)
        .eq("event_type", isComment ? "comment" : "dm")
        .eq("external_id", externalId);
      logEvent("social.event", { client_id: connection.client_id, platform: connection.platform, event_type: eventType, provider_event_id: externalId, result: "ai_failed_will_retry", error: (aiErr as Error).message });
      return NextResponse.json({ error: "temporarily unable to process, retry" }, { status: 503 });
    }

    const decision = decideReply(draft, theirMessage, businessContext, isComment ? "comment" : "dm");
    const record = {
      ...interactionBase,
      detected_intent: decision.intent,
      requires_human: decision.requiresHuman,
      handoff_reason: decision.handoffReason || undefined,
      retrieved_context: retrieved.reference,
    };

    // A failed send must still keep what we classified and drafted, not just the inbound message.
    const sendOrRecord = async (send: () => Promise<unknown>) => {
      try {
        await send();
      } catch (sendErr) {
        await recordInteraction(admin, { ...record, ai_response: decision.text, response_status: "send_failed" });
        throw sendErr;
      }
    };

    if (decision.action !== "send") {
      // Held for a human (or nothing to say): nothing is sent, but the event is
      // stored and marked so the team can pick it up.
      // eslint-disable-next-line no-console
      console.log(`Zernio ${eventType} ${decision.status} (client ${connection.client_id}): ${decision.handoffReason || decision.intent}`);
      await recordInteraction(admin, { ...record, ai_response: decision.text || undefined, response_status: decision.status });
      if (decision.requiresHuman) {
        await admin
          .from("social_reply_log")
          .update({ status: "handoff", needs_handoff: true })
          .eq("platform", connection.platform)
          .eq("event_type", isComment ? "comment" : "dm")
          .eq("external_id", externalId);
      }
      logEvent("social.event", { client_id: connection.client_id, platform: connection.platform, event_type: eventType, provider_event_id: externalId, result: decision.status });
      return NextResponse.json({ ok: true, flagged: decision.requiresHuman, reason: decision.handoffReason, intent: decision.intent });
    }

    if (isComment) {
      // Zernio's comment.received payload puts the real post id in
      // post.platformPostId (and comment.platformPostId); post.id is an empty
      // string for third-party (Facebook/Instagram) posts. Read the platform
      // id first, then fall back to a Zernio post id if one is ever present.
      if (!postId) {
        await recordInteraction(admin, { ...record, ai_response: decision.text, response_status: "send_failed" });
        return NextResponse.json({ ok: true, ignored: "no post id for comment reply" });
      }
      await sendOrRecord(() => replyToComment(keyGroup, accountId, postId, externalId, decision.text));
    } else {
      if (!conversationId) {
        await recordInteraction(admin, { ...record, ai_response: decision.text, response_status: "send_failed" });
        return NextResponse.json({ ok: true, ignored: "no conversation id for DM reply" });
      }
      await sendOrRecord(() => sendDirectMessage(keyGroup, accountId, conversationId, decision.text));
    }

    await admin
      .from("social_reply_log")
      .update({
        reply_text: decision.text,
        ...(decision.requiresHuman ? { status: "handoff", needs_handoff: true } : {}),
      })
      .eq("platform", connection.platform)
      .eq("event_type", isComment ? "comment" : "dm")
      .eq("external_id", externalId);
    await recordInteraction(admin, { ...record, ai_response: decision.text, response_status: "sent" });

    logEvent("social.event", { client_id: connection.client_id, platform: connection.platform, event_type: eventType, provider_event_id: externalId, result: "replied" });
    return NextResponse.json({ ok: true, replied: true, intent: decision.intent, requires_human: decision.requiresHuman });
  } catch (err) {
    // The dedup row is already committed — never let a send failure here
    // cause Zernio to retry-deliver into a guaranteed no-op (same principle
    // as the Mailgun inbound webhook).
    // (send failures were already recorded in full by sendOrRecord; this only covers earlier failures)
    await admin.from("social_interactions").upsert({ ...interactionBase, response_status: "send_failed" }, { onConflict: "client_id,platform,interaction_type,external_id", ignoreDuplicates: true });
    logEvent("social.event", { client_id: connection.client_id, platform: connection.platform, event_type: eventType, provider_event_id: externalId, result: "reply_failed", error: (err as Error).message });
    return NextResponse.json({ ok: true, error: (err as Error).message });
  }
}
