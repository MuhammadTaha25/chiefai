import type { CompanyFacts } from "@/lib/company-facts";

/**
 * The spoken daily report.
 *
 * Shared by the agent's data tool (/api/voice/facts) and our own TwiML voice
 * app (/api/voice/twiml) so a caller hears exactly the same numbers whichever
 * way the call is handled.
 *
 * It is assembled from the figures rather than generated, on purpose: a report
 * can then never state a number the database does not contain. Where a figure
 * is genuinely unknown (ad spend before anything has been synced), it says so
 * out loud instead of guessing.
 */
export function thousands(n: number): string {
  return n.toLocaleString("en-US");
}

export function spokenSummary(business: string, f: CompanyFacts): string {
  const parts: string[] = [];
  parts.push(`Here is the report for ${business}.`);
  parts.push(`${f.leads.today} new leads today, ${thousands(f.leads.total)} in total.`);
  parts.push(
    `${thousands(f.outreach.emails_sent_total)} emails sent, ${f.leads.replied} leads have replied, ${f.leads.positive_replies} of those positive.`
  );
  parts.push(`${f.deals.closed} deals closed${f.deals.won_revenue ? `, worth ${thousands(f.deals.won_revenue)}` : ""}.`);
  parts.push(`${f.bookings.upcoming} appointments upcoming.`);

  // --- today, in the owner's own timezone -----------------------------------
  const b = f.brief;
  const clock = (iso: string | null) =>
    iso ? new Date(iso).toLocaleTimeString("en-US", { timeZone: b.timezone, hour: "numeric", minute: "2-digit" }) : "no time recorded";
  parts.push(`Today: ${b.emails_sent_today} outreach emails sent.`);
  const active = b.mailboxes.filter((m) => m.sent_today > 0);
  if (active.length) {
    parts.push(`By mailbox: ${active.map((m) => `${m.address} sent ${m.sent_today}${m.daily_limit ? ` of ${m.daily_limit}` : ""}`).join("; ")}.`);
  } else if (b.mailboxes.length) {
    parts.push(`None of your ${b.mailboxes.length} mailboxes has sent anything today.`);
  }
  if (b.posts_published_today > 0) {
    parts.push(
      `${b.posts_published_today} social ${b.posts_published_today === 1 ? "post was" : "posts were"} published today: ` +
        b.posts_today.map((p) => `"${p.title}" on ${p.platform} at ${clock(p.at)}`).join("; ") + "."
    );
  } else {
    parts.push("No social post has gone out today.");
  }
  if (b.posts_scheduled_next.length) {
    const n = b.posts_scheduled_next[0];
    parts.push(`Next scheduled post: "${n.title}" on ${n.platform} at ${clock(n.at)}.`);
  }
  if (b.domains.length) {
    parts.push(
      b.domains_bought_today > 0
        ? `${b.domains_bought_today} new domain${b.domains_bought_today === 1 ? "" : "s"} bought today; ${b.domains.length} in total.`
        : `${b.domains.length} sending domain${b.domains.length === 1 ? "" : "s"}, none bought today.`
    );
  } else {
    parts.push("No sending domain has been bought yet.");
  }

  if (f.social.posts_total > 0) {
    parts.push(`Overall, ${f.social.posts_published} social posts published, ${f.social.posts_draft} waiting as drafts.`);
  }

  if (f.ad_spend.actual_spend !== null) {
    parts.push(
      `Ad spend so far is ${thousands(f.ad_spend.actual_spend)}${f.ad_spend.ad_leads ? `, bringing ${f.ad_spend.ad_leads} leads at about ${f.ad_spend.cost_per_lead} each` : ""}.`
    );
    if (f.ad_spend.roi !== null) {
      parts.push(
        `Return on ad spend is about ${f.ad_spend.roi} times, measured as company revenue over ad spend — not revenue we can prove came from the ads.`
      );
    }
  } else if (f.ad_spend.daily_budget_total > 0) {
    parts.push(
      `Ad campaigns have a planned budget of ${f.ad_spend.daily_budget_total} per day, but no performance has ever been recorded, so I do not have the actual spend or return on ad spend. I will not guess those.`
    );
  } else {
    parts.push("No ad campaigns are running.");
  }
  return parts.join(" ");
}

/** TwiML/XML escaping — every value we speak may contain a client's own text. */
export function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
