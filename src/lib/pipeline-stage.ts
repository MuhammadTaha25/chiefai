/**
 * Where a contacted lead sits on the sales pipeline, derived ONLY from what actually happened (email sent, reply
 * received and how it was classified, booking, bounce, unsubscribe). Nothing is dragged or guessed, so the board
 * always matches the outreach data. Leads never emailed are not on the pipeline.
 */
export type PipelineStageId = "sent" | "negotiation" | "won" | "lost";

export interface PipelineLeadInput {
  status?: string | null;
  follow_up_number?: number | null;
  last_contact_at?: string | null;
  reply_received?: boolean | null;
  reply_classification?: string | null;
  booked?: boolean | null;
  unsubscribed?: boolean | null;
  email_bounced?: boolean | null;
  complained?: boolean | null;
  manually_stopped?: boolean | null;
}

export function stageForLead(l: PipelineLeadInput): { stage: PipelineStageId; detail: string } | null {
  // A booked meeting is a win, even if the contact later opts out of further email.
  if (l.booked || l.status === "booked") return { stage: "won", detail: "Meeting booked" };

  if (l.email_bounced) return { stage: "lost", detail: "Email bounced" };
  if (l.complained) return { stage: "lost", detail: "Marked as spam" };
  if (l.unsubscribed) return { stage: "lost", detail: "Unsubscribed" };
  if (l.reply_classification === "ANGRY") return { stage: "lost", detail: "Replied: not interested" };
  if (l.manually_stopped) return { stage: "lost", detail: "Stopped manually" };

  if (l.reply_received) {
    const detail =
      l.reply_classification === "BOOKING"
        ? "Replied: wants to book"
        : l.reply_classification === "HAPPY"
          ? "Replied: interested"
          : "Replied";
    return { stage: "negotiation", detail };
  }

  const contacted = Boolean(l.last_contact_at) || (l.follow_up_number ?? 0) >= 1 || /^(email_sent|follow_up_\d+)$/.test(l.status ?? "");
  if (contacted) {
    const n = l.follow_up_number ?? 1;
    return { stage: "sent", detail: n > 1 ? `Follow-up ${n - 1} sent` : "First email sent" };
  }
  return null;
}
